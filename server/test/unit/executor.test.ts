import { afterEach, describe, expect, it } from 'vitest';
import type { Plan, PlanService } from '@quaymaster/shared';
import { openDatabase, type OpenedDb } from '../../src/db/connection.js';
import { RunsRepo, WindowsRepo } from '../../src/db/maintenance.js';
import { QuarantineRepo, RollbackRepo, StagedRepo } from '../../src/db/updates.js';
import { AdjustableClock } from '../../src/maintenance/clock.js';
import { RunExecutor } from '../../src/maintenance/executor.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- fakes implement only what the executor touches */

const LABEL_SERVICE = 'com.docker.compose.service';
const DIGEST = (n: number): string => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const IMG_OLD = 'sha256:' + 'a'.repeat(64);
const IMG_NEW = 'sha256:' + 'b'.repeat(64);
const IMG_BAD = 'sha256:' + 'c'.repeat(64);

function svc(name: string, over: Partial<PlanService> = {}): PlanService {
  return {
    service: name,
    role: 'update',
    containers: [{ id: `old-${name}`, name: `p-${name}-1` }],
    ref: `registry.test/${name}:latest`,
    fromImageId: IMG_OLD,
    fromDigest: DIGEST(1),
    toDigest: DIGEST(2),
    configHash: 'h',
    wasRunning: true,
    oneShot: false,
    autoRollback: true,
    autoRollbackReason: 'stateless',
    health: { kind: 'healthcheck', timeoutSeconds: 2, stabilizationSeconds: 0, probe: null },
    downtime: 'brief downtime',
    dataRisk: { flagged: false, mounts: [], note: '' },
    critical: false,
    requireApproval: true,
    updateMode: 'notify',
    unattended: { eligible: false, blockers: [] },
    quarantined: false,
    ...over,
  };
}

function plan(services: PlanService[]): Plan {
  return {
    version: 1,
    kind: 'compose',
    target: 'p',
    createdAt: new Date().toISOString(),
    order: services.map((s) => s.service),
    services,
    excluded: [],
    preflight: { ok: true, checks: [] },
    validation: { valid: true, errors: [], warnings: [] },
    drift: [],
    impact: { dependents: [], sharedTag: [], volumes: [] } as any,
    disk: { requiredBytes: null, freeBytes: null, floorBytes: 0, ok: true },
    blocked: null,
    warnings: [],
    planHash: 'f'.repeat(64),
  };
}

/** An in-memory "Docker + Compose": containers by service, tags → image IDs, and a registry of image behaviours. */
class World {
  tags = new Map<string, string>();
  containers = new Map<
    string,
    { Id: string; ImageID: string; State: string; Labels: Record<string, string> }
  >();
  seq = 0;
  booted = false;
  deploys: string[] = [];
  pulls: string[] = [];
  pullFails = false;
  /** Image IDs whose containers never become healthy. */
  unhealthy = new Set<string>();
  constructor(services: string[]) {
    for (const s of services) this.add(s, IMG_OLD);
    this.booted = true;
  }
  add(service: string, image: string): void {
    for (const [id, c] of this.containers)
      if (c.Labels[LABEL_SERVICE] === service) this.containers.delete(id);
    const id = this.booted ? `c${++this.seq}-${service}` : `old-${service}`;
    this.containers.set(id, {
      Id: id,
      ImageID: image,
      State: 'running',
      Labels: { [LABEL_SERVICE]: service },
    });
  }
  compose(): any {
    return {
      targetOf: async () => ({ target: { projectName: 'p', workingDir: '/x', files: ['/x/compose.yaml'] } }),
      projectContainers: async () => [...this.containers.values()],
      deployServices: async (_t: unknown, o: { services: string[] }) => {
        for (const s of o.services) {
          const repoTag = [...this.tags.keys()].find((k) => k.includes(`/${s}:`)) ?? '';
          this.deploys.push(`${s}->${this.tags.get(repoTag)}`);
          this.add(s, this.tags.get(repoTag) ?? IMG_OLD);
        }
        return { code: 0, timedOut: false, stderrTail: '', argv: ['compose', 'up'] };
      },
      resolvedConfig: async () => ({ config: {} }),
      invalidate: () => undefined,
      detail: async () => ({ graph: { edges: [] } }),
    };
  }
  images(): any {
    return {
      tag: async (id: string, repoTag: string) => void this.tags.set(repoTag, id),
      inspect: async (name: string) => {
        const id = this.tags.get(name) ?? (name.startsWith('sha256:') ? name : null);
        return id ? { Id: id } : null;
      },
      pullByDigest: async (ref: { repo: string }, digest: string) => {
        this.pulls.push(`${ref.repo}@${digest}`);
        if (this.pullFails) throw new Error('registry unreachable');
        return { imageId: this.unhealthy.has(IMG_BAD) ? IMG_BAD : IMG_NEW };
      },
      remove: async (name: string) => void this.tags.delete(name),
    };
  }
  docker(): any {
    return {
      getContainer: (id: string) => ({
        inspect: async () => {
          const c = this.containers.get(id);
          if (!c) throw Object.assign(new Error('gone'), { statusCode: 404 });
          return {
            Image: c.ImageID,
            RestartCount: 0,
            State: {
              Status: 'running',
              Running: true,
              Restarting: false,
              ExitCode: 0,
              StartedAt: 't',
              Health: { Status: this.unhealthy.has(c.ImageID) ? 'unhealthy' : 'healthy' },
            },
          };
        },
      }),
    };
  }
}

