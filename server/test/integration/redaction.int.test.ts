import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fixtures, startApp, type TestApp } from '../helpers/app.js';

/** Every fake secret planted in test-fixtures/stacks/qmtest-secrets/compose.yaml. */
const SECRETS = [
  'fx-env-password-7c1',
  'fx-env-token-4d2',
  'fx-url-pass-3b8',
  'fx-query-pass-5e6',
  'fx-label-secret-2f4',
  'fx-hc-secret-8a3',
  'fx-config-content-6g7',
  'fx-ext-secret-9a1',
];

describe('no fixture secret leaves the process (RT-04)', () => {
  let t: TestApp;
  const seen: string[] = [];

  beforeAll(async () => {
    fixtures('up', 'secrets');
    t = await startApp({}, { background: true });
  });
  afterAll(async () => {
    await t.close();
    fixtures('down');
  });

  it('API responses, events, logs, operation output, audit, DB bytes and application logs are clean', async () => {
    const get = async (url: string) => {
      const r = await t.call('GET', `/api/v1${url}`, undefined, t.admin);
      seen.push(r.raw);
      return r;
    };
    const name = 'qmtest-secrets-leaky-1';
    // prove the planted secrets are really present in the daemon's view (so the test can fail)
    const raw = await t.ctx.containers.resolve(name);
    expect(JSON.stringify(raw.raw)).toContain('fx-env-password-7c1');

    for (const url of [
      '/containers',
      `/containers/${name}`,
      `/containers/${name}/logs?tail=100`,
      '/compose/projects',
      '/compose/projects/qmtest-secrets',
      '/compose/projects/qmtest-secrets/config',
      '/compose/projects/qmtest-secrets/validate',
      '/images',
      '/volumes',
      '/networks',
      '/system/info',
      '/operations',
    ]) {
      expect((await get(url)).status, url).toBe(200);
    }
    const logs = (await get(`/containers/${name}/logs?tail=100`)).body.lines as { text: string }[];
    expect(logs.some((l) => l.text.includes('starting with password'))).toBe(true); // the line exists, scrubbed

    // generate events (including healthchecks with secrets in their exec command line) and an operation
    await t.call('POST', `/api/v1/containers/${name}/actions/restart`, { timeoutSeconds: 2 }, t.admin);
    const op = await t.call('POST', '/api/v1/compose/projects/qmtest-secrets/actions/restart', {}, t.admin);
    expect(op.status).toBe(202);
    await new Promise((r) => setTimeout(r, 9000)); // several healthcheck runs
    t.ctx.events.flush();
    await get('/events?limit=500');
    await get(`/operations/${op.body.operationId}`);
    await get('/audit?limit=500');
    await get('/containers/qmtest-secrets-leaky-1/stats');

    const joined = seen.join('\n');
    const dbDir = t.config.dataDir;
    const dbBytes = readdirSync(dbDir)
      .filter((f) => f.startsWith('quaymaster.db'))
      .map((f) => readFileSync(path.join(dbDir, f)).toString('latin1'))
      .join('\n');
    const appLog = t.logLines.join('\n');
    for (const s of SECRETS) {
      expect(joined, `API output leaks ${s}`).not.toContain(s);
      expect(dbBytes, `database leaks ${s}`).not.toContain(s);
      expect(appLog, `application log leaks ${s}`).not.toContain(s);
    }
    // the non-secret parts survive redaction
    const cfg = (await get('/compose/projects/qmtest-secrets/config')).body.config;
    expect(cfg.services.leaky.environment.MODE).toBe('production');
    expect(cfg.services.leaky.environment.DB_PASSWORD).toBe('••••••');
  }, 120_000);
});
