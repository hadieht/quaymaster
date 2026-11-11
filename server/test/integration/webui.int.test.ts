import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, startApp, type TestApp } from '../helpers/app.js';

/** Phase 3 additions: settings overview, own sessions, cron preview, stats overview, static UI serving. */
describe('web UI support (no containers needed)', () => {
  let t: TestApp;
  let webDir: string;

  beforeAll(async () => {
    webDir = mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'qm-web-'));
    mkdirSync(path.join(webDir, 'assets'));
    writeFileSync(
      path.join(webDir, 'index.html'),
      '<!doctype html><title>Quaymaster</title><div id="root"></div>',
    );
    writeFileSync(path.join(webDir, 'assets', 'app-abc123.js'), 'console.log(1)');
    t = await startApp({ QM_WEB_DIR: webDir });
  });
  afterAll(async () => {
    await t.close();
  });

  it('serves index.html, hashed assets with long caching, and falls back to index.html for client routes', async () => {
    const root = await t.app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.headers['content-type']).toContain('text/html');
    expect(root.headers['cache-control']).toBe('no-cache');
    expect(root.headers['content-security-policy']).toContain("script-src 'self'");

    const asset = await t.app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');

    const route = await t.app.inject({ method: 'GET', url: '/containers/some-name?tab=logs' });
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain('<div id="root">');
  });

  it('keeps API 404s as JSON and does not turn missing files or non-GET into the SPA', async () => {
    const api = await t.app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(api.statusCode).toBe(401); // unauthenticated API paths never reveal what exists
    const missing = await t.app.inject({ method: 'GET', url: '/assets/missing.js' });
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body).error.code).toBe('not_found');
    const post = await t.app.inject({ method: 'POST', url: '/containers' });
    expect(post.statusCode).toBe(404);
  });

  it('GET /system/settings returns operational config without secrets', async () => {
    const r = await t.call('GET', '/api/v1/system/settings', undefined, t.admin);
    expect(r.status).toBe(200);
    expect(r.body.retention.eventDays).toBeGreaterThan(0);
    expect(r.body.session.idleMinutes).toBeGreaterThan(0);
    expect(JSON.stringify(r.body)).not.toMatch(/secret|key|password/i);
  });

  it('lists only my sessions, marks the current one, and revokes another one', async () => {
    const other = await t.login(ADMIN.username, ADMIN.password);
    const list = await t.call('GET', '/api/v1/auth/sessions', undefined, t.admin);
    expect(list.status).toBe(200);
    const sessions = list.body.sessions as { id: string; current: boolean }[];
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);

    const current = sessions.find((s) => s.current) as { id: string };
    const refuse = await t.call('DELETE', `/api/v1/auth/sessions/${current.id}`, undefined, t.admin);
    expect(refuse.status).toBe(404); // the current session is ended with logout

    const victim = sessions.find((s) => !s.current) as { id: string };
    const del = await t.call('DELETE', `/api/v1/auth/sessions/${victim.id}`, undefined, t.admin);
    expect(del.status).toBe(200);
    const after = await t.call('GET', '/api/v1/auth/sessions', undefined, t.admin);
    expect((after.body.sessions as { id: string }[]).some((s) => s.id === victim.id)).toBe(false);
    // at least one of the other login's cookie is dead now, the admin session lives on
    expect((await t.call('GET', '/api/v1/auth/me', undefined, t.admin)).status).toBe(200);
    expect(other.cookie).toBeTruthy();
  });

  it("cannot revoke another user's session", async () => {
    await t.ctx.auth.createUser({ username: 'viewer9', password: 'viewer-password-999', role: 'viewer' });
    const v = await t.login('viewer9', 'viewer-password-999');
    const mine = await t.call('GET', '/api/v1/auth/sessions', undefined, v);
    const vid = (mine.body.sessions as { id: string }[])[0]?.id as string;
    const r = await t.call('DELETE', `/api/v1/auth/sessions/${vid}`, undefined, t.admin);
    expect(r.status).toBe(404);
  });

  it('previews cron expressions with DST-aware next runs and rejects bad input', async () => {
    const ok = await t.call(
      'GET',
      `/api/v1/maintenance/cron/preview?cron=${encodeURIComponent('30 3 * * 0')}&timezone=Europe/Berlin`,
      undefined,
      t.admin,
    );
    expect(ok.body.valid).toBe(true);
    expect(ok.body.nextRuns).toHaveLength(5);
    const bad = await t.call(
      'GET',
      `/api/v1/maintenance/cron/preview?cron=${encodeURIComponent('* * *')}&timezone=UTC`,
      undefined,
      t.admin,
    );
    expect(bad.body).toMatchObject({ valid: false, nextRuns: [] });
    const tz = await t.call(
      'GET',
      `/api/v1/maintenance/cron/preview?cron=${encodeURIComponent('0 0 * * *')}&timezone=Mars/Base`,
      undefined,
      t.admin,
    );
    expect(tz.body.valid).toBe(false);
  });

  it('aggregates roll-ups into host-wide CPU, memory and network-rate points', async () => {
    const nowMin = Math.floor(Date.now() / 60_000);
    const row = (id: string, minute: number, cpu: number, mem: number, rx: number, tx: number) => ({
      container_id: id,
      minute,
      name: id,
      samples: 1,
      cpu_avg: cpu,
      cpu_max: cpu,
      mem_avg: mem,
      mem_max: mem,
      net_rx: rx,
      net_tx: tx,
      blk_read: 0,
      blk_write: 0,
    });
    t.ctx.statsRepo.upsertMany([
      row('aaa', nowMin - 3, 10, 100, 1000, 500),
      row('aaa', nowMin - 2, 20, 100, 7000, 500 + 600),
      row('bbb', nowMin - 3, 5, 50, 0, 0),
      row('bbb', nowMin - 2, 5, 50, 120, 60),
      row('bbb', nowMin - 1, 5, 50, 10, 0), // counter dropped: container restarted, no negative rate
    ]);
    const r = await t.call('GET', '/api/v1/stats/overview?minutes=10', undefined, t.admin);
    expect(r.status).toBe(200);
    const pts = r.body.points as { t: number; cpu: number; mem: number; netRx: number; netTx: number }[];
    const at = (m: number) => pts.find((p) => p.t === m * 60_000);
    expect(at(nowMin - 3)).toMatchObject({ cpu: 15, mem: 150, netRx: 0, netTx: 0 });
    // aaa: (7000-1000)/60 = 100 B/s, bbb: 120/60 = 2 B/s
    expect(at(nowMin - 2)?.netRx).toBeCloseTo(102, 5);
    expect(at(nowMin - 2)?.netTx).toBeCloseTo(10 + 1, 5);
    expect(at(nowMin - 1)?.netRx).toBe(0);
  });
});
