import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STACKS_DIR, startApp, waitFor, type TestApp } from '../helpers/app.js';
import {
  IMG,
  PROJECT,
  docker,
  publish,
  snap,
  stackFile,
  stepLog,
  updDown,
  updUp,
  versionOf,
  waitRun,
} from '../helpers/updates.js';

/**
 * Red-team audit 01b (docs/reviews/01b-update-engine-audit.md): the demonstrations of F-01..F-06, now REGRESSION tests.
 *
 * Each test asserts the behaviour the specification requires; they failed before phase 2c.
 * Fixtures only: every resource is qmtest-* and labelled quaymaster.test=true.
 */

const NS_PROJECT = 'qmtest-audns';
const NS_DIR = path.join(STACKS_DIR, NS_PROJECT);
const OOS = 'qmtest-oos';

function nsUp(yaml?: string): void {
  mkdirSync(NS_DIR, { recursive: true });
  writeFileSync(
    path.join(NS_DIR, 'compose.yaml'),
    yaml ??
      `name: ${NS_PROJECT}
services:
  provider:
    image: ${IMG('app')}
    pull_policy: never
    init: true
    stop_grace_period: 2s
    labels: { quaymaster.test: "true" }
  consumer:
    # current in the fixture registry (no update): it is in the plan only as a namespace dependent
    image: ${IMG('db')}
    pull_policy: never
    init: true
    stop_grace_period: 2s
    network_mode: "service:provider"
    depends_on: [provider]
    labels: { quaymaster.test: "true" }
`,
  );
  compose(['up', '--detach', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '60']);
}
function compose(args: string[]): string {
  return execFileSync(
    'docker',
    [
      'compose',
      '--project-name',
      NS_PROJECT,
      '--project-directory',
      NS_DIR,
      '--file',
      path.join(NS_DIR, 'compose.yaml'),
      ...args,
    ],
    { stdio: 'pipe', encoding: 'utf8', timeout: 120_000 },
  );
}
function nsDown(): void {
  try {
    compose(['down', '--volumes', '--timeout', '2']);
  } catch {
    /* not up */
  }
  rmSync(NS_DIR, { recursive: true, force: true });
}
const cid = (name: string): string => docker('inspect', '--format', '{{.Id}}', name);
const tagId = (ref: string): string => docker('image', 'inspect', '--format', '{{.Id}}', ref);

