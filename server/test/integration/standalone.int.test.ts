import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, waitFor, waitOperation, type TestApp } from '../helpers/app.js';
import {
  IMG,
  docker,
  publish,
  registryDown,
  registryUp,
  updDown,
  updUp,
  versionOf,
} from '../helpers/updates.js';

/**
 * Standalone container update by config clone (RT-12) against the real daemon and the fixture registry.
 * The container is qmtest-sa (qmtest-* + quaymaster.test=true); everything is removed afterwards.
 */
describe('standalone container update (config clone, real Docker)', { timeout: 240_000 }, () => {
  let t: TestApp;
  const NAME = 'qmtest-sa';

  const rmAll = (): void => {
    const names = docker(
      'ps',
      '-a',
      '--filter',
      `name=${NAME}`,
      '--filter',
      'label=quaymaster.test=true',
      '--format',
      '{{.Names}}',
    );
    for (const n of names.split('\n').filter((x) => x.startsWith('qmtest-sa'))) docker('rm', '-f', '-v', n);
  };
  const info = (
    ref: string,
  ): { id: string; image: string; running: boolean; env: string[]; mounts: string[]; health: string } => {
    const o = JSON.parse(docker('inspect', ref)) as {
      Id: string;
      Image: string;
      State: { Running: boolean; Health?: { Status: string } };
      Config: { Env: string[] };
      Mounts: { Name?: string; Destination: string }[];
    }[];
    const c = o[0]!;
    return {
      id: c.Id,
      image: c.Image,
      running: c.State.Running,
      env: c.Config.Env,
      mounts: c.Mounts.map((m) => `${m.Name ?? ''}:${m.Destination}`),
      health: c.State.Health?.Status ?? '',
    };
  };

  beforeAll(async () => {
    updDown();
    registryUp();
    publish('app', 1, 'good');
    docker('pull', '--quiet', IMG('app'));
    rmAll();
    docker(
      'run',
      '-d',
      '--name',
      NAME,
      '--label',
      'quaymaster.test=true',
      '--init',
      '--stop-timeout',
      '2',
      '-v',
      '/data',
      '-e',
      'FOO=bar',
      '--health-cmd',
      'test -f /tmp/ready',
      '--health-interval',
      '2s',
      '--health-retries',
      '3',
      '--health-start-period',
      '1s',
      '--pull',
      'never',
      IMG('app'),
    );
    await waitFor(() => info(NAME).health === 'healthy', 'standalone healthy', 60_000, 500);
    t = await startApp();
    t.ctx.executor.setHealthOptions({ pollMs: 500 });
    await t.call(
      'PUT',
      `/api/v1/maintenance/policies/container/${NAME}`,
      { health: { timeoutSeconds: 25, stabilizationSeconds: 2 } },
      t.admin,
    );
  }, 240_000);
  afterAll(async () => {
    await t?.close();
    rmAll();
    updDown();
    registryDown();
  }, 120_000);

  const runUpdate = async (confirm = NAME) => {
    const r = await t.call('POST', '/api/v1/maintenance/standalone', { container: NAME, confirm }, t.admin);
    return r;
  };
  const finish = async (id: string) => {
    const op = await waitOperation(t, id, 150_000);
    const run = await t.call('GET', `/api/v1/maintenance/runs/${id}`, undefined, t.admin);
    return { op, run: run.body };
  };

  it('requires a typed confirmation and refuses when there is nothing to update', async () => {
    const before = info(NAME);
    expect((await runUpdate('wrong')).status).toBe(409);
    const nothing = await runUpdate();
    expect(nothing.status).toBe(409); // up to date
    expect(info(NAME)).toEqual(before);
  });

  it('clones the container onto the new image: env, anonymous volume and name survive; the old one is kept stopped', async () => {
    const before = info(NAME);
    publish('app', 2, 'good');
    const r = await runUpdate();
    expect(r.status, r.raw).toBe(202);
    const { run } = await finish(r.body.id);
    expect(run.status, run.reason).toBe('completed');
    const after = info(NAME);
    expect(after.id).not.toBe(before.id);
    expect(versionOf(after.image)).toBe('2-good');
    expect(after.running).toBe(true);
    expect(after.health).toBe('healthy');
    expect(after.env).toContain('FOO=bar');
    // the data volume is the SAME anonymous volume (re-attached by name, RT-12)
    expect(after.mounts.filter((m) => m.endsWith(':/data'))).toEqual(
      before.mounts.filter((m) => m.endsWith(':/data')),
    );
    // the old container is still there, stopped, as a recovery point
    const old = docker('ps', '-a', '--filter', `name=${NAME}-qm-old-`, '--format', '{{.Names}}');
    expect(old).toMatch(/^qmtest-sa-qm-old-\d+$/);
    expect(info(old).running).toBe(false);
    expect(info(old).id).toBe(before.id);
    // never unattended: schedules refuse auto mode for containers
    const bad = await t.call(
      'POST',
      '/api/v1/maintenance/schedules',
      {
        name: 'x',
        cron: '0 3 * * *',
        timezone: 'UTC',
        jobType: 'update',
        selector: { container: NAME },
        mode: 'auto',
      },
      t.admin,
    );
    expect(bad.status).toBe(400);
  });

  it('a clone that fails its health gate is removed and the previous container is running again', async () => {
    const before = info(NAME);
    publish('app', 3, 'unhealthy');
    const r = await runUpdate();
    expect(r.status, r.raw).toBe(202);
    const { run } = await finish(r.body.id);
    expect(run.status, run.reason).toBe('rolled_back');
    const after = info(NAME);
    expect(after.id).toBe(before.id); // the original container is back, not a copy
    expect(after.running).toBe(true);
    expect(versionOf(after.image)).toBe('2-good');
    expect(docker('image', 'inspect', '--format', '{{.Id}}', IMG('app'))).toBe(before.image);
    const leftovers = docker('ps', '-a', '--filter', 'name=qmtest-sa-qm-new-', '--format', '{{.Names}}');
    expect(leftovers).toBe('');
  });
});
