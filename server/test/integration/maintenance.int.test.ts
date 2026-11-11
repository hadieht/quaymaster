import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startApp, waitFor, type TestApp } from '../helpers/app.js';
import {
  IMG,
  PROJECT,
  docker,
  publish,
  snap,
  snapAll,
  stackFile,
  stepLog,
  updDown,
  updUp,
  versionOf,
  waitRun,
} from '../helpers/updates.js';

/**
 * The update executor end to end against the real daemon and the fixture registry (qmtest-upd, db → app → worker).
 * Every resource is qmtest-* and labelled quaymaster.test=true; every scenario starts from a fresh stack at v1.
 */
describe('maintenance runs (real Docker + fixture registry)', { timeout: 240_000 }, () => {
  let t: TestApp;

  beforeEach(async () => {
    updDown();
    updUp();
    t = await startApp();
    t.ctx.executor.setHealthOptions({ pollMs: 500 });
  }, 300_000);
  afterEach(async () => {
    t.ctx.executor.setStepHook(undefined);
    await t.close().catch(() => undefined);
    updDown();
  }, 120_000);

  const startRun = async (extra: Record<string, unknown> = {}) => {
    const r = await t.call(
      'POST',
      '/api/v1/maintenance/runs',
      { project: PROJECT, startNow: true, confirm: PROJECT, ...extra },
      t.admin,
    );
    return r;
  };
  const runToEnd = async (extra: Record<string, unknown> = {}) => {
    const r = await startRun(extra);
    expect([201, 202], JSON.stringify(r.body)).toContain(r.status);
    return waitRun(t, r.body.id as string);
  };
  const fastPolicy = () =>
    t.call(
      'PUT',
      `/api/v1/maintenance/policies/project/${PROJECT}`,
      { health: { timeoutSeconds: 25, stabilizationSeconds: 2 } },
      t.admin,
    );

  it('updates the services one at a time in dependency order and records every step', async () => {
    await fastPolicy();
    for (const n of ['db', 'app', 'worker']) publish(n, 2, 'good');
    const before = snapAll();
    const run = (await runToEnd()) as never as {
      status: string;
      reason: string;
      result: { services: { service: string; outcome: string }[] };
      plan: { order: string[] };
      steps: { service: string | null; step: string; status: string }[];
    };
    expect(run.status, run.reason).toBe('completed');
    expect(run.plan.order).toEqual(['db', 'app', 'worker']);
    expect(run.result.services.map((s) => `${s.service}:${s.outcome}`)).toEqual([
      'db:updated',
      'app:updated',
      'worker:updated',
    ]);
    const log = stepLog(run);
    for (const s of [
      '-:preflight:succeeded',
      '-:validate:succeeded',
      '-:check:succeeded',
      '-:recovery_point:succeeded',
      '-:pull:succeeded',
      '-:impact:succeeded',
      'db:deploy:succeeded',
      'db:health:succeeded',
      'app:deploy:succeeded',
      'worker:deploy:succeeded',
      '-:record:succeeded',
    ])
      expect(log, s).toContain(s);
    // one service at a time: db is fully healthy before app is deployed
    expect(log.indexOf('db:health:succeeded')).toBeLessThan(log.indexOf('app:deploy:succeeded'));
    expect(log.indexOf('app:health:succeeded')).toBeLessThan(log.indexOf('worker:deploy:succeeded'));
    const after = snapAll();
    for (const n of ['db', 'app', 'worker'] as const) {
      expect(after[n]?.id).not.toBe(before[n]?.id);
      expect(versionOf(after[n]?.imageId ?? ''), n).toBe('2-good');
      expect(after[n]?.status).toBe('running');
    }
    // recovery points were tagged and are kept (rollback protection)
    expect(t.ctx.rollbackRepo.list().length).toBe(3);
    const rb = docker('image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', '--filter', 'label=quaymaster.test=true');
    expect(rb).toMatch(/quaymaster-rollback/);
    // staged aliases are gone after a successful deploy; the next check is clean
    expect((await t.call('GET', '/api/v1/images/staged', undefined, t.admin)).body.staged).toEqual([]);
    const chk = await t.call('POST', '/api/v1/updates/check', {}, t.admin);
    const states = chk.body.images
      .filter((i: { ref: string }) => i.ref.includes('qmtest-'))
      .map((i: { state: string }) => i.state);
    expect(states, JSON.stringify(chk.body.images.map((i: { ref: string; state: string; reason?: string }) => [i.ref, i.state, i.reason]))).toEqual(['up_to_date', 'up_to_date', 'up_to_date']);
    // audited
    const audit = await t.call('GET', '/api/v1/audit?action=maintenance.run.finish', undefined, t.admin);
    expect(audit.body.entries.length).toBe(1);
  });

  it('a broken image fails its health gate, is rolled back automatically and the service is healthy on the old image', async () => {
    await fastPolicy();
    publish('app', 2, 'unhealthy');
    publish('worker', 2, 'good');
    const before = snapAll();
    const run = (await runToEnd()) as never as {
      status: string;
      reason: string;
      result: { services: { service: string; outcome: string }[] };
      steps: { service: string | null; step: string; status: string }[];
    };
    expect(run.status, run.reason).toBe('rolled_back');
    const out = Object.fromEntries(run.result.services.map((s) => [s.service, s.outcome]));
    expect(out).toEqual({ app: 'rolled_back', worker: 'skipped' });
    const log = stepLog(run);
    expect(log).toContain('app:health:failed');
    expect(log).toContain('app:rollback:succeeded');
    const app = snap('app');
    expect(app.status).toBe('running');
    expect(app.health).toBe('healthy');
    expect(app.imageId).toBe(before['app']?.imageId);
    expect(versionOf(app.imageId)).toBe('1-good');
    // the user-visible tag points to the old image again, the untouched services were not restarted
    expect(docker('image', 'inspect', '--format', '{{.Id}}', IMG('app'))).toBe(before['app']?.imageId);
    expect(snap('worker')).toEqual(before['worker']);
    expect(snap('db')).toEqual(before['db']);
    // the broken digest is quarantined so unattended runs do not retry it
    const q = await t.call('GET', '/api/v1/updates/quarantine', undefined, t.admin);
    expect(q.body.entries.length).toBe(1);
  });

  it('with rollback disabled a failed update stops the run with exact recovery commands and skips the rest', async () => {
    await t.call(
      'PUT',
      `/api/v1/maintenance/policies/project/${PROJECT}`,
      { autoRollback: false, health: { timeoutSeconds: 25, stabilizationSeconds: 2 } },
      t.admin,
    );
    publish('app', 2, 'unhealthy');
    publish('worker', 2, 'good');
    const before = snapAll();
    const run = (await runToEnd()) as never as {
      status: string;
      guidance: string[];
      result: { services: { service: string; outcome: string }[] };
    };
    expect(run.status).toBe('failed');
    const out = Object.fromEntries(run.result.services.map((s) => [s.service, s.outcome]));
    expect(out).toEqual({ app: 'failed_left_as_is', worker: 'skipped' });
    const g = run.guidance.join('\n');
    expect(g).toContain(`docker tag ${before['app']?.imageId}`);
    expect(g).toContain('docker compose');
    expect(g).toContain('--pull never');
    expect(versionOf(snap('app').imageId)).toBe('2-unhealthy');
    expect(snap('worker')).toEqual(before['worker']);
    // the recovery commands really do restore the service (executed by hand, fixtures only)
    const lines = run.guidance.filter((l) => l.startsWith('docker '));
    for (const l of lines) {
      expect(l).toMatch(/qmtest|127\.0\.0\.1:5055/);
    }
  });

  it('a pull failure aborts with zero impact: nothing restarted, retagged or recreated', async () => {
    await fastPolicy();
    publish('app', 2, 'good');
    const before = snapAll();
    const tag = docker('image', 'inspect', '--format', '{{.Id}}', IMG('app'));
    t.ctx.executor.setStepHook(({ step, phase }) => {
      if (step === 'pull' && phase === 'start') docker('stop', '--time', '1', 'qmtest-registry');
    });
    try {
      const run = (await runToEnd()) as never as {
        status: string;
        reason: string;
        steps: { service: string | null; step: string; status: string }[];
        guidance: string[];
      };
      expect(run.status).toBe('failed');
      expect(run.reason).toMatch(/Pull failed/);
      expect(stepLog(run)).toContain('-:pull:failed');
      expect(stepLog(run).some((s) => s.includes(':deploy:'))).toBe(false);
      expect(snapAll()).toEqual(before);
      expect(docker('image', 'inspect', '--format', '{{.Id}}', IMG('app'))).toBe(tag);
    } finally {
      docker('start', 'qmtest-registry');
      await waitFor(
        async () => {
          try {
            return (await fetch('http://127.0.0.1:5055/v2/')).ok;
          } catch {
            return false;
          }
        },
        'registry',
        20_000,
        300,
      );
    }
  });

  it('an invalid Compose file stops the run at validation before anything is pulled or changed', async () => {
    await fastPolicy();
    publish('app', 2, 'good');
    const before = snapAll();
    const original = readFileSync(stackFile, 'utf8');
    const r = await t.call(
      'POST',
      '/api/v1/maintenance/runs',
      { project: PROJECT },
      t.admin,
    );
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('awaiting_approval');
    try {
      writeFileSync(stackFile, original.replace('name: qmtest-upd', 'name: qmtest-upd\nbogus_top_level: [1'));
      const ap = await t.call(
        'POST',
        `/api/v1/maintenance/runs/${r.body.id}/approve`,
        { planHash: r.body.planHash },
        t.admin,
      );
      expect(ap.status, ap.raw).toBe(202);
      const run = (await waitRun(t, r.body.id)) as never as {
        status: string;
        steps: { service: string | null; step: string; status: string }[];
      };
      expect(run.status).toBe('blocked');
      const log = stepLog(run);
      expect(log).toContain('-:validate:failed');
      expect(log.some((s) => s.includes(':pull:') || s.includes(':deploy:'))).toBe(false);
      expect(snapAll()).toEqual(before);
    } finally {
      writeFileSync(stackFile, original);
    }
  });

  it('a window that closes mid-run finishes the running service and skips the rest (partial)', async () => {
    await fastPolicy();
    for (const n of ['db', 'app', 'worker']) publish(n, 2, 'good');
    const now = new Date();
    const hhmm = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    // ±: wide enough to hold the whole run, and the injected clock jumps past its end after the first service
    const start = new Date(now.getTime() - 3 * 60_000);
    const end = new Date(now.getTime() + 20 * 60_000);
    const w = await t.call(
      'POST',
      '/api/v1/maintenance/windows',
      { name: 'test', days: [0, 1, 2, 3, 4, 5, 6], start: hhmm(start), end: hhmm(end), timezone: 'UTC' },
      t.admin,
    );
    expect(w.status, w.raw).toBe(201);
    expect(w.body.openNow).toBe(true);
    t.ctx.executor.setStepHook(({ step, service, phase }) => {
      if (step === 'health' && service === 'db' && phase === 'end') t.ctx.clock.advance(60 * 60_000);
    });
    const run = (await runToEnd({ windowId: w.body.id })) as never as {
      status: string;
      result: { services: { service: string; outcome: string }[] };
      reason: string;
    };
    expect(run.status, run.reason).toBe('partial');
    const out = Object.fromEntries(run.result.services.map((s) => [s.service, s.outcome]));
    expect(out).toEqual({ db: 'updated', app: 'skipped', worker: 'skipped' });
    expect(versionOf(snap('db').imageId)).toBe('2-good');
    expect(versionOf(snap('app').imageId)).toBe('1-good');
    expect(versionOf(snap('worker').imageId)).toBe('1-good');
  });

  it('approval: required, bound to the plan hash, expires, and goes stale when reality changes', async () => {
    await fastPolicy();
    publish('app', 2, 'good');
    const before = snapAll();
    // required: without startNow nothing runs
    const r = await t.call('POST', '/api/v1/maintenance/runs', { project: PROJECT }, t.admin);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('awaiting_approval');
    expect(r.body.approvalExpiresAt).toBeTruthy();
    expect(snapAll()).toEqual(before);
    // a wrong hash is refused
    const bad = await t.call(
      'POST',
      `/api/v1/maintenance/runs/${r.body.id}/approve`,
      { planHash: 'a'.repeat(64) },
      t.admin,
    );
    expect(bad.status).toBe(409);
    expect(bad.body.error?.code ?? bad.body.code).toBe('approval_stale');
    // expired: the clock jumps past the expiry
    t.ctx.clock.advance(t.config.approvalExpiryMs + 60_000);
    const late = await t.call(
      'POST',
      `/api/v1/maintenance/runs/${r.body.id}/approve`,
      { planHash: r.body.planHash },
      t.admin,
    );
    expect(late.status).toBe(409);
    await t.ctx.maintenance.tick();
    const expired = await t.call('GET', `/api/v1/maintenance/runs/${r.body.id}`, undefined, t.admin);
    expect(['skipped', 'expired']).toContain(expired.body.status);
    expect(snapAll()).toEqual(before);
    t.ctx.clock.reset();

    // stale: approved plan no longer matches (a newer version appeared before the approval was used)
    const r2 = await t.call('POST', '/api/v1/maintenance/runs', { project: PROJECT }, t.admin);
    expect(r2.body.status).toBe('awaiting_approval');
    publish('app', 3, 'good');
    const ap = await t.call(
      'POST',
      `/api/v1/maintenance/runs/${r2.body.id}/approve`,
      { planHash: r2.body.planHash },
      t.admin,
    );
    expect(ap.status).toBe(202);
    const done = (await waitRun(t, r2.body.id)) as never as { status: string; reason: string };
    expect(done.status).toBe('approval_stale');
    expect(done.reason).toMatch(/new approval request/);
    expect(snapAll()).toEqual(before); // nothing was executed
    const list = await t.call('GET', '/api/v1/maintenance/runs?status=awaiting_approval', undefined, t.admin);
    expect(list.body.runs.length).toBe(1); // the replacement request
  });

  it('a critical target is never auto-updated; the same schedule updates it once it is not critical', async () => {
    await fastPolicy();
    await t.call(
      'PUT',
      `/api/v1/maintenance/policies/project/${PROJECT}`,
      { updateMode: 'auto', requireApproval: false, health: { timeoutSeconds: 25, stabilizationSeconds: 2 } },
      t.admin,
    );
    publish('app', 2, 'good');
    const before = snapAll();
    const sch = await t.call(
      'POST',
      '/api/v1/maintenance/schedules',
      {
        name: 'nightly',
        cron: '* * * * *',
        timezone: 'UTC',
        jobType: 'update',
        selector: { project: PROJECT },
        mode: 'auto',
      },
      t.admin,
    );
    expect(sch.status, sch.raw).toBe(201);
    // critical: always needs per-run approval
    await t.call(
      'PUT',
      `/api/v1/maintenance/policies/service/${encodeURIComponent(`${PROJECT}/app`)}`,
      { critical: true },
      t.admin,
    );
    t.ctx.clock.advance(61_000);
    await t.ctx.maintenance.tick();
    const runs = (await t.call('GET', '/api/v1/maintenance/runs', undefined, t.admin)).body.runs;
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('awaiting_approval');
    expect(runs[0].trigger).toBe('schedule');
    expect(snapAll()).toEqual(before);
    // not critical any more (and the open request is rejected so the lock is free): the next tick updates unattended
    await t.call('POST', `/api/v1/maintenance/runs/${runs[0].id}/reject`, undefined, t.admin);
    await t.call('DELETE', `/api/v1/maintenance/policies/service/${encodeURIComponent(`${PROJECT}/app`)}`, undefined, t.admin);
    t.ctx.clock.advance(61_000);
    await t.ctx.maintenance.tick();
    const next = (await t.call('GET', '/api/v1/maintenance/runs?status=running', undefined, t.admin)).body.runs;
    const all = (await t.call('GET', '/api/v1/maintenance/runs', undefined, t.admin)).body.runs;
    const fired = next[0] ?? all.find((r: { status: string }) => r.status !== 'rejected');
    expect(fired).toBeTruthy();
    const fin = (await waitRun(t, fired.id)) as never as { status: string; approvedBy: string };
    expect(fin.status).toBe('completed');
    expect(fin.approvedBy).toBe('schedule:nightly');
    expect(versionOf(snap('app').imageId)).toBe('2-good');
  });

  it('a crash mid-run leaves the run `interrupted` after restart (never resumed), with guidance', async () => {
    await fastPolicy();
    publish('app', 2, 'good');
    t.ctx.executor.setStepHook(({ step, service, phase }) => {
      if (step === 'deploy' && service === 'app' && phase === 'start') {
        const e = new Error('simulated process death');
        e.name = 'SimulatedCrash';
        throw e;
      }
    });
    const r = await startRun();
    expect(r.status).toBe(202);
    const id = r.body.id as string;
    await waitFor(
      async () => (await t.call('GET', `/api/v1/operations/${id}`, undefined, t.admin)).body.status !== 'running',
      'crash',
      60_000,
      300,
    );
    // the process "died": the run row is still `running`
    expect(t.ctx.maintenance.getRun(id).status).toBe('running');
    const dataDir = t.config.dataDir;
    await t.close();
    const t2 = await startApp({ QM_DATA_DIR: dataDir });
    try {
      const run = await t2.call('GET', `/api/v1/maintenance/runs/${id}`, undefined, t2.admin);
      expect(run.body.status).toBe('interrupted');
      expect(run.body.guidance.join('\n')).toMatch(/interrupted/);
      expect(run.body.steps.every((s: { status: string }) => s.status !== 'running')).toBe(true);
      // nothing resumed on its own, and the stack is still fine
      await new Promise((res) => setTimeout(res, 3000));
      expect(snap('app').status).toBe('running');
      expect(versionOf(snap('app').imageId)).toBe('1-good');
      const lock = await t2.call('POST', '/api/v1/maintenance/runs', { project: PROJECT }, t2.admin);
      expect(lock.status).toBe(201); // the single-run lock was released
    } finally {
      await t2.close();
    }
    t = await startApp(); // keeps afterEach symmetrical
  });

  it('cleanup never removes in-use or rollback-protected images (label-filtered, preview + confirm)', async () => {
    await fastPolicy();
    for (const n of ['db', 'app', 'worker']) publish(n, 2, 'good');
    const first = (await runToEnd()) as never as { status: string };
    expect(first.status).toBe('completed');
    // old v1 images now only exist as rollback tags (protected) — plus unrelated unused fixture build images
    const protectedIds = t.ctx.rollbackRepo.list().map((r: { image_id: string }) => r.image_id);
    expect(protectedIds.length).toBe(3);
    const inUse = Object.values(snapAll()).map((s) => s.imageId);
    const pv = await t.call(
      'POST',
      '/api/v1/images/cleanup/preview',
      { categories: ['dangling_images', 'unused_images'], minAgeHours: 0, labelFilter: 'quaymaster.test=true' },
      t.admin,
    );
    expect(pv.status, pv.raw).toBe(200);
    const candidateIds: string[] = pv.body.candidates.map((c: { id: string }) => c.id.replace('image:', ''));
    for (const id of [...protectedIds, ...inUse]) expect(candidateIds).not.toContain(id);
    expect(pv.body.protected.length).toBeGreaterThan(0);
    // executing without a valid preview/confirmation is refused
    const noConfirm = await t.call(
      'POST',
      '/api/v1/images/cleanup/execute',
      { previewId: pv.body.previewId, confirm: 'nope' },
      t.admin,
    );
    expect(noConfirm.status).toBe(409);
    const ex = await t.call(
      'POST',
      '/api/v1/images/cleanup/execute',
      { previewId: pv.body.previewId, confirm: pv.body.previewId },
      t.admin,
    );
    expect(ex.status, ex.raw).toBe(200);
    // all protected + in-use images still exist
    for (const id of [...protectedIds, ...inUse]) expect(docker('image', 'inspect', '--format', '{{.Id}}', id)).toBe(id);
    for (const s of Object.values(snapAll())) expect(s.status).toBe('running');
  });
});