describe('RunExecutor state machine (fake Docker)', () => {
  let opened: OpenedDb | undefined;
  afterEach(() => opened?.close());

  function setup(services: PlanService[], world: World, opts: { fresh?: Plan } = {}) {
    opened = openDatabase(':memory:');
    const db = opened.db;
    db.prepare(
      "INSERT INTO operations (id, kind, target, status, actor, started_at) VALUES ('r1','maintenance.update','p','running','t',0)",
    ).run();
    const runs = new RunsRepo(db);
    const rollback = new RollbackRepo(db);
    const quarantine = new QuarantineRepo(db);
    const p = plan(services);
    const notes: string[] = [];
    const audits: string[] = [];
    const ex = new RunExecutor({
      compose: world.compose(),
      docker: world.docker(),
      images: world.images(),
      updates: { statuses: async () => [] } as any,
      planner: { planProject: async () => opts.fresh ?? p } as any,
      runs,
      windows: new WindowsRepo(db),
      rollback,
      staged: new StagedRepo(db),
      quarantine,
      audit: { record: (e: { action: string }) => void audits.push(e.action) } as any,
      notify: (e) => void notes.push(e.type),
      config: { rollbackRetentionMs: 86_400_000 },
      clock: new AdjustableClock(),
      log: { error: () => undefined, warn: () => undefined } as any,
      health: { pollMs: 1, sleep: async () => undefined },
    });
    runs.create({
      id: 'r1',
      kind: 'update',
      trigger: 'manual',
      target: 'p',
      status: 'awaiting_approval',
      plan: p,
      requestedBy: 't',
    });
    runs.approve('r1', 't', p.planHash);
    const ctx = { id: 'r1', log: () => undefined } as any;
    const exec = () => ex.execute('r1', ctx, () => 'new-request');
    const steps = () => runs.steps('r1').map((s) => `${s.service ?? '-'}:${s.step}:${s.status}`);
    return { exec, runs, rollback, quarantine, notes, audits, steps };
  }

  it('updates in plan order, persisting every step and a recovery point per service', async () => {
    const world = new World(['db', 'app']);
    const t = setup([svc('db'), svc('app')], world);
    const st = await t.exec();
    expect(st, t.runs.get('r1')?.reason ?? '').toBe('completed');
    expect(world.deploys).toEqual([`db->${IMG_NEW}`, `app->${IMG_NEW}`]);
    const steps = t.steps();
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
      'app:health:succeeded',
      '-:record:succeeded',
    ])
      expect(steps).toContain(s);
    expect(steps.indexOf('db:health:succeeded')).toBeLessThan(steps.indexOf('app:deploy:succeeded'));
    expect(
      t.rollback
        .forRun('r1')
        .map((r) => r.service)
        .sort(),
    ).toEqual(['app', 'db']);
    expect(t.rollback.forRun('r1').every((r) => r.image_id === IMG_OLD)).toBe(true);
    expect(t.runs.get('r1')?.status).toBe('completed');
    expect(t.notes).toEqual(['run.succeeded']);
    expect(t.audits).toContain('maintenance.run.finish');
  });

  it('a failed health gate rolls back to the recorded previous image and skips the rest', async () => {
    const world = new World(['db', 'app']);
    world.unhealthy.add(IMG_BAD);
    // the pull yields a bad image
    const t = setup([svc('db'), svc('app')], world);
    expect(await t.exec()).toBe('rolled_back');
    // db was the first service: it got the bad image, failed, was redeployed on the OLD image id
    expect(world.deploys).toEqual([`db->${IMG_BAD}`, `db->${IMG_OLD}`]);
    const result = t.runs.get('r1')?.result;
    expect(result?.services.map((s) => `${s.service}:${s.outcome}`)).toEqual([
      'db:rolled_back',
      'app:skipped',
    ]);
    expect(t.steps()).toEqual(expect.arrayContaining(['db:health:failed', 'db:rollback:succeeded']));
    expect(t.notes).toContain('run.rolled_back');
  });

  it('without automatic rollback the run fails with exact recovery commands', async () => {
    const world = new World(['db']);
    world.unhealthy.add(IMG_BAD);
    const t = setup([svc('db', { autoRollback: false, autoRollbackReason: 'has a volume' })], world);
    expect(await t.exec()).toBe('failed');
    expect(world.deploys).toEqual([`db->${IMG_BAD}`]); // never rolled back
    const run = t.runs.get('r1');
    expect(run?.result?.services[0]?.outcome).toBe('failed_left_as_is');
    const g = (run?.guidance ?? []).join('\n');
    expect(g).toContain(`docker tag ${IMG_OLD}`);
    expect(g).toContain('--pull never');
    expect(t.notes).toContain('run.failed');
  });

  it('a pull failure stops before any deploy', async () => {
    const world = new World(['db']);
    world.pullFails = true;
    const t = setup([svc('db')], world);
    expect(await t.exec()).toBe('failed');
    expect(world.deploys).toEqual([]);
    expect(t.steps()).toContain('-:pull:failed');
    expect(t.runs.get('r1')?.reason).toMatch(/Nothing was restarted/);
  });

  it('a plan that changed since approval is never executed (approval_stale + new request)', async () => {
    const world = new World(['db']);
    const changed = plan([svc('db', { toDigest: DIGEST(9) })]);
    changed.planHash = 'e'.repeat(64);
    const t = setup([svc('db')], world, { fresh: changed });
    expect(await t.exec()).toBe('approval_stale');
    expect(world.deploys).toEqual([]);
    expect(world.pulls).toEqual([]);
    expect(t.runs.get('r1')?.reason).toMatch(/new approval request was created \(new-request\)/);
  });

  it('aborts without rolling back when another tool changed the service during the run', async () => {
    const world = new World(['db', 'app']);
    const t = setup([svc('db'), svc('app')], world);
    // another manager recreates "app" right after db was deployed
    const original = world.compose().deployServices;
    void original;
    const ex = (t as any).exec;
    const hook = world.add.bind(world);
    let tampered = false;
    world.add = (service: string, image: string) => {
      hook(service, image);
      if (service === 'db' && !tampered) {
        tampered = true;
        hook('app', IMG_OLD); // new container id for app, same image
      }
    };
    expect(await ex()).toBe('failed');
    expect(world.deploys).toEqual([`db->${IMG_NEW}`]);
    expect(t.runs.get('r1')?.reason).toMatch(/Another tool changed app/);
    expect(t.notes).toContain('run.conflict');
  });
});

void DIGEST;
