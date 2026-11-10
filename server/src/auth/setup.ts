import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/env.js';
import { PasswordService, parseHash, safeEqual } from '../crypto/password.js';
import type { UsersRepo } from '../db/users.js';
import { AppError, conflict } from '../util/errors.js';
import type { AuthService } from './service.js';
import { AttemptBudget } from './limiter.js';
import type { Clock } from '../audit/audit.js';

export const SETUP_TOKEN_TTL_MS = 60 * 60_000;

/**
 * First-run lifecycle (RT-19).
 *
 * - If an admin is configured through the environment and the users table is empty, that admin is
 *   created (once). A password changed in the UI is never reverted by a restart.
 * - Otherwise a one-time setup token is printed to stderr (outside pino, so redaction cannot mask
 *   it), written to `<data>/setup-token` (0600), valid 60 minutes, 5 attempts per IP, and deleted
 *   on success. A new token is generated on every start and after expiry.
 */
export class SetupService {
  private token: string | null = null;
  private issuedAt = 0;
  private readonly budget: AttemptBudget;
  private readonly file: string;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly d: {
      users: UsersRepo;
      auth: AuthService;
      passwords: PasswordService;
      config: Pick<Config, 'dataDir' | 'admin'>;
      clock?: Clock;
      announce?: (line: string) => void;
    },
  ) {
    const clock = d.clock ?? Date.now;
    this.budget = new AttemptBudget(5, SETUP_TOKEN_TTL_MS, clock);
    this.file = path.join(d.config.dataDir, 'setup-token');
  }

  private now(): number {
    return (this.d.clock ?? Date.now)();
  }

  required(): boolean {
    return this.d.users.count() === 0;
  }

  /** Called at startup. Returns what happened, for logging. */
  async init(): Promise<'env-admin-created' | 'setup-token-issued' | 'already-initialised'> {
    if (!this.required()) {
      this.removeFile();
      return 'already-initialised';
    }
    const admin = this.d.config.admin;
    if (admin) {
      let hash: string;
      if (admin.passwordHash) {
        if (!parseHash(admin.passwordHash)) {
          throw new Error(
            'QM_ADMIN_PASSWORD_HASH is not a valid hash (expected scrypt$N$r$p$saltBase64$hashBase64)',
          );
        }
        hash = admin.passwordHash;
      } else {
        const pw = readFileSync(admin.passwordFile as string, 'utf8').replace(/\r?\n$/, '');
        PasswordService.validateStrength(pw);
        hash = await this.d.passwords.hash(pw);
      }
      this.d.auth.createUserWithHash(admin.user, hash, 'admin');
      return 'env-admin-created';
    }
    this.issue();
    return 'setup-token-issued';
  }

  private issue(): void {
    this.token = randomBytes(24).toString('base64url');
    this.issuedAt = this.now();
    writeFileSync(this.file, this.token + '\n', { mode: 0o600 });
    chmodSync(this.file, 0o600);
    const line =
      `\n=== Quaymaster first-run setup ===\n` +
      `One-time setup token (valid 60 minutes): ${this.token}\n` +
      `Also written to ${this.file}. Open the setup page and enter it together with your new admin credentials.\n\n`;
    (this.d.announce ?? ((l) => process.stderr.write(l)))(line);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.required()) this.issue();
    }, SETUP_TOKEN_TTL_MS + 1000);
    this.timer.unref();
  }

  private removeFile(): void {
    if (existsSync(this.file)) unlinkSync(this.file);
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  /** Completes first-run setup; consumes the token. */
  async complete(input: { token: string; username: string; password: string; ip: string }) {
    if (!this.required()) throw conflict('conflict', 'Setup has already been completed');
    this.budget.take(input.ip);
    if (!this.token || this.now() - this.issuedAt > SETUP_TOKEN_TTL_MS) {
      throw new AppError(403, 'forbidden', 'Setup token expired; restart Quaymaster to issue a new one');
    }
    if (!safeEqual(input.token, this.token)) throw new AppError(403, 'forbidden', 'Invalid setup token');
    const user = await this.d.auth.createUser({
      username: input.username,
      password: input.password,
      role: 'admin',
    });
    this.token = null;
    this.removeFile();
    clearTimeout(this.timer);
    return user;
  }
}
