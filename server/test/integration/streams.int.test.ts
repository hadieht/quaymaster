import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DockerEventRecord } from '@quaymaster/shared';
import type { LogLine } from '../../src/docker/logs.js';
import { fixtures, startApp, waitFor, type TestApp } from '../helpers/app.js';

describe('logs, events and stats (real daemon, fixtures only)', () => {
  let t: TestApp;
  beforeAll(async () => {
    fixtures('up', 'multi', 'single');
    t = await startApp({}, { background: true });
  });
  afterAll(async () => {
    await t.close();
  });

  it('tails logs, demultiplexed with timestamps', async () => {
    const r = await t.call(
      'GET',
      '/api/v1/containers/qmtest-multi-worker-1/logs?tail=50',
      undefined,
      t.admin,
    );
    expect(r.status).toBe(200);
    const lines = r.body.lines as LogLine[];
    const l = lines.find((x) => x.text === 'worker started');
    expect(l).toBeTruthy();
    expect(l?.stream).toBe('stdout');
    expect(l?.ts).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('viewer needs the logs permission (RT-30): off by default, can be granted', async () => {
    await t.ctx.auth.createUser({ username: 'viewer2', password: 'viewer-password-456', role: 'viewer' });
    const v = await t.login('viewer2', 'viewer-password-456');
    const denied = await t.call('GET', '/api/v1/containers/qmtest-multi-worker-1/logs', undefined, v);
    expect(denied.status).toBe(403);
    const users = (await t.call('GET', '/api/v1/users', undefined, t.admin)).body as {
      id: number;
      username: string;
    }[];
    const id = users.find((u) => u.username === 'viewer2')?.id;
    const patched = await t.call('PATCH', `/api/v1/users/${id}`, { logsRead: true }, t.admin);
    expect(patched.status).toBe(200);
    // privilege change revokes the old session (RT-18)
    expect((await t.call('GET', '/api/v1/auth/me', undefined, v)).status).toBe(401);
    const v2 = await t.login('viewer2', 'viewer-password-456');
    expect((await t.call('GET', '/api/v1/containers/qmtest-multi-worker-1/logs', undefined, v2)).status).toBe(
      200,
    );
  });

  it('follows logs live through the service layer', async () => {
    const got: string[] = [];
    const follow = await t.ctx.containers.logsFollow(
      'qmtest-single-solo-1',
      { tail: 5 },
      (l) => got.push(l.text),
      () => undefined,
    );
    await waitFor(() => got.includes('solo started'), 'tail line from follow stream');
    follow.close();
  });

  it('persists allow-listed events only, without exec noise or label dumps (RT-04, RT-25)', async () => {
    await t.call(
      'POST',
      '/api/v1/containers/qmtest-single-solo-1/actions/restart',
      { timeoutSeconds: 2 },
      t.admin,
    );
    const events = await waitFor(async () => {
      t.ctx.events.flush();
      const r = (await t.call('GET', '/api/v1/events?limit=100', undefined, t.admin)).body
        .events as DockerEventRecord[];
      const mine = r.filter((e) => e.name === 'qmtest-single-solo-1');
      return mine.some((e) => e.action === 'die') && mine.some((e) => e.action === 'start') ? r : null;
    }, 'die+start events');
    expect(events.some((e) => e.action.startsWith('exec_'))).toBe(false);
    for (const e of events) {
      expect(
        Object.keys(e.attributes).every((k) => ['exitCode', 'signal', 'oldName', 'health'].includes(k)),
      ).toBe(true);
      expect(JSON.stringify(e)).not.toContain('quaymaster.test');
    }
    const die = events.find((e) => e.action === 'die' && e.name === 'qmtest-single-solo-1');
    expect(die?.project).toBe('qmtest-single');
    expect(die?.service).toBe('solo');
  });

  it('records health_status changes from healthchecks', async () => {
    t.ctx.events.flush();
    const r = (await t.call('GET', '/api/v1/events?limit=200', undefined, t.admin)).body
      .events as DockerEventRecord[];
    // healthy containers of the multi stack started before the watcher; trigger a fresh transition
    await t.call(
      'POST',
      '/api/v1/containers/qmtest-multi-db-1/actions/restart',
      { timeoutSeconds: 2 },
      t.admin,
    );
    const ev = await waitFor(
      async () => {
        t.ctx.events.flush();
        const x = (await t.call('GET', '/api/v1/events?limit=200', undefined, t.admin)).body
          .events as DockerEventRecord[];
        return x.find((e) => e.action === 'health_status' && e.name === 'qmtest-multi-db-1');
      },
      'health_status event',
      40_000,
    );
    expect(ev.attributes['health']).toMatch(/healthy|unhealthy|starting/);
    expect(r).toBeTruthy();
  });

  it('streams events live to subscribers', async () => {
    const seen: DockerEventRecord[] = [];
    const on = (e: DockerEventRecord) => seen.push(e);
    t.ctx.events.on('event', on);
    await t.call(
      'POST',
      '/api/v1/containers/qmtest-single-solo-1/actions/restart',
      { timeoutSeconds: 2 },
      t.admin,
    );
    await waitFor(
      () => seen.some((e) => e.action === 'start' && e.name === 'qmtest-single-solo-1'),
      'live start event',
    );
    t.ctx.events.off('event', on);
  });

  it('samples stats into a ring buffer and persists 1-minute roll-ups', async () => {
    // two samples are needed before CPU can be computed from our own previous reading
    await t.ctx.stats.tick();
    await new Promise((r) => setTimeout(r, 1200));
    await t.ctx.stats.tick();
    const id = (await t.ctx.containers.resolve('qmtest-multi-db-1')).id;
    const r = await t.call('GET', '/api/v1/containers/qmtest-multi-db-1/stats', undefined, t.admin);
    expect(r.status).toBe(200);
    const pts = r.body.points as { t: number; cpu: number; memUsage: number; memLimit: number }[];
    expect(pts.length).toBeGreaterThanOrEqual(1);
    expect(pts[0]?.memUsage).toBeGreaterThan(0);
    expect(pts[0]?.memLimit).toBeGreaterThan(0);
    expect(pts[0]?.cpu).toBeGreaterThanOrEqual(0);
    t.ctx.stats.flushRollups(true);
    const h = await t.call(
      'GET',
      '/api/v1/containers/qmtest-multi-db-1/stats/history?minutes=5',
      undefined,
      t.admin,
    );
    expect(h.body.rollups.length).toBeGreaterThanOrEqual(1);
    expect(h.body.rollups[0].container_id).toBe(id);
    expect(h.body.rollups[0].samples).toBeGreaterThanOrEqual(1);
  });
});