describe('audit 01b regressions: update engine (fixtures only)', { timeout: 300_000 }, () => {
  let t: TestApp;
  const extraCleanup: (() => void)[] = [];

  beforeEach(async () => {
    updDown();
    updUp();
  }, 300_000);
  afterEach(async () => {
    t?.ctx.executor.setStepHook(undefined);
    await t?.close().catch(() => undefined);
    for (const f of extraCleanup.splice(0)) {
      try {
        f();
      } catch {
        /* best effort */
      }
    }
    updDown();
  }, 180_000);

  const autoSchedule = async (project: string) => {
    await t.call(
      'PUT',
      `/api/v1/maintenance/policies/project/${project}`,
      { updateMode: 'auto', requireApproval: false, health: { timeoutSeconds: 25, stabilizationSeconds: 2 } },
      t.admin,
    );
    const sch = await t.call(
      'POST',
      '/api/v1/maintenance/schedules',
      {
        name: `audit-${project}`,
        cron: '* * * * *',
        timezone: 'UTC',
        jobType: 'update',
        selector: { project },
        mode: 'auto',
      },
      t.admin,
    );
    expect(sch.status, sch.raw).toBe(201);
  };
  const fireSchedule = async () => {
    t.ctx.clock.advance(61_000);
    await t.ctx.maintenance.tick();
    const runs = (await t.call('GET', '/api/v1/maintenance/runs', undefined, t.admin)).body.runs as {
      id: string;
      status: string;
    }[];
    expect(runs.length).toBeGreaterThan(0);
    return runs[0] as { id: string; status: string };
  };

  it('F-01 (RT-01): a Compose edit made DURING an auto run is applied to the next service without the drift gate', async () => {
    t = await startApp();
    t.ctx.executor.setHealthOptions({ pollMs: 500 });
    await autoSchedule(PROJECT);
    publish('app', 2, 'good');
    publish('worker', 2, 'good');
    const original = readFileSync(stackFile, 'utf8');
    extraCleanup.push(() => writeFileSync(stackFile, original));
    t.ctx.executor.setStepHook(({ step, service, phase }) => {
      // an operator (or Dockge) edits the file while app is in its health gate
      if (step === 'health' && service === 'app' && phase === 'start')
        writeFileSync(
          stackFile,
          original.replace(
            '  worker:\n    image: 127.0.0.1:5055/qmtest-worker:latest\n',
            '  worker:\n    image: 127.0.0.1:5055/qmtest-worker:latest\n    environment:\n      QM_AUDIT_DRIFT: "privileged-change"\n',
          ),
        );
    });
    const fired = await fireSchedule();
    const run = (await waitRun(t, fired.id)) as never as {
      status: string;
      approvedBy: string;
      steps: { service: string | null; step: string; status: string }[];
    };
    const env = docker('inspect', '--format', '{{json .Config.Env}}', 'qmtest-upd-worker-1');

    console.log('F-01', run.status, run.approvedBy, stepLog(run).join(' '), env);
    expect(
      env,
      `unattended run ${run.status} (approved by ${run.approvedBy}) recreated worker WITH the unreviewed edit`,
    ).not.toContain('QM_AUDIT_DRIFT');
  });

  it('F-02 (RT-14): a crash during the health gate is reported as "before any container was changed"; no left-down alert', async () => {
    t = await startApp();
    t.ctx.executor.setHealthOptions({ pollMs: 500 });
    await t.call(
      'PUT',
      `/api/v1/maintenance/policies/project/${PROJECT}`,
      { health: { timeoutSeconds: 25, stabilizationSeconds: 2 } },
      t.admin,
    );
    publish('app', 2, 'crash');
    const tagBefore = tagId(IMG('app'));
    t.ctx.executor.setStepHook(({ step, service, phase }) => {
      if (step === 'health' && service === 'app' && phase === 'start') {
        const e = new Error('simulated process death during the health gate');
        e.name = 'SimulatedCrash';
        throw e;
      }
    });
    const r = await t.call(
      'POST',
      '/api/v1/maintenance/runs',
      { project: PROJECT, services: ['app'], startNow: true, confirm: PROJECT },
      t.admin,
    );
    expect(r.status, r.raw).toBe(202);
    const id = r.body.id as string;
    await waitFor(
      async () =>
        (await t.call('GET', `/api/v1/operations/${id}`, undefined, t.admin)).body.status !== 'running',
      'crash',
      60_000,
      300,
    );
    const dataDir = t.config.dataDir;
    await t.close();
    const t2 = await startApp({ QM_DATA_DIR: dataDir });
    try {
      const run = await t2.call('GET', `/api/v1/maintenance/runs/${id}`, undefined, t2.admin);
      const audit = await t2.call(
        'GET',
        '/api/v1/audit?action=maintenance.run.interrupted',
        undefined,
        t2.admin,
      );
      const app = snap('app');

      console.log(
        'F-02',
        run.body.status,
        JSON.stringify(run.body.guidance),
        JSON.stringify(audit.body.entries?.[0]?.params),
        `app=${app.status}/${versionOf(app.imageId)}`,
        `tag moved=${tagId(IMG('app')) !== tagBefore}`,
      );
      expect(app.status).not.toBe('running'); // precondition: the service really is down
      expect(run.body.guidance.join('\n')).toMatch(/NOT running/);
      expect(audit.body.entries?.[0]?.params?.leftDown).toBe(true);
    } finally {
      await t2.close();
    }
    t = await startApp();
  });

  it('F-03 (RT-14): after SIGTERM-style shutdown starts, the executor keeps starting new deploy steps', async () => {
    t = await startApp();
    t.ctx.executor.setHealthOptions({ pollMs: 500 });
    await t.call(
      'PUT',
      `/api/v1/maintenance/policies/project/${PROJECT}`,
      { health: { timeoutSeconds: 25, stabilizationSeconds: 2 } },
      t.admin,
    );
    for (const n of ['db', 'app', 'worker']) publish(n, 2, 'good');
    let shutdownAt = 0;
    let shutdown: Promise<void> | null = null;
    const starts: { step: string; service: string | null; at: number }[] = [];
    t.ctx.executor.setStepHook(({ step, service, phase }) => {
      if (phase === 'start') starts.push({ step, service, at: Date.now() });
      if (step === 'deploy' && service === 'db' && phase === 'end' && !shutdown) {
        shutdownAt = Date.now();
        shutdown = t.ctx.shutdown(); // what index.ts does on SIGTERM (after app.close())
      }
    });
    const r = await t.call(
      'POST',
      '/api/v1/maintenance/runs',
      { project: PROJECT, startNow: true, confirm: PROJECT },
      t.admin,
    );
    expect(r.status, r.raw).toBe(202);
    await waitFor(async () => shutdown !== null, 'shutdown triggered', 120_000, 200);
    await shutdown;
    const after = starts.filter((s) => s.at > shutdownAt && s.step === 'deploy').map((s) => s.service);

    console.log('F-03 deploy steps started after shutdown began:', after, 'versions:', {
      db: versionOf(snap('db').imageId),
      app: versionOf(snap('app').imageId),
      worker: versionOf(snap('worker').imageId),
    });
    expect(after, 'no new service deploy may start once shutdown has begun').toEqual([]);
  });

  it('F-04 (RT-07): "docker compose pull" through the API is refused and the user-visible tag does not move', async () => {
    t = await startApp();
    extraCleanup.push(nsDown);
    // a normal project: no pull_policy pin (qmtest-upd pins `never`, which `compose pull` skips)
    nsUp(`name: ${NS_PROJECT}
services:
  web:
    image: ${IMG('worker')}
    init: true
    stop_grace_period: 2s
    labels: { quaymaster.test: "true" }
`);
    publish('worker', 2, 'good');
    const before = tagId(IMG('worker'));
    const r = await t.call(
      'POST',
      `/api/v1/compose/projects/${NS_PROJECT}/actions/pull`,
      { service: 'web' },
      t.admin,
    );
    expect(r.status, r.raw).toBe(400); // `pull` is no longer an action
    const after = tagId(IMG('worker'));
    expect(after, 'a pull must never move the user-visible tag (RT-07)').toBe(before);
  });

  it('F-05 (RT-03): with scope qmtest-upd*, an update run moves a tag an OUT-OF-SCOPE container uses, and the image_pull job pulls for an out-of-scope container', async () => {
    t = await startApp({ QM_MANAGED_SCOPE: 'qmtest-upd*' });
    t.ctx.executor.setHealthOptions({ pollMs: 500 });
    // out-of-scope container sharing qmtest-upd's app tag
    docker(
      'run',
      '-d',
      '--name',
      `${OOS}-shared`,
      '--label',
      'quaymaster.test=true',
      '--init',
      '--pull',
      'never',
      IMG('app'),
    );
    // out-of-scope container with its own image
    publish('oos', 1, 'good');
    docker('pull', '--quiet', IMG('oos'));
    docker(
      'run',
      '-d',
      '--name',
      OOS,
      '--label',
      'quaymaster.test=true',
      '--init',
      '--pull',
      'never',
      IMG('oos'),
    );
    extraCleanup.push(() => {
      for (const c of [OOS, `${OOS}-shared`]) {
        try {
          docker('rm', '-f', c);
        } catch {
          /* gone */
        }
      }
      for (const i of docker(
        'image',
        'ls',
        '--filter',
        'label=quaymaster.test=true',
        '--format',
        '{{.Repository}}:{{.Tag}}',
      )
        .split('\n')
        .filter((x) => x.includes('qmtest-oos') || x.startsWith('quaymaster-staged/'))) {
        try {
          docker('image', 'rm', i);
        } catch {
          /* in use or gone */
        }
      }
    });
    await t.call(
      'PUT',
      `/api/v1/maintenance/policies/project/${PROJECT}`,
      { health: { timeoutSeconds: 25, stabilizationSeconds: 2 } },
      t.admin,
    );
    // (a) the update run
    publish('app', 2, 'good');
    const before = tagId(IMG('app'));
    const r = await t.call(
      'POST',
      '/api/v1/maintenance/runs',
      { project: PROJECT, services: ['app'], startNow: true, confirm: PROJECT },
      t.admin,
    );
    expect(r.status, r.raw).toBe(201); // refused at preflight: the run is created as `blocked`
    const run = (await waitRun(t, r.body.id)) as never as {
      status: string;
      plan: { impact: { sharedTag: { containerName: string }[] } };
    };
    const after = tagId(IMG('app'));
    // (b) the scheduled image_pull job for an out-of-scope container
    const pol = await t.call(
      'PUT',
      `/api/v1/maintenance/policies/container/${OOS}`,
      { updateMode: 'pull_only' },
      t.admin,
    );
    publish('oos', 2, 'good');
    const sch = await t.call(
      'POST',
      '/api/v1/maintenance/schedules',
      {
        name: 'audit-pull',
        cron: '* * * * *',
        timezone: 'UTC',
        jobType: 'image_pull',
        selector: {},
        mode: 'auto',
      },
      t.admin,
    );
    expect(sch.status, sch.raw).toBe(201);
    t.ctx.clock.advance(61_000);
    await t.ctx.maintenance.tick();
    const staged = (await t.call('GET', '/api/v1/images/staged', undefined, t.admin)).body.staged as {
      ref: string;
    }[];

    console.log(
      'F-05',
      `run=${run.status}`,
      `sharedTag=${JSON.stringify(run.plan.impact.sharedTag.map((s) => s.containerName))}`,
      `tag moved=${after !== before}`,
      `policy put on out-of-scope container=${pol.status}`,
      `staged=${JSON.stringify(staged.map((s) => s.ref))}`,
    );
    expect(after !== before && run.status === 'completed', 'tag of an out-of-scope container was moved').toBe(
      false,
    );
    expect(
      staged.some((s) => s.ref.includes('qmtest-oos')),
      'background pull for an out-of-scope container',
    ).toBe(false);
  });

  it('F-06 (RT-11/RT-23): an unattended run recreates a CRITICAL namespace dependent without approval', async () => {
    t = await startApp();
    t.ctx.executor.setHealthOptions({ pollMs: 500 });
    extraCleanup.push(nsDown);
    nsUp();
    await autoSchedule(NS_PROJECT);
    await t.call(
      'PUT',
      `/api/v1/maintenance/policies/service/${encodeURIComponent(`${NS_PROJECT}/consumer`)}`,
      { critical: true },
      t.admin,
    );
    const consumerBefore = cid(`${NS_PROJECT}-consumer-1`);
    publish('app', 2, 'good');
    const fired = await fireSchedule();
    const run = (await waitRun(t, fired.id)) as never as {
      status: string;
      reason: string | null;
      approvedBy: string | null;
      plan: { services: { service: string; role: string; critical: boolean }[] };
    };
    const consumerAfter = cid(`${NS_PROJECT}-consumer-1`);

    console.log(
      'F-06',
      run.status,
      run.reason,
      `approvedBy=${run.approvedBy}`,
      JSON.stringify(run.plan.services.map((s) => [s.service, s.role, s.critical])),
      `consumer recreated=${consumerAfter !== consumerBefore}`,
    );
    expect(
      run.status === 'completed' && consumerAfter !== consumerBefore,
      'a critical service was recreated by an unattended run',
    ).toBe(false);
  });
});
