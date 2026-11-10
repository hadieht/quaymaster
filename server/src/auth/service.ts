import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Role, SessionInfo, UserInfo } from '@quaymaster/shared';
import type { Config } from '../config/env.js';
import { PasswordService } from '../crypto/password.js';
import type { SessionRow, SessionsRepo } from '../db/sessions.js';
import type { UserRow, UsersRepo } from '../db/users.js';
import type { AuditService, Clock } from '../audit/audit.js';
import { sha256Hex } from '../crypto/secretbox.js';
import { AppError, conflict, notFound, unauthorized } from '../util/errors.js';
import type { LoginLimiter } from './limiter.js';

export interface AuthContext {
  user: UserRow;
  session: SessionRow;
}

export type Permission = 'read' | 'write' | 'logs';

export interface RevocationEvent {
  /** Specific sessions closed (by id hash). */
  sessionIdHashes?: string[];
  /** Everything belonging to this user (role change, deletion, disable). */
  userId?: number;
}

export const hashSessionToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function toUserInfo(u: UserRow): UserInfo {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    logsRead: u.role === 'admin' || u.logs_read === 1,
    disabled: u.disabled === 1,
    createdAt: new Date(u.created_at).toISOString(),
  };
}

export interface AuthDeps {
  users: UsersRepo;
  sessions: SessionsRepo;
  passwords: PasswordService;
  limiter: LoginLimiter;
  audit: AuditService;
  config: Pick<Config, 'session'>;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
}

const TOUCH_INTERVAL_MS = 30_000;
const USERNAME_RE = /^[A-Za-z0-9._@-]{1,64}$/;

export class AuthService {
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly listeners: ((e: RevocationEvent) => void)[] = [];

