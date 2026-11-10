import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@quaymaster/shared';
import type { AuthContext, AuthService, RevocationEvent } from '../auth/service.js';
import { AppError } from '../util/errors.js';

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export interface SseLimits {
  maxPerSession: number;
  maxTotal: number;
  maxBufferBytes: number;
  heartbeatMs: number;
  revalidateMs: number;
}

export const DEFAULT_SSE_LIMITS = { maxBufferBytes: 1024 * 1024, heartbeatMs: 15_000, revalidateMs: 60_000 };

export interface SseConnection {
  readonly id: string;
  send(event: string, data: unknown): boolean;
  close(reason: string): void;
  onClose(fn: () => void): void;
}

interface Entry {
  conn: Conn;
  sessionIdHash: string;
  userId: number;
  role: Role;
}

class Conn implements SseConnection {
  readonly id = randomUUID();
  private closed = false;
  private readonly closers: (() => void)[] = [];
  private heartbeat: NodeJS.Timeout;
  private revalidate: NodeJS.Timeout;
  private expiry: NodeJS.Timeout;

  constructor(
    private readonly reply: FastifyReply,
    private readonly hub: SseHub,
    private readonly ctx: AuthContext,
    private readonly limits: SseLimits,
    private readonly auth: AuthService,
    absoluteMs: number,
  ) {
    const raw = reply.raw;
    raw.on('close', () => this.finish());
    raw.on('error', () => this.finish());
    this.heartbeat = setInterval(() => this.write(': ping\n\n'), limits.heartbeatMs);
    this.revalidate = setInterval(() => {
      if (!this.auth.stillValid(this.ctx.session.id_hash, this.ctx.user.role as Role))
        this.close('session ended');
    }, limits.revalidateMs);
    // absolute lifetime never exceeds the session's own absolute timeout
    this.expiry = setTimeout(() => this.close('session expired'), Math.max(1000, absoluteMs));
    for (const t of [this.heartbeat, this.revalidate, this.expiry]) t.unref();
  }

  private write(chunk: string): boolean {
    if (this.closed) return false;
    const raw = this.reply.raw;
    const ok = raw.write(chunk);
    // back-pressure: a slow client must not make us buffer without bound
    if (!ok && raw.writableLength > this.limits.maxBufferBytes) {
      this.close('client too slow; reconnect');
      return false;
    }
    return true;
  }

  send(event: string, data: unknown): boolean {
    return this.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  close(reason: string): void {
    if (this.closed) return;
    try {
      this.reply.raw.write(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
      this.reply.raw.end();
    } catch {
      /* socket already gone */
    }
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    clearInterval(this.revalidate);
    clearTimeout(this.expiry);
    this.hub.remove(this.id);
    for (const f of this.closers) {
      try {
        f();
      } catch {
        /* ignore */
      }
    }
  }

  onClose(fn: () => void): void {
    if (this.closed) fn();
    else this.closers.push(fn);
  }
}

/**
 * Registry of live SSE streams (RT-15). Every stream belongs to a session: logout, expiry,
 * password or role change close it; it re-validates every 60 s, is capped per session and in
 * total, and is dropped when the client cannot keep up.
 */
export class SseHub extends EventEmitter {
  private readonly streams = new Map<string, Entry>();

  constructor(
    private readonly auth: AuthService,
    private readonly limits: SseLimits,
    private readonly securityHeaders: Record<string, string> = SECURITY_HEADERS,
  ) {
    super();
    auth.onRevoked((e) => this.revoke(e));
  }

  get count(): number {
    return this.streams.size;
  }

  private revoke(e: RevocationEvent): void {
    for (const entry of [...this.streams.values()]) {
      const bySession = e.sessionIdHashes?.includes(entry.sessionIdHash);
      const byUser = e.userId !== undefined && entry.userId === e.userId;
      const sweep = e.sessionIdHashes === undefined && e.userId === undefined;
      if (bySession || byUser) entry.conn.close('session revoked');
      else if (sweep && !this.auth.stillValid(entry.sessionIdHash, entry.role)) {
        entry.conn.close('session expired');
      }
    }
  }

  remove(id: string): void {
    this.streams.delete(id);
  }

  open(_req: FastifyRequest, reply: FastifyReply, ctx: AuthContext): SseConnection {
    const perSession = [...this.streams.values()].filter(
      (s) => s.sessionIdHash === ctx.session.id_hash,
    ).length;
    if (perSession >= this.limits.maxPerSession) {
      throw new AppError(
        429,
        'rate_limited',
        `At most ${this.limits.maxPerSession} live streams per session`,
      );
    }
    if (this.streams.size >= this.limits.maxTotal) {
      throw new AppError(429, 'rate_limited', 'Too many live streams on this server');
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      ...this.securityHeaders,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    const remaining = ctx.session.expires_at - Date.now();
    const conn = new Conn(reply, this, ctx, this.limits, this.auth, remaining);
    this.streams.set(conn.id, {
      conn,
      sessionIdHash: ctx.session.id_hash,
      userId: ctx.user.id,
      role: ctx.user.role,
    });
    return conn;
  }

  closeAll(reason: string): void {
    for (const e of [...this.streams.values()]) e.conn.close(reason);
  }
}
