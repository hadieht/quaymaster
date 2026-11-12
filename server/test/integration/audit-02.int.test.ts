import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_ORIGIN, startApp, type TestApp } from '../helpers/app.js';
import { isSafeRef } from '../../src/docker/model.js';

/**
 * Red-team audit 02 (docs/reviews/02-implementation-audit.md): regression tests.
 * No fixture containers are needed for these: they exercise request handling only.
 */

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(async () => {
  await t.close();
});

async function raw(url: string, who?: { cookie: string; csrf: string }, method = 'GET') {
  const res = await t.app.inject({
    method: method as 'GET',
    url,
    headers: { origin: TEST_ORIGIN, ...(who ? { cookie: who.cookie, 'x-qm-csrf': who.csrf } : {}) },
  });
  return res;
}

describe('C-01 auth bypass through an encoded API prefix', () => {
  const GETS = [
    'containers',
    'compose/projects',
    'images',
    'images/staged',
    'volumes',
    'networks',
    'events',
    'operations',
    'system/info',
    'stats/overview',
    'updates',
    'maintenance/policies',
    'maintenance/windows',
    'maintenance/schedules',
    'maintenance/runs',
    'notifications/channels',
    'notifications/deliveries',
    'monitors/settings',
    'auth/sessions',
    'stream/events',
    'stream/maintenance',
  ];
  const SPELLINGS: Array<(p: string) => string> = [
    (p) => `/api/v1/${p}`,
    (p) => `/%61pi/v1/${p}`,
    (p) => `/api/v%31/${p}`,
    (p) => `/%41pi/v1/${p}`,
    (p) => `/api%2Fv1/${p}`,
    (p) => `//api/v1/${p}`,
    (p) => `/%2561pi/v1/${p}`,
    (p) => `/api/v1/${p}?x=1`,
  ];
  it('every GET route answers 401 without a session, whatever the URL spelling', async () => {
    const leaks: string[] = [];
    for (const p of GETS) {
      for (const spell of SPELLINGS) {
        const url = spell(p);
        const res = await raw(url);
        if (res.statusCode === 200 && String(res.headers['content-type']).includes('json'))
          leaks.push(`${res.statusCode} ${url}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('the password endpoint and mutations are closed on encoded spellings (no 500)', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/%61pi/v1/auth/password',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ current: 'x', next: 'y' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('the public endpoints stay public', async () => {
    expect((await raw('/api/v1/auth/status')).statusCode).toBe(200);
    expect((await raw('/healthz')).statusCode).toBe(200);
  });

  it('malformed percent-encoding is a 400, not a crash', async () => {
    const res = await raw('/api/v1/containers/%E0%A4%A');
    expect([400, 401]).toContain(res.statusCode);
  });
});

describe('C-02 path traversal into the Engine API', () => {
  const EVIL = ['x%2F..%2F..%2Fversion', '..%2F..%2Fversion', 'a%2Fb', '%2e%2e', 'x%2F.%2Fy'];
  const ROUTES = [
    (r: string) => `/api/v1/containers/${r}`,
    (r: string) => `/api/v1/containers/${r}/stats`,
    (r: string) => `/api/v1/containers/${r}/logs`,
    (r: string) => `/api/v1/images/${r}`,
    (r: string) => `/api/v1/volumes/${r}`,
    (r: string) => `/api/v1/networks/${r}`,
  ];
  it('is rejected with 400/404 and the process keeps serving', async () => {
    for (const mk of ROUTES) {
      for (const evil of EVIL) {
        const res = await raw(mk(evil), t.admin);
        expect([400, 404], `${mk(evil)} -> ${res.statusCode}`).toContain(res.statusCode);
      }
    }
    expect((await raw('/healthz')).statusCode).toBe(200);
  });

  it('isSafeRef accepts real names and rejects traversal', () => {
    expect(isSafeRef('qmtest-web-1', 'container')).toBe(true);
    expect(isSafeRef('qmtest/web', 'container')).toBe(false);
    expect(isSafeRef('x/../../version', 'container')).toBe(false);
    expect(isSafeRef('qmtest_data', 'volume')).toBe(true);
    expect(isSafeRef('a/b', 'volume')).toBe(false);
    expect(isSafeRef('registry.example:5000/team/app:1.2', 'image')).toBe(true);
    expect(isSafeRef('alpine@sha256:' + 'a'.repeat(64), 'image')).toBe(true);
    expect(isSafeRef('x/../../version', 'image')).toBe(false);
    expect(isSafeRef('x/./y', 'image')).toBe(false);
    expect(isSafeRef('x//y', 'image')).toBe(false);
    expect(isSafeRef('-h', 'image')).toBe(false);
  });
});

describe('H-02 pull respects QM_MANAGED_SCOPE', () => {
  it('refuses a reference no in-scope container uses (and creates nothing)', async () => {
    const res = await t.call('POST', '/api/v1/images/pull', { ref: 'qm-audit-notused/never:1' }, t.admin);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('out_of_scope');
    const ops = await t.call('GET', '/api/v1/operations', undefined, t.admin);
    expect(JSON.stringify(ops.body)).not.toContain('qm-audit-notused');
  });
});

describe('H-03 manual actions are refused while a maintenance run holds the lock', () => {
  it('compose and container actions return 409 until the run finishes', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    t.ctx.ops.start({
      kind: 'maintenance.update',
      target: 'qmtest-h03',
      actor: 'test',
      params: {},
      lockKey: 'maintenance',
      run: async () => {
        await held;
      },
    });
    try {
      const c = await t.call('POST', '/api/v1/compose/projects/qmtest-h03/actions/restart', {}, t.admin);
      expect(c.status).toBe(409);
      expect(JSON.stringify(c.body)).toContain('maintenance run is active');
    } finally {
      release();
    }
    await new Promise((r) => setTimeout(r, 200));
    const after = await t.call('POST', '/api/v1/compose/projects/qmtest-h03/actions/restart', {}, t.admin);
    expect(JSON.stringify(after.body)).not.toContain('maintenance run is active');
  });
});

describe('H-04 crash reconciliation treats an unhealthy running service as broken', () => {
  it('flags unhealthy (critical path) and says so in the guidance', async () => {
    const svc = t.ctx.maintenance as unknown as {
      describeCompose(
        run: unknown,
        it: unknown,
        all: unknown[],
      ): Promise<{ guidance: string[]; down: boolean; unhealthy?: boolean; unverified: boolean }>;
    };
    const run = { target: 'qmtest-h04', plan: null };
    const intent = { service: 'app', action: 'deploy', fromImage: 'sha256:aaa', toImage: 'sha256:bbb' };
    const mk = (status: string) => [
      {
        Id: 'c1',
        State: 'running',
        Status: status,
        ImageID: 'sha256:bbb',
        Labels: { 'com.docker.compose.project': 'qmtest-h04', 'com.docker.compose.service': 'app' },
      },
    ];
    const bad = await svc.describeCompose(run, intent, mk('Up 5 seconds (unhealthy)'));
    expect(bad.down).toBe(false);
    expect(bad.unhealthy).toBe(true);
    expect(bad.unverified).toBe(false);
    expect(bad.guidance.join(' ')).toMatch(/UNHEALTHY/);
    const ok = await svc.describeCompose(run, intent, mk('Up 5 seconds (healthy)'));
    expect(ok.unhealthy).toBe(false);
    expect(ok.unverified).toBe(true);
  });
});