  constructor(private readonly d: AuthDeps) {
    this.clock = d.clock ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  onRevoked(fn: (e: RevocationEvent) => void): void {
    this.listeners.push(fn);
  }
  private emit(e: RevocationEvent): void {
    for (const l of this.listeners) l(e);
  }

  static validateUsername(username: string): void {
    if (!USERNAME_RE.test(username)) {
      throw new AppError(400, 'validation', 'Username must be 1-64 characters: letters, digits, . _ @ -');
    }
  }

  // ---- sessions ---------------------------------------------------------------------------

  /** Creates a brand-new session (new random ID every time: rotation on login). */
  createSession(
    user: UserRow,
    ip: string | null,
    userAgent: string | null,
  ): { token: string; ctx: AuthContext } {
    const token = randomBytes(32).toString('base64url');
    const now = this.clock();
    const row: SessionRow = {
      id_hash: hashSessionToken(token),
      user_id: user.id,
      csrf_secret: randomBytes(32).toString('hex'),
      created_at: now,
      last_seen: now,
      expires_at: now + this.d.config.session.absoluteMs,
      ip,
      user_agent: userAgent?.slice(0, 200) ?? null,
    };
    this.d.sessions.insert(row);
    return { token, ctx: { user, session: row } };
  }

  authenticate(token: string | undefined): AuthContext | null {
    if (!token || token.length > 128) return null;
    const idHash = hashSessionToken(token);
    const session = this.d.sessions.get(idHash);
    if (!session) return null;
    const now = this.clock();
    if (now >= session.expires_at || now - session.last_seen >= this.d.config.session.idleMs) {
      this.d.sessions.delete(idHash);
      this.emit({ sessionIdHashes: [idHash] });
      return null;
    }
    const user = this.d.users.byId(session.user_id);
    if (!user || user.disabled === 1) return null;
    if (now - session.last_seen > TOUCH_INTERVAL_MS) {
      this.d.sessions.touch(idHash, now);
      session.last_seen = now;
    }
    return { user, session };
  }

  /** Re-validation used by long-lived streams; does not extend the idle timer. */
  stillValid(idHash: string, expectedRole: Role): boolean {
    const s = this.d.sessions.get(idHash);
    if (!s || this.clock() >= s.expires_at) return false;
    const u = this.d.users.byId(s.user_id);
    return !!u && u.disabled === 0 && u.role === expectedRole;
  }

  csrfToken(ctx: AuthContext): string {
    return createHmac('sha256', ctx.session.csrf_secret).update(ctx.session.id_hash).digest('hex');
  }

  verifyCsrf(ctx: AuthContext, provided: string | undefined): boolean {
    if (!provided) return false;
    const expected = Buffer.from(this.csrfToken(ctx));
    const got = Buffer.from(provided);
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  sessionInfo(ctx: AuthContext): SessionInfo {
    return {
      user: toUserInfo(ctx.user),
      csrfToken: this.csrfToken(ctx),
      expiresAt: new Date(ctx.session.expires_at).toISOString(),
      idleExpiresAt: new Date(
        Math.min(ctx.session.expires_at, ctx.session.last_seen + this.d.config.session.idleMs),
      ).toISOString(),
    };
  }

  can(ctx: AuthContext, perm: Permission): boolean {
    if (ctx.user.role === 'admin') return true;
    if (perm === 'read') return true;
    if (perm === 'logs') return ctx.user.logs_read === 1;
    return false;
  }

  logout(ctx: AuthContext): void {
    this.d.sessions.delete(ctx.session.id_hash);
    this.emit({ sessionIdHashes: [ctx.session.id_hash] });
  }

  logoutAll(userId: number): void {
    this.d.sessions.deleteForUser(userId);
    this.emit({ userId });
  }

  purgeExpired(): void {
    const n = this.d.sessions.deleteExpired(this.clock(), this.d.config.session.idleMs);
    if (n > 0) this.emit({});
  }

  // ---- login ------------------------------------------------------------------------------

  async login(input: {
    username: string;
    password: string;
    ip: string;
    userAgent: string | null;
  }): Promise<{ token: string; ctx: AuthContext }> {
    const { username, password, ip } = input;
    // 1. throttle BEFORE hashing
    try {
      this.d.limiter.beforeAttempt(username, ip);
    } catch (e) {
      this.auditLogin(username, ip, 'denied', 'rate limited');
      throw e;
    }
    const user = this.d.users.byUsername(username);
    let ok = false;
    if (user && user.disabled === 0) ok = await this.d.passwords.verify(password, user.password_hash);
    else await this.d.passwords.dummyVerify(password);
    if (!ok || !user) {
      const delay = this.d.limiter.onFailure(username, ip);
      this.auditLogin(username, ip, 'failure', 'invalid credentials');
      if (delay > 0) await this.sleep(delay);
      throw unauthorized('Invalid username or password');
    }
    this.d.limiter.onSuccess(username, ip);
    const created = this.createSession(user, ip, input.userAgent);
    this.d.audit.record({ actor: user.username, ip, action: 'auth.login', outcome: 'success' });
    return created;
  }

  /** RT-36: never store the raw username of a failed login (people type passwords there). */
  private auditLogin(username: string, ip: string, outcome: 'failure' | 'denied', why: string): void {
    const known = this.d.users.byUsername(username);
    this.d.audit.record({
      actor: known ? known.username : `unknown:${sha256Hex(username.toLowerCase()).slice(0, 12)}`,
      ip,
      action: 'auth.login',
      outcome,
      params: { reason: why },
    });
  }

  // ---- users ------------------------------------------------------------------------------

  async createUser(input: {
    username: string;
    password: string;
    role: Role;
    logsRead?: boolean;
  }): Promise<UserRow> {
    AuthService.validateUsername(input.username);
    PasswordService.validateStrength(input.password);
    if (this.d.users.byUsername(input.username)) throw conflict('conflict', 'Username already exists');
    const hash = await this.d.passwords.hash(input.password);
    return this.d.users.create({
      username: input.username,
      passwordHash: hash,
      role: input.role,
      logsRead: input.logsRead,
    });
  }

  /** Used for the first admin (setup / env provisioning) with an already-computed hash. */
  createUserWithHash(username: string, passwordHash: string, role: Role): UserRow {
    AuthService.validateUsername(username);
    return this.d.users.create({ username, passwordHash, role });
  }

  updateUser(id: number, patch: { role?: Role; logsRead?: boolean; disabled?: boolean }): UserRow {
    const u = this.d.users.byId(id);
    if (!u) throw notFound('User');
    const losesAdmin =
      u.role === 'admin' && u.disabled === 0 && (patch.role === 'viewer' || patch.disabled === true);
    if (losesAdmin && this.d.users.countActiveAdmins() <= 1) {
      throw conflict('conflict', 'Cannot demote or disable the last active admin');
    }
    this.d.users.update(id, patch);
    if (patch.role !== undefined || patch.disabled !== undefined || patch.logsRead !== undefined) {
      // privilege change: all sessions of the user are revoked (and their streams closed)
      this.d.sessions.deleteForUser(id);
      this.emit({ userId: id });
    }
    return this.d.users.byId(id) as UserRow;
  }

  deleteUser(id: number): void {
    const u = this.d.users.byId(id);
    if (!u) throw notFound('User');
    if (u.role === 'admin' && u.disabled === 0 && this.d.users.countActiveAdmins() <= 1) {
      throw conflict('conflict', 'Cannot delete the last active admin');
    }
    this.d.users.delete(id);
    this.emit({ userId: id });
  }

  async changePassword(ctx: AuthContext, current: string, next: string): Promise<void> {
    PasswordService.validateStrength(next);
    if (!(await this.d.passwords.verify(current, ctx.user.password_hash))) {
      throw new AppError(403, 'forbidden', 'Current password is incorrect');
    }
    this.d.users.setPasswordHash(ctx.user.id, await this.d.passwords.hash(next));
    const gone = this.d.sessions.deleteForUser(ctx.user.id, ctx.session.id_hash);
    if (gone.length) this.emit({ sessionIdHashes: gone });
  }

  async adminSetPassword(id: number, next: string): Promise<void> {
    PasswordService.validateStrength(next);
    if (!this.d.users.byId(id)) throw notFound('User');
    this.d.users.setPasswordHash(id, await this.d.passwords.hash(next));
    this.d.sessions.deleteForUser(id);
    this.emit({ userId: id });
  }
}
