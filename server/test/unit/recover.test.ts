import { afterEach, describe, expect, it } from 'vitest';
import type { NotificationEvent, Plan, PlanService } from '@quaymaster/shared';
import { openDatabase, type OpenedDb } from '../../src/db/connection.js';
import { RunsRepo } from '../../src/db/maintenance.js';
import { MaintenanceService } from '../../src/maintenance/service.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- partial fakes of Docker list entries and services */

const IMG_OLD = 'sha256:' + 'a'.repeat(64);
const IMG_NEW = 'sha256:' + 'b'.repeat(64);

const planFor = (): Plan =>
  ({
    version: 1,
    kind: 'compose',
    target: 'p',
    order: ['db'],
    services: [
      {
        service: 'db',
        role: 'update',
        ref: 'registry.test/db:latest',
        fromImageId: IMG_OLD,
        containers: [],
      } as unknown as PlanService,
    ],
    planHash: 'f'.repeat(64),
  }) as unknown as Plan;

describe('crash recovery (RT-14): truthful reports from the live state', () => {
  let opened: OpenedDb | undefined;
  afterEach(() => opened?.close());

  function setup(containers: any[]) {
    opened = openDatabase(':memory:');
    const db = opened.db;
    for (const id of ['r1', 'r2'])
      db.prepare(
        "INSERT INTO operations (id, kind, target, status, actor, started_at) VALUES (?, 'maintenance.update','p','running','t',0)",
      ).run(id);
    const runs = new RunsRepo(db);
    const notes: NotificationEvent[] = [];
    const audits: { action: string; params?: any }[] = [];
    const svc = new MaintenanceService({
      runs,
      containers: { listRaw: async () => containers },
      compose: {
        targetOf: async () => ({
          target: { projectName: 'p', workingDir: '/srv/p', files: ['/srv/p/compose.yaml'] },
        }),
      },
      audit: { record: (e: any) => void audits.push(e) },
      notify: (e: NotificationEvent) => void notes.push(e),
    } as any);
    const mk = (id: string, status: 'running' | 'approved', target = 'p') =>
      runs.create({
        id,
        kind: 'update',
        trigger: 'manual',
        target,
        status,
        plan: planFor(),
        requestedBy: 't',
      });
    return { svc, runs, notes, audits, mk };
  }
  const live = (state: string, image: string) => ({
    Id: 'c1'.padEnd(64, '0'),
    Names: ['/p-db-1'],
    State: state,
    ImageID: image,
    Labels: { 'com.docker.compose.project': 'p', 'com.docker.compose.service': 'db' },
  });

  it('F-02: a crash during the health gate (container up on the NEW image) is not "nothing changed"', async () => {
    const t = setup([live('running', IMG_NEW)]);
    t.mk('r1', 'running');
    t.runs.addIntent({
      operationId: 'r1',
      service: 'db',
      action: 'deploy',
      fromImage: IMG_OLD,
      toImage: IMG_NEW,
      containerIdsBefore: ['old'],
    });
    expect(await t.svc.recover()).toBe(1);
    const run = t.runs.get('r1');
    expect(run?.status).toBe('interrupted');
    const g = (run?.guidance ?? []).join('\n');
    expect(g).not.toMatch(/before any container was changed/);
    expect(g).toMatch(/running on the new image/);
    expect(g).toContain(`docker tag ${IMG_OLD} registry.test/db:latest`);
    expect(t.audits.find((a) => a.action === 'maintenance.run.interrupted')?.params.unverified).toBe(true);
    expect(t.notes.some((n) => n.type === 'run.interrupted' && /unverified/i.test(n.title))).toBe(true);
    expect(t.runs.openIntents('r1')).toEqual([]);
  });

  it('F-02: a service left down raises the critical left-down alert with the exact commands', async () => {
    const t = setup([live('exited', IMG_NEW)]);
    t.mk('r1', 'running');
    t.runs.addIntent({
      operationId: 'r1',
      service: 'db',
      action: 'deploy',
      fromImage: IMG_OLD,
      toImage: IMG_NEW,
      containerIdsBefore: [],
    });
    await t.svc.recover();
    const g = (t.runs.get('r1')?.guidance ?? []).join('\n');
    expect(g).toMatch(/NOT running/);
    expect(g).toMatch(/docker compose --project-name 'p'|docker compose --project-name p/);
    expect(t.notes.find((n) => n.type === 'service.left_down')?.severity).toBe('critical');
    expect(t.audits.find((a) => a.action === 'maintenance.run.interrupted')?.params.leftDown).toBe(true);
  });

  it('a run with no open intent is still reported as untouched', async () => {
    const t = setup([]);
    t.mk('r1', 'running');
    await t.svc.recover();
    expect((t.runs.get('r1')?.guidance ?? []).join()).toMatch(/before any container was changed/);
  });

  it('F-11: a standalone swap is described by container names, not by Compose lookups', async () => {
    const oldId = 'a1'.padEnd(64, '0');
    const t = setup([
      {
        Id: oldId,
        Names: ['/web-qm-old-1700000000'],
        State: 'exited',
        ImageID: IMG_OLD,
        Labels: {},
      },
      { Id: 'b2'.padEnd(64, '0'), Names: ['/web'], State: 'running', ImageID: IMG_NEW, Labels: {} },
    ]);
    t.mk('r1', 'running', 'web');
    t.runs.addIntent({
      operationId: 'r1',
      service: 'web',
      action: 'standalone_clone',
      fromImage: IMG_OLD,
      toImage: IMG_NEW,
      containerIdsBefore: [oldId],
    });
    await t.svc.recover();
    const g = (t.runs.get('r1')?.guidance ?? []).join('\n');
    expect(g).toContain('web-qm-old-1700000000');
    expect(g).toMatch(/docker rename 'web-qm-old-1700000000' 'web'|docker rename web-qm-old-1700000000 web/);
    expect(g).not.toMatch(/docker compose/);
    expect(t.notes.some((n) => n.type === 'service.left_down')).toBe(false); // the clone is running
  });

  it('F-11: standalone, old container stopped and still named: left down, plain `docker start`', async () => {
    const oldId = 'a1'.padEnd(64, '0');
    const t = setup([{ Id: oldId, Names: ['/web'], State: 'exited', ImageID: IMG_OLD, Labels: {} }]);
    t.mk('r1', 'running', 'web');
    t.runs.addIntent({
      operationId: 'r1',
      service: 'web',
      action: 'standalone_clone',
      fromImage: IMG_OLD,
      toImage: IMG_NEW,
      containerIdsBefore: [oldId],
    });
    await t.svc.recover();
    const g = (t.runs.get('r1')?.guidance ?? []).join('\n');
    expect(g).toMatch(/docker start/);
    expect(t.notes.some((n) => n.type === 'service.left_down')).toBe(true);
  });

  it('L-2: a run that was approved but never started is interrupted at startup, never executed later', async () => {
    const t = setup([]);
    t.mk('r2', 'approved');
    await t.svc.recover();
    expect(t.runs.get('r2')?.status).toBe('interrupted');
  });

  it('F-13: an intent left open by a restore (run already final) is still reported', async () => {
    const t = setup([live('exited', IMG_OLD)]);
    t.mk('r1', 'running');
    t.runs.finish('r1', 'completed', null, null, null);
    t.runs.addIntent({
      operationId: 'r1',
      service: 'db',
      action: 'rollback',
      fromImage: null,
      toImage: IMG_OLD,
      containerIdsBefore: [],
    });
    await t.svc.recover();
    expect(t.notes.some((n) => n.type === 'service.left_down' && /restore|crash/i.test(n.title))).toBe(true);
    expect(t.runs.openIntents()).toEqual([]);
    expect(t.audits.some((a) => a.action === 'maintenance.restore.interrupted')).toBe(true);
  });
});
