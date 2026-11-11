import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type OpenedDb } from '../../src/db/connection.js';
import { OccurrencesRepo, RunsRepo, SchedulesRepo, WindowsRepo } from '../../src/db/maintenance.js';
import { AdjustableClock } from '../../src/maintenance/clock.js';
import { MaintenanceService } from '../../src/maintenance/service.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- the service is exercised with the dependencies tick() touches */

const T0 = Date.UTC(2026, 0, 7, 9, 0, 0); // a Wednesday, 09:00 UTC

describe('scheduler tick (RT-09: claim, missed runs, backlog) with an injected clock', () => {
  let opened: OpenedDb | undefined;
  afterEach(() => opened?.close());

  function setup(cron: string, opts: { window?: boolean; cursor?: number } = {}) {
    opened = openDatabase(':memory:');
    const db = opened.db;
    const schedules = new SchedulesRepo(db);
    const occurrences = new OccurrencesRepo(db);
    const windows = new WindowsRepo(db);
    const clock = new AdjustableClock();
    clock.set(T0);
    const win = opts.window
      ? windows.create({
          name: 'all-day',
          days: [0, 1, 2, 3, 4, 5, 6],
          start: '00:00',
          end: '23:59',
          timezone: 'UTC',
          enabled: true,
        })
      : null;
    const sch = schedules.create({
      name: 's1',
      cron,
      timezone: 'UTC',
      jobType: 'update',
      selector: { project: 'p' },
      mode: 'auto',
      windowId: win?.id ?? null,
      enabled: true,
      cursorUtc: opts.cursor ?? T0,
    });
    const audits: string[] = [];
    const svc = new MaintenanceService({
      runs: new RunsRepo(db),
      windows,
      schedules,
      occurrences,
      audit: { record: (e: { action: string }) => void audits.push(e.action) },
      notify: () => undefined,
      clock,
      log: { error: () => undefined, warn: () => undefined },
    } as any);
    const fired: number[] = [];
    let failNext = false;
    (svc as any).fire = async (_s: unknown, occ: number) => {
      fired.push(occ);
      if (failNext) throw new Error('boom');
      return `run-${occ}`;
    };
    return {
      svc,
      clock,
      schedules,
      occurrences,
      sch,
      fired,
      audits,
      failNext: () => {
        failNext = true;
      },
    };
  }
  const HOUR = 3_600_000;

  it('a claimed occurrence is never fired again, even if the cursor is moved back', async () => {
    const t = setup('0 * * * *');
    t.clock.set(T0 + HOUR + 60_000); // 10:01, the 10:00 occurrence is due and fresh
    await t.svc.tick();
    expect(t.fired).toEqual([T0 + HOUR]);
    await t.svc.tick();
    expect(t.fired).toEqual([T0 + HOUR]); // second tick: nothing new
    t.schedules.setCursor(t.sch.id, T0); // simulate a lost cursor update (crash after the run started)
    await t.svc.tick();
    expect(t.fired).toEqual([T0 + HOUR]); // claim row prevents a second run
    expect(t.occurrences.list(t.sch.id)[0]).toMatchObject({ occurrenceUtc: T0 + HOUR, status: 'started' });
  });

  it('a crash between claim and "started" leaves the occurrence claimed and it never fires after restart', async () => {
    const t = setup('0 * * * *');
    t.occurrences.claim(t.sch.id, T0 + HOUR, 'claimed'); // what a killed process leaves behind
    t.clock.set(T0 + HOUR + 60_000);
    await t.svc.tick();
    expect(t.fired).toEqual([]);
    expect(t.occurrences.list(t.sch.id)[0]).toMatchObject({ status: 'claimed', runId: null });
  });

  it('several missed occurrences run at most once (the latest) and only inside an open window', async () => {
    const t = setup('0 * * * *', { window: true });
    t.clock.set(T0 + 3 * HOUR + 30 * 60_000); // 12:30; 10:00, 11:00, 12:00 missed (12:00 is 30 min old)
    await t.svc.tick();
    expect(t.fired).toEqual([T0 + 3 * HOUR]); // only the latest
    const st = new Map(t.occurrences.list(t.sch.id).map((o) => [o.occurrenceUtc, o.status]));
    expect(st.get(T0 + HOUR)).toBe('skipped_missed');
    expect(st.get(T0 + 2 * HOUR)).toBe('skipped_missed');
    expect(st.get(T0 + 3 * HOUR)).toBe('started');
  });

  it('missed update occurrences without a window never run', async () => {
    const t = setup('0 * * * *');
    t.clock.set(T0 + 3 * HOUR + 30 * 60_000);
    await t.svc.tick();
    expect(t.fired).toEqual([]);
    expect(
      t.occurrences
        .list(t.sch.id)
        .map((o) => o.status)
        .sort(),
    ).toEqual(['skipped_missed', 'skipped_missed', 'skipped_missed']);
  });

  it('L-1: after a huge backlog the occurrence that runs is the real latest one, not the 50th', async () => {
    const t = setup('* * * * *', { window: true });
    t.clock.set(T0 + 30 * HOUR); // 1800 missed minutes
    await t.svc.tick();
    // only occurrences younger than the grace period (5 min) still count as on time; everything older is skipped
    expect(t.fired.every((o) => T0 + 30 * HOUR - o <= 5 * 60_000)).toBe(true);
    expect(t.fired[t.fired.length - 1]).toBe(T0 + 30 * HOUR); // the latest is the real latest, not the 50th
    expect(
      t.occurrences.list(t.sch.id, 5000).filter((o) => o.status === 'skipped_missed').length,
    ).toBeGreaterThan(1700);
  });

  it('a start failure is recorded and not retried', async () => {
    const t = setup('0 * * * *');
    t.failNext();
    t.clock.set(T0 + HOUR + 60_000);
    await t.svc.tick();
    await t.svc.tick();
    expect(t.fired).toEqual([T0 + HOUR]);
    expect(t.occurrences.list(t.sch.id)[0]?.status).toBe('failed');
  });
});
