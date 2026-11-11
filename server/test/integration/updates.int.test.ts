import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, waitOperation, type TestApp } from '../helpers/app.js';
import { IMG, PROJECT, docker, publish, snapAll, updDown, updUp, versionOf } from '../helpers/updates.js';

/**
 * Update detection, standalone pulls and the dry run against the real daemon and the fixture registry.
 * Everything touched is qmtest-* and labelled quaymaster.test=true.
 */
describe('update detection, pull and dry run (real Docker + fixture registry)', () => {
  let t: TestApp;

  beforeAll(async () => {
    updUp();
    t = await startApp();
  });
  afterAll(async () => {
    await t.close();
    updDown();
  });

  const statusOf = async (n: string, fresh = true) => {
    const r = fresh
      ? await t.call('POST', '/api/v1/updates/check', {}, t.admin)
      : await t.call('GET', '/api/v1/updates', undefined, t.admin);
    expect(r.status).toBe(200);
    return r.body.images.find((i: { ref: string }) => i.ref === IMG(n));
  };

  it('reports up_to_date, then update_available after a new version is pushed to the registry', async () => {
    for (const n of ['db', 'app', 'worker']) {
      const s = await statusOf(n);
      expect(s.state, `${n}: ${s.reason}`).toBe('up_to_date');
      expect(s.source).toBe('registry');
      expect(s.usedBy[0].project).toBe(PROJECT);
    }
    publish('app', 2, 'good');
    const app = await statusOf('app');
    expect(app.state).toBe('update_available');
    expect(app.remoteDigest).toMatch(/^sha256:/);
    expect(app.remoteDigest).not.toBe(app.localDigest);
    expect((await statusOf('db')).state).toBe('up_to_date');
  });

  it('dry run changes nothing: containers keep ID and StartedAt, nothing is pulled, staged or tagged', async () => {
    const before = snapAll();
    const sortLines = (x: string): string => x.split('\n').sort().join('\n');
    const imagesBefore = sortLines(
      docker('image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', '--filter', 'label=quaymaster.test=true'),
    );
    const res = await t.call('POST', '/api/v1/maintenance/plan', { project: PROJECT }, t.admin);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('planned');
    const plan = res.body.plan;
    expect(plan.blocked).toBeNull();
    expect(plan.order).toEqual(['app']);
    const svc = plan.services[0];
    expect(svc.service).toBe('app');
    expect(svc.toDigest).toMatch(/^sha256:/);
    expect(svc.fromImageId).toBe(before['app']?.imageId);
    expect(svc.configHash).toMatch(/^[0-9a-f]{16,}/);
    expect(svc.downtime).toMatch(/brief downtime/);
    expect(svc.autoRollback).toBe(true); // stateless
    expect(svc.health.kind).toBe('healthcheck');
    expect(svc.health.timeoutSeconds).toBeGreaterThanOrEqual(37); // start_period + interval × retries + 30 (RT-10)
    expect(plan.excluded.map((e: { service: string }) => e.service).sort()).toEqual(['db', 'worker']);
    expect(plan.preflight.ok).toBe(true);
    expect(plan.validation.valid).toBe(true);
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
    // nothing changed
    expect(snapAll()).toEqual(before);
    expect(
      sortLines(
        docker(
          'image',
          'ls',
          '--format',
          '{{.Repository}}:{{.Tag}}',
          '--filter',
          'label=quaymaster.test=true',
        ),
      ),
    ).toBe(imagesBefore);
    expect((await t.call('GET', '/api/v1/images/staged', undefined, t.admin)).body.staged).toEqual([]);
    expect(t.ctx.rollbackRepo.list()).toEqual([]);
    // and it is audited
    const audit = await t.call('GET', '/api/v1/audit?action=maintenance.dry_run', undefined, t.admin);
    expect(audit.body.entries.length).toBe(1);
  });

  it('a standalone pull stages the new image by digest but never restarts, recreates or retags anything', async () => {
    const before = snapAll();
    const tagBefore = docker('image', 'inspect', '--format', '{{.Id}}', IMG('app'));
    const res = await t.call('POST', '/api/v1/images/pull', { ref: IMG('app') }, t.admin);
    expect(res.status).toBe(202);
    const op = await waitOperation(t, res.body.operationId);
    expect(op.status, op.error).toBe('succeeded');
    expect(op.output).toMatch(/staged as quaymaster-staged\//);
    // same container ID and StartedAt across the pull, same image, the user-visible tag did not move
    expect(snapAll()).toEqual(before);
    expect(docker('image', 'inspect', '--format', '{{.Id}}', IMG('app'))).toBe(tagBefore);
    const staged = (await t.call('GET', '/api/v1/images/staged', undefined, t.admin)).body.staged;
    expect(staged).toHaveLength(1);
    expect(versionOf(staged[0].imageId)).toBe('2-good');
    // the staged state shows on the affected service, and the tag is still the old version
    const app = await statusOf('app');
    expect(app.state).toBe('update_staged');
    expect(versionOf(tagBefore)).toBe('1-good');
  });

  it('a pull failure (unreachable registry) fails the operation and leaves everything untouched', async () => {
    const before = snapAll();
    const res = await t.call(
      'POST',
      '/api/v1/images/pull',
      { ref: '127.0.0.1:5999/qmtest-nothing:latest' },
      t.admin,
    );
    expect(res.status).toBe(202);
    const op = await waitOperation(t, res.body.operationId);
    expect(op.status).toBe('failed');
    expect(snapAll()).toEqual(before);
  });
});
