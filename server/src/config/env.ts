import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Thrown for any invalid configuration; the message lists every problem. */
export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const bool = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no', '']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const list = z.string().transform((v) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const schema = z.object({
  QM_HOST: z.string().min(1).default('127.0.0.1'),
  QM_PORT: int(1, 65535).default(8787),
  QM_DATA_DIR: z.string().min(1).default('./data'),
  QM_SECRET_KEY: z.string().optional(),
  QM_SECRET_KEY_FILE: z.string().optional(),
  QM_ADMIN_USER: z.string().optional(),
  QM_ADMIN_PASSWORD_HASH: z.string().optional(),
  QM_ADMIN_PASSWORD_FILE: z.string().optional(),
  QM_COOKIE_SECURE: bool.default('false'),
  QM_PUBLIC_ORIGIN: list.default(''),
  QM_TRUST_PROXY: list.default(''),
  QM_READ_ONLY: bool.default('false'),
  QM_MANAGED_SCOPE: list.default(''),
  QM_VISIBLE_SCOPE: list.default(''),
  QM_PROTECTED: list.default(''),
  QM_SELF_CONTAINER: z.string().optional(),
  QM_STACK_PATHS: list.default(''),
  QM_DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  QM_DOCKER_ROOT_MOUNT: z.string().optional(),
  QM_REDACT_ALL_ENV: bool.default('false'),
  QM_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  QM_SESSION_IDLE_MINUTES: int(1, 24 * 60).default(30),
  QM_SESSION_ABSOLUTE_HOURS: int(1, 24 * 30).default(12),
  QM_SSE_MAX_PER_SESSION: int(1, 100).default(8),
  QM_SSE_MAX_TOTAL: int(1, 1000).default(32),
  QM_LOG_FOLLOW_BYTES_PER_SEC: int(1024, 100 * 1024 * 1024).default(512 * 1024),
  QM_STATS_INTERVAL_SECONDS: int(2, 3600).default(10),
  QM_STATS_RETENTION_HOURS: int(1, 24 * 30).default(48),
  QM_EVENT_RETENTION_DAYS: int(1, 365).default(14),
  QM_AUDIT_RETENTION_DAYS: int(30, 3650).default(365),
  QM_DISK_FLOOR_BYTES: int(0, Number.MAX_SAFE_INTEGER).default(5 * 1024 ** 3),
  QM_DF_MIN_INTERVAL_SECONDS: int(60, 7 * 86400).default(6 * 3600),
  QM_SCRYPT_LOG2_N: int(10, 20).default(17),
  QM_DOCKER_BIN: z.string().default('docker'),
  QM_WEB_DIR: z.string().optional(),
  QM_DISABLE_BACKGROUND: bool.default('false'),
  QM_REGISTRY_INSECURE: list.default(''),
  QM_CHECK_TTL_MINUTES: int(1, 7 * 24 * 60).default(360),
  QM_ROLLBACK_RETENTION_DAYS: int(0, 365).default(7),
  QM_CLEANUP_MIN_AGE_HOURS: int(0, 24 * 365).default(24),
  QM_APPROVAL_EXPIRY_HOURS: int(1, 24 * 30).default(72),
});

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  secretKey: Buffer;
  admin: { user: string; passwordHash?: string; passwordFile?: string } | null;
  cookieSecure: boolean;
  publicOrigins: string[];
  trustProxy: string[];
  readOnly: boolean;
  managedScope: string[];
  /** Glob allow-list of resource names that are VISIBLE at all (demo/screenshots); empty = everything. */
  visibleScope: string[];
  protectedNames: string[];
  selfContainer: string | null;
  stackPaths: string[];
  dockerSocket: string;
  dockerRootMount: string | null;
  redactAllEnv: boolean;
  logLevel: string;
  session: { idleMs: number; absoluteMs: number };
  sse: { maxPerSession: number; maxTotal: number; logBytesPerSec: number };
  stats: { intervalMs: number; retentionHours: number };
  eventRetentionDays: number;
  auditRetentionDays: number;
  diskFloorBytes: number;
  dfMinIntervalMs: number;
  scryptLog2N: number;
  dockerBin: string;
  /** Directory with the built web UI (default: <repo>/web/dist). */
  webDir?: string | null;
  disableBackground: boolean;
  registryInsecure: string[];
  checkTtlMs: number;
  rollbackRetentionMs: number;
  cleanupMinAgeMs: number;
  approvalExpiryMs: number;
}

