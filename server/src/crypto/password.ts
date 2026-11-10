import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { AppError } from '../util/errors.js';

const MAXMEM = 256 * 1024 * 1024;
const R = 8;
const P = 1;
const KEYLEN = 64;

/**
 * Bounded concurrency for expensive hashes (RT-16): one hash at a time, a short queue, then 429.
 * libuv's pool would otherwise run four 128 MiB scrypts in parallel on a 2-core host.
 */
export class HashGate {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(
    private readonly concurrency = 1,
    private readonly maxQueue = 8,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.waiters.length >= this.maxQueue) {
        throw new AppError(
          429,
          'rate_limited',
          'Too many concurrent login attempts, try again shortly',
          undefined,
          {
            'Retry-After': '5',
          },
        );
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export const MIN_PASSWORD_LENGTH = 12;

export interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

/** Format: `scrypt$N$r$p$saltB64$hashB64` — parameters travel with the hash so they can change later. */
export function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![n, r, p].every(Number.isInteger) || n < 1024 || (n & (n - 1)) !== 0 || n > 2 ** 20) return null;
  if (r < 1 || r > 32 || p < 1 || p > 16) return null;
  if (128 * n * r > MAXMEM) return null; // refuse to run a hash that cannot fit the memory cap
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const hash = Buffer.from(parts[5] ?? '', 'base64');
  if (salt.length < 8 || hash.length !== KEYLEN) return null;
  return { n, r, p, salt, hash };
}

export class PasswordService {
  constructor(
    private readonly log2n: number,
    private readonly gate = new HashGate(),
  ) {}

  static validateStrength(password: string): void {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new AppError(
        400,
        'validation',
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`,
      );
    }
    if (password.length > 1024) throw new AppError(400, 'validation', 'Password is too long');
  }

  async hash(password: string): Promise<string> {
    const n = 2 ** this.log2n;
    const salt = randomBytes(16);
    const key = await this.gate.run(() => scryptAsync(password, salt, n, R, P));
    return ['scrypt', n, R, P, salt.toString('base64'), key.toString('base64')].join('$');
  }

  /** Constant-time verification. Malformed stored hashes verify as false. */
  async verify(password: string, stored: string): Promise<boolean> {
    const parsed = parseHash(stored);
    if (!parsed) return false;
    const key = await this.gate.run(() => scryptAsync(password, parsed.salt, parsed.n, parsed.r, parsed.p));
    return timingSafeEqual(key, parsed.hash);
  }

  /** Spend comparable time for unknown users so response time does not reveal which accounts exist. */
  async dummyVerify(password: string): Promise<void> {
    const salt = Buffer.alloc(16, 7);
    await this.gate.run(() => scryptAsync(password, salt, 2 ** this.log2n, R, P));
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}
