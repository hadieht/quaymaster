import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config/env.js';
import { createContext, type AppContext } from '../../src/context.js';
import { createLogger } from '../../src/util/logger.js';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
export const FIXTURES = path.join(REPO_ROOT, 'test-fixtures');
export const STACKS_DIR = path.join(FIXTURES, 'stacks');
export const TEST_ORIGIN = 'http://127.0.0.1:8799';
export const ADMIN = { username: 'tester', password: 'integration-test-password' };

export const TEST_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 13) % 251)).toString(
  'base64',
);

export function testConfig(over: Record<string, string> = {}): Config {
  const dataDir = mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'qm-it-'));
  return loadConfig({
    NODE_ENV: 'test',
    QM_DATA_DIR: dataDir,
    QM_SECRET_KEY: TEST_KEY,
    QM_STACK_PATHS: STACKS_DIR,
    // SAFETY (AGENTS.md rule 4): every test instance that can reach the real socket is scoped
    QM_MANAGED_SCOPE: 'qmtest-*',
    QM_HOST: '127.0.0.1',
    QM_PORT: '8799',
    QM_SCRYPT_LOG2_N: '10',
    QM_LOG_LEVEL: 'silent',
    QM_STATS_INTERVAL_SECONDS: '2',
    ...over,
  });
}

export function fixtures(action: 'up' | 'down', ...targets: string[]): void {
  execFileSync('bash', [path.join(FIXTURES, 'scripts', `${action}.sh`), ...targets], {
    stdio: 'pipe',
    timeout: 180_000,
  });
}

export interface TestApp {
  ctx: AppContext;
  app: FastifyInstance;
  config: Config;
  logLines: string[];
  /** Authenticated request helper (admin by default). */
  call(method: string, url: string, body?: unknown, who?: Session): Promise<ApiResponse>;
  login(username: string, password: string): Promise<Session>;
  admin: Session;
  close(): Promise<void>;
}

export interface Session {
  cookie: string;
  csrf: string;
}
export interface ApiResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test convenience only
  body: any;
  headers: Record<string, unknown>;
  raw: string;
}

export async function startApp(
  over: Record<string, string> = {},
  opts: { background?: boolean } = {},
): Promise<TestApp> {
  const config = testConfig(over);
  const logLines: string[] = [];
  const log = createLogger('debug', { write: (m: string) => void logLines.push(m) });
  const ctx = await createContext(config, {
    log,
    background: opts.background ?? false,
    announce: () => undefined,
  });
  const app = await buildApp(ctx);
  await app.ready();

  const call: TestApp['call'] = async (method, url, body, who) => {
    const headers: Record<string, string> = { origin: TEST_ORIGIN };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (who) {
      headers['cookie'] = who.cookie;
      headers['x-qm-csrf'] = who.csrf;
    }
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers,
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    let parsed: unknown = null;
    try {
      parsed = res.body ? JSON.parse(res.body) : null;
    } catch {
      parsed = null;
    }
    return { status: res.statusCode, body: parsed, headers: res.headers, raw: res.body };
  };

  const login = async (username: string, password: string): Promise<Session> => {
    const res = await call('POST', '/api/v1/auth/login', { username, password });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.raw}`);
    const setCookie = String(res.headers['set-cookie']);
    return { cookie: setCookie.split(';')[0] as string, csrf: res.body.csrfToken as string };
  };

  await ctx.auth.createUser({ ...ADMIN, role: 'admin' }).catch((e: unknown) => {
    if (!over['QM_DATA_DIR']) throw e; // a reused data dir already has the user
  });
  const admin = await login(ADMIN.username, ADMIN.password);

  return {
    ctx,
    app,
    config,
    logLines,
    call,
    login,
    admin,
    async close() {
      await app.close();
      await ctx.shutdown();
    },
  };
}

/** Polls until `fn` returns a truthy value. */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  what: string,
  timeoutMs = 30_000,
  stepMs = 250,
): Promise<NonNullable<T>> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function writeFixtureFile(file: string, content: string): void {
  if (!file.startsWith(STACKS_DIR + path.sep))
    throw new Error('refusing to write outside test-fixtures/stacks');
  writeFileSync(file, content);
}

export async function waitOperation(t: TestApp, id: string, timeoutMs = 90_000) {
  return waitFor(
    async () => {
      const r = await t.call('GET', `/api/v1/operations/${id}`, undefined, t.admin);
      return r.body.status !== 'running' ? r.body : null;
    },
    `operation ${id}`,
    timeoutMs,
    500,
  );
}
