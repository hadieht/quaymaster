import { AppError } from '../util/errors.js';
import type { Clock } from '../audit/audit.js';

export interface LimiterOptions {
  /** Attempts allowed per client IP inside `ipWindowMs` (checked before any hashing). */
  ipMaxAttempts: number;
  ipWindowMs: number;
  /** Consecutive failures for one (account, ip) pair before a hard lock. */
  pairLockAfter: number;
  pairLockBaseMs: number;
  pairLockMaxMs: number;
  /** Progressive per-account delay applied to FAILED responses only (never blocks a correct login). */
  accountDelayAfter: number;
  accountDelayMaxMs: number;
  accountDecayMs: number;
  maxEntries: number;
}

export const DEFAULT_LIMITS: LimiterOptions = {
  ipMaxAttempts: 20,
  ipWindowMs: 5 * 60_000,
  pairLockAfter: 5,
  pairLockBaseMs: 30_000,
  pairLockMaxMs: 15 * 60_000,
  accountDelayAfter: 2,
  accountDelayMaxMs: 30_000,
  accountDecayMs: 15 * 60_000,
  maxEntries: 10_000,
};

interface PairState {
  fails: number;
  lockedUntil: number;
  last: number;
}
interface AccountState {
  fails: number;
  last: number;
}

/**
 * Login throttling (spec 5, RT-17).
 *
 * - per IP: a sliding-window budget evaluated BEFORE the expensive password hash
 * - per (account, ip): hard lock with exponential back-off
 * - per account: only a capped, progressive delay on failed responses — a remote attacker can slow
 *   guesses but can never lock the real admin out
 */
export class LoginLimiter {
  private readonly ips = new Map<string, number[]>();
  private readonly pairs = new Map<string, PairState>();
  private readonly accounts = new Map<string, AccountState>();

  constructor(
    private readonly clock: Clock = Date.now,
    private readonly opts: LimiterOptions = DEFAULT_LIMITS,
  ) {}

  private evict<K, V>(m: Map<K, V>): void {
    while (m.size > this.opts.maxEntries) {
      const first = m.keys().next();
      if (first.done) break;
      m.delete(first.value);
    }
  }

  /** Throws 429 when the caller must not even be allowed to try. Records the attempt for the IP budget. */
  beforeAttempt(account: string, ip: string): void {
    const now = this.clock();
    const hits = (this.ips.get(ip) ?? []).filter((t) => t > now - this.opts.ipWindowMs);
    if (hits.length >= this.opts.ipMaxAttempts) {
      const retry = Math.ceil(((hits[0] ?? now) + this.opts.ipWindowMs - now) / 1000);
      throw new AppError(429, 'rate_limited', 'Too many attempts from this address', undefined, {
        'Retry-After': String(Math.max(1, retry)),
      });
    }
    hits.push(now);
    this.ips.set(ip, hits);
    this.evict(this.ips);
    const pair = this.pairs.get(pairKey(account, ip));
    if (pair && pair.lockedUntil > now) {
      const retry = Math.ceil((pair.lockedUntil - now) / 1000);
      throw new AppError(429, 'rate_limited', 'Too many failed attempts; try again later', undefined, {
        'Retry-After': String(retry),
      });
    }
  }

  /** Records a failure and returns the delay (ms) to apply before answering. */
  onFailure(account: string, ip: string): number {
    const now = this.clock();
    const pk = pairKey(account, ip);
    const pair = this.pairs.get(pk) ?? { fails: 0, lockedUntil: 0, last: now };
    pair.fails += 1;
    pair.last = now;
    if (pair.fails >= this.opts.pairLockAfter) {
      const exp = pair.fails - this.opts.pairLockAfter;
      pair.lockedUntil = now + Math.min(this.opts.pairLockMaxMs, this.opts.pairLockBaseMs * 2 ** exp);
    }
    this.pairs.set(pk, pair);
    this.evict(this.pairs);

    const ak = account.toLowerCase();
    let acc = this.accounts.get(ak);
    if (!acc || now - acc.last > this.opts.accountDecayMs) acc = { fails: 0, last: now };
    acc.fails += 1;
    acc.last = now;
    this.accounts.set(ak, acc);
    this.evict(this.accounts);
    if (acc.fails <= this.opts.accountDelayAfter) return 0;
    return Math.min(this.opts.accountDelayMaxMs, 500 * 2 ** (acc.fails - this.opts.accountDelayAfter - 1));
  }

  onSuccess(account: string, ip: string): void {
    this.pairs.delete(pairKey(account, ip));
    this.accounts.delete(account.toLowerCase());
  }
}

function pairKey(account: string, ip: string): string {
  return `${account.toLowerCase()}\u0000${ip}`;
}

/** Fixed attempts-per-IP budget, used for the setup token (5 attempts per IP). */
export class AttemptBudget {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly clock: Clock = Date.now,
  ) {}

  take(key: string): void {
    const now = this.clock();
    const h = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (h.length >= this.max) {
      throw new AppError(429, 'rate_limited', 'Too many attempts', undefined, {
        'Retry-After': String(Math.ceil(this.windowMs / 1000)),
      });
    }
    h.push(now);
    this.hits.set(key, h);
    if (this.hits.size > 10_000) this.hits.delete(this.hits.keys().next().value as string);
  }
}