/** Decodes a key given as hex or base64 (>= 32 decoded bytes). Passphrases are rejected. */
export function decodeSecretKey(raw: string): Buffer {
  const v = raw.trim();
  let buf: Buffer | null = null;
  if (/^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) buf = Buffer.from(v, 'hex');
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) buf = Buffer.from(v, 'base64');
  if (!buf || buf.length < 32) {
    throw new Error(
      'QM_SECRET_KEY must be at least 32 random bytes encoded as hex or base64 (generate one with: openssl rand -base64 32)',
    );
  }
  if (new Set(buf).size < 8) throw new Error('QM_SECRET_KEY has too little entropy (repeated bytes)');
  return buf;
}

function readSecretFile(file: string, label: string, problems: string[]): string | undefined {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (e) {
    problems.push(`${label}: cannot read ${file}: ${(e as Error).message}`);
    return undefined;
  }
}

/** Parses and validates the environment. Never echoes values; messages name variables only. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const input: Record<string, string> = {};
  for (const k of Object.keys(schema.shape)) {
    const v = env[k];
    if (v !== undefined) input[k] = v;
  }
  for (const k of Object.keys(env)) {
    if (k.startsWith('QM_') && !(k in schema.shape)) problems.push(`${k}: unknown variable (typo?)`);
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) problems.push(`${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(problems);
  }
  const e = parsed.data;

  let secretKey: Buffer | undefined;
  let rawKey = e.QM_SECRET_KEY;
  if (!rawKey && e.QM_SECRET_KEY_FILE) {
    rawKey = readSecretFile(e.QM_SECRET_KEY_FILE, 'QM_SECRET_KEY_FILE', problems);
  }
  if (!rawKey) {
    if (!e.QM_SECRET_KEY_FILE) problems.push('QM_SECRET_KEY (or QM_SECRET_KEY_FILE) is required');
  } else {
    try {
      secretKey = decodeSecretKey(rawKey);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }

  if (e.QM_STACK_PATHS.length === 0) {
    problems.push(
      'QM_STACK_PATHS is required: comma-separated absolute directories that may contain Compose projects',
    );
  }
  for (const p of e.QM_STACK_PATHS) {
    if (!path.isAbsolute(p)) problems.push(`QM_STACK_PATHS: "${p}" is not an absolute path`);
  }
  if (e.QM_ADMIN_PASSWORD_HASH && e.QM_ADMIN_PASSWORD_FILE) {
    problems.push('Set only one of QM_ADMIN_PASSWORD_HASH and QM_ADMIN_PASSWORD_FILE');
  }
  if ((e.QM_ADMIN_PASSWORD_HASH || e.QM_ADMIN_PASSWORD_FILE) && !e.QM_ADMIN_USER) {
    problems.push('QM_ADMIN_USER is required when QM_ADMIN_PASSWORD_HASH/QM_ADMIN_PASSWORD_FILE is set');
  }
  if (e.QM_ADMIN_USER && !e.QM_ADMIN_PASSWORD_HASH && !e.QM_ADMIN_PASSWORD_FILE) {
    problems.push('QM_ADMIN_USER needs QM_ADMIN_PASSWORD_HASH or QM_ADMIN_PASSWORD_FILE');
  }
  for (const o of e.QM_PUBLIC_ORIGIN) {
    try {
      const u = new URL(o);
      if (u.origin !== o) {
        problems.push(`QM_PUBLIC_ORIGIN: "${o}" must be a bare origin like https://qm.example.org`);
      }
    } catch {
      problems.push(`QM_PUBLIC_ORIGIN: "${o}" is not a valid URL`);
    }
  }
  for (const t of e.QM_TRUST_PROXY) {
    if (t === 'true' || t === '*' || t === '0.0.0.0/0') {
      problems.push('QM_TRUST_PROXY must be an explicit IP/CIDR list, never "true", "*" or 0.0.0.0/0');
    } else if (!/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(t)) {
      problems.push(`QM_TRUST_PROXY: "${t}" is not an IP or CIDR`);
    }
  }
  if (e.QM_SCRYPT_LOG2_N < 14 && env['NODE_ENV'] !== 'test') {
    problems.push('QM_SCRYPT_LOG2_N below 14 is only allowed when NODE_ENV=test');
  }
  if (problems.length > 0 || !secretKey) throw new ConfigError(problems);

  const admin = e.QM_ADMIN_USER
    ? {
        user: e.QM_ADMIN_USER,
        passwordHash: e.QM_ADMIN_PASSWORD_HASH,
        passwordFile: e.QM_ADMIN_PASSWORD_FILE,
      }
    : null;

  return {
    host: e.QM_HOST,
    port: e.QM_PORT,
    dataDir: path.resolve(e.QM_DATA_DIR),
    secretKey,
    admin,
    cookieSecure: e.QM_COOKIE_SECURE,
    publicOrigins: e.QM_PUBLIC_ORIGIN,
    trustProxy: e.QM_TRUST_PROXY,
    readOnly: e.QM_READ_ONLY,
    managedScope: e.QM_MANAGED_SCOPE,
    visibleScope: e.QM_VISIBLE_SCOPE,
    protectedNames: e.QM_PROTECTED,
    selfContainer: e.QM_SELF_CONTAINER ?? null,
    stackPaths: e.QM_STACK_PATHS.map((p) => path.resolve(p)),
    dockerSocket: e.QM_DOCKER_SOCKET,
    dockerRootMount: e.QM_DOCKER_ROOT_MOUNT ?? null,
    redactAllEnv: e.QM_REDACT_ALL_ENV,
    logLevel: e.QM_LOG_LEVEL,
    session: {
      idleMs: e.QM_SESSION_IDLE_MINUTES * 60_000,
      absoluteMs: e.QM_SESSION_ABSOLUTE_HOURS * 3_600_000,
    },
    sse: {
      maxPerSession: e.QM_SSE_MAX_PER_SESSION,
      maxTotal: e.QM_SSE_MAX_TOTAL,
      logBytesPerSec: e.QM_LOG_FOLLOW_BYTES_PER_SEC,
    },
    stats: { intervalMs: e.QM_STATS_INTERVAL_SECONDS * 1000, retentionHours: e.QM_STATS_RETENTION_HOURS },
    eventRetentionDays: e.QM_EVENT_RETENTION_DAYS,
    auditRetentionDays: e.QM_AUDIT_RETENTION_DAYS,
    diskFloorBytes: e.QM_DISK_FLOOR_BYTES,
    dfMinIntervalMs: e.QM_DF_MIN_INTERVAL_SECONDS * 1000,
    scryptLog2N: e.QM_SCRYPT_LOG2_N,
    dockerBin: e.QM_DOCKER_BIN,
    webDir: e.QM_WEB_DIR ? path.resolve(e.QM_WEB_DIR) : null,
    disableBackground: e.QM_DISABLE_BACKGROUND,
    registryInsecure: e.QM_REGISTRY_INSECURE,
    checkTtlMs: e.QM_CHECK_TTL_MINUTES * 60_000,
    rollbackRetentionMs: e.QM_ROLLBACK_RETENTION_DAYS * 86_400_000,
    cleanupMinAgeMs: e.QM_CLEANUP_MIN_AGE_HOURS * 3_600_000,
    approvalExpiryMs: e.QM_APPROVAL_EXPIRY_HOURS * 3_600_000,
  };
}
