import { randomUUID } from 'node:crypto';
import type { Plan, PolicyInput, PolicyScopeKind, RunKind, RunResult, RunStatus } from '@quaymaster/shared';
import type { Db } from './connection.js';

// ---- policies -----------------------------------------------------------------------------

export class PoliciesRepo {
  constructor(private readonly db: Db) {}

  get(kind: PolicyScopeKind, key: string): { policy: PolicyInput; updatedAt: number } | undefined {
    const r = this.db
      .prepare('SELECT body, updated_at FROM policies WHERE scope_kind = ? AND scope_key = ?')
      .get(kind, key) as { body: string; updated_at: number } | undefined;
    return r ? { policy: JSON.parse(r.body) as PolicyInput, updatedAt: r.updated_at } : undefined;
  }

  put(kind: PolicyScopeKind, key: string, policy: PolicyInput): void {
    this.db
      .prepare(
        `INSERT INTO policies (scope_kind, scope_key, body, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(scope_kind, scope_key) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at`,
      )
      .run(kind, key, JSON.stringify(policy), Date.now());
  }

  delete(kind: PolicyScopeKind, key: string): boolean {
    return (
      this.db.prepare('DELETE FROM policies WHERE scope_kind = ? AND scope_key = ?').run(kind, key).changes >
      0
    );
  }

  list(): { kind: PolicyScopeKind; key: string; policy: PolicyInput; updatedAt: number }[] {
    return (
      this.db.prepare('SELECT * FROM policies ORDER BY scope_kind, scope_key').all() as {
        scope_kind: PolicyScopeKind;
        scope_key: string;
        body: string;
        updated_at: number;
      }[]
    ).map((r) => ({
      kind: r.scope_kind,
      key: r.scope_key,
      policy: JSON.parse(r.body) as PolicyInput,
      updatedAt: r.updated_at,
    }));
  }
}

// ---- windows ------------------------------------------------------------------------------

export interface WindowRow {
  id: string;
  name: string;
  days: number[];
  start: string;
  end: string;
  timezone: string;
  enabled: boolean;
  createdAt: number;
}

interface WindowDbRow {
  id: string;
  name: string;
  days: string;
  start_time: string;
  end_time: string;
  tz: string;
  enabled: number;
  created_at: number;
}

const toWindow = (r: WindowDbRow): WindowRow => ({
  id: r.id,
  name: r.name,
  days: JSON.parse(r.days) as number[],
  start: r.start_time,
  end: r.end_time,
  timezone: r.tz,
  enabled: r.enabled === 1,
  createdAt: r.created_at,
});

export class WindowsRepo {
  constructor(private readonly db: Db) {}
  list(): WindowRow[] {
    return (this.db.prepare('SELECT * FROM windows ORDER BY name').all() as WindowDbRow[]).map(toWindow);
  }
  get(id: string): WindowRow | undefined {
    const r = this.db.prepare('SELECT * FROM windows WHERE id = ?').get(id) as WindowDbRow | undefined;
    return r ? toWindow(r) : undefined;
  }
  create(w: Omit<WindowRow, 'id' | 'createdAt'>): WindowRow {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO windows (id, name, days, start_time, end_time, tz, enabled, created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(id, w.name, JSON.stringify(w.days), w.start, w.end, w.timezone, w.enabled ? 1 : 0, Date.now());
    return this.get(id) as WindowRow;
  }
  update(id: string, w: Omit<WindowRow, 'id' | 'createdAt'>): WindowRow | undefined {
    this.db
      .prepare('UPDATE windows SET name=?, days=?, start_time=?, end_time=?, tz=?, enabled=? WHERE id=?')
      .run(w.name, JSON.stringify(w.days), w.start, w.end, w.timezone, w.enabled ? 1 : 0, id);
    return this.get(id);
  }
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM windows WHERE id = ?').run(id).changes > 0;
  }
  inUse(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM schedules WHERE window_id = ?').get(id);
  }
}

// ---- schedules ----------------------------------------------------------------------------

export interface ScheduleRow {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  jobType: 'image_check' | 'image_pull' | 'update' | 'cleanup_report';
  selector: { project?: string; container?: string; services?: string[] };
  mode: 'manual' | 'auto';
  windowId: string | null;
  enabled: boolean;
  cursorUtc: number;
  createdAt: number;
}

interface ScheduleDbRow {
  id: string;
  name: string;
  cron: string;
  tz: string;
  job_type: ScheduleRow['jobType'];
  selector: string;
  mode: 'manual' | 'auto';
  window_id: string | null;
  enabled: number;
  cursor_utc: number;
  created_at: number;
}

const toSchedule = (r: ScheduleDbRow): ScheduleRow => ({
  id: r.id,
  name: r.name,
  cron: r.cron,
  timezone: r.tz,
  jobType: r.job_type,
  selector: JSON.parse(r.selector) as ScheduleRow['selector'],
  mode: r.mode,
  windowId: r.window_id,
  enabled: r.enabled === 1,
  cursorUtc: r.cursor_utc,
  createdAt: r.created_at,
});

export class SchedulesRepo {
  constructor(private readonly db: Db) {}
  list(): ScheduleRow[] {
    return (this.db.prepare('SELECT * FROM schedules ORDER BY name').all() as ScheduleDbRow[]).map(
      toSchedule,
    );
  }
  get(id: string): ScheduleRow | undefined {
    const r = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleDbRow | undefined;
    return r ? toSchedule(r) : undefined;
  }
  create(s: Omit<ScheduleRow, 'id' | 'createdAt'>): ScheduleRow {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO schedules (id, name, cron, tz, job_type, selector, mode, window_id, enabled, cursor_utc, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        s.name,
        s.cron,
        s.timezone,
        s.jobType,
        JSON.stringify(s.selector),
        s.mode,
        s.windowId,
        s.enabled ? 1 : 0,
        s.cursorUtc,
        Date.now(),
      );
    return this.get(id) as ScheduleRow;
  }
  update(id: string, s: Omit<ScheduleRow, 'id' | 'createdAt' | 'cursorUtc'>): ScheduleRow | undefined {
    this.db
      .prepare(
        'UPDATE schedules SET name=?, cron=?, tz=?, job_type=?, selector=?, mode=?, window_id=?, enabled=? WHERE id=?',
      )
      .run(
        s.name,
        s.cron,
        s.timezone,
        s.jobType,
        JSON.stringify(s.selector),
        s.mode,
        s.windowId,
        s.enabled ? 1 : 0,
        id,
      );
    return this.get(id);
  }
  setCursor(id: string, cursorUtc: number): void {
    this.db.prepare('UPDATE schedules SET cursor_utc = ? WHERE id = ?').run(cursorUtc, id);
  }
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0;
  }
}

/** RT-09: one row per (schedule, occurrence). Inserting is the claim; a conflict means "already handled". */
export class OccurrencesRepo {
  constructor(private readonly db: Db) {}

  /** Returns true if this call created the row (the caller owns the occurrence). */
  claim(scheduleId: string, occurrenceUtc: number, status: string): boolean {
    return (
      this.db
        .prepare(
          'INSERT OR IGNORE INTO schedule_occurrences (schedule_id, occurrence_utc, status) VALUES (?,?,?)',
        )
        .run(scheduleId, occurrenceUtc, status).changes > 0
    );
  }
  update(scheduleId: string, occurrenceUtc: number, status: string, runId: string | null): void {
    this.db
      .prepare(
        'UPDATE schedule_occurrences SET status = ?, run_id = COALESCE(?, run_id) WHERE schedule_id = ? AND occurrence_utc = ?',
      )
      .run(status, runId, scheduleId, occurrenceUtc);
  }
  list(scheduleId: string, limit = 50): { occurrenceUtc: number; status: string; runId: string | null }[] {
    return (
      this.db
        .prepare(
          'SELECT occurrence_utc, status, run_id FROM schedule_occurrences WHERE schedule_id = ? ORDER BY occurrence_utc DESC LIMIT ?',
        )
        .all(scheduleId, limit) as { occurrence_utc: number; status: string; run_id: string | null }[]
    ).map((r) => ({ occurrenceUtc: r.occurrence_utc, status: r.status, runId: r.run_id }));
  }
}

// ---- runs ---------------------------------------------------------------------------------

export interface RunRow {
  id: string;
  kind: RunKind;
  trigger: 'manual' | 'schedule';
  scheduleId: string | null;
  occurrenceUtc: number | null;
  windowId: string | null;
  windowEndUtc: number | null;
  target: string;
  status: RunStatus;
  reason: string | null;
  plan: Plan | null;
  planHash: string | null;
  requestedBy: string;
  approvalExpiresAt: number | null;
  approvedBy: string | null;
  approvedAt: number | null;
  approvedPlanHash: string | null;
  options: RunOptions;
  result: RunResult | null;
  guidance: string[] | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** Per-run switches chosen by whoever creates the run. */
export interface RunOptions {
  services?: string[];
  /** Applying configuration drift needs this explicit flag (RT-01). */
  applyDrift?: boolean;
  /** Allow updating while a service is restarting / unhealthy. */
  allowUnhealthy?: boolean;
  /** Plan was produced for an unattended (scheduled auto) run. */
  unattended?: boolean;
  /** Manual run that may start outside the schedule's window. */
  ignoreWindow?: boolean;
  /** Mode of the triggering schedule (null/undefined = manual). */
  scheduleMode?: 'manual' | 'auto' | null;
  /** Only services with these update modes are part of the run (scheduled runs: auto). */
  onlyModes?: ('ignore' | 'notify' | 'pull_only' | 'auto')[];
}

interface RunDbRow {
  id: string;
  kind: RunKind;
  trigger: 'manual' | 'schedule';
  schedule_id: string | null;
  occurrence_utc: number | null;
  window_id: string | null;
  window_end_utc: number | null;
  target: string;
  status: RunStatus;
  reason: string | null;
  plan: string | null;
  plan_hash: string | null;
  requested_by: string;
  approval_expires_at: number | null;
  approved_by: string | null;
  approved_at: number | null;
  approved_plan_hash: string | null;
  options: string;
  result: string | null;
  guidance: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

const toRun = (r: RunDbRow): RunRow => ({
  id: r.id,
  kind: r.kind,
  trigger: r.trigger,
  scheduleId: r.schedule_id,
  occurrenceUtc: r.occurrence_utc,
  windowId: r.window_id,
  windowEndUtc: r.window_end_utc,
  target: r.target,
  status: r.status,
  reason: r.reason,
  plan: r.plan ? (JSON.parse(r.plan) as Plan) : null,
  planHash: r.plan_hash,
  requestedBy: r.requested_by,
  approvalExpiresAt: r.approval_expires_at,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at,
  approvedPlanHash: r.approved_plan_hash,
  options: JSON.parse(r.options) as RunOptions,
  result: r.result ? (JSON.parse(r.result) as RunResult) : null,
  guidance: r.guidance ? (JSON.parse(r.guidance) as string[]) : null,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export interface StepRow {
  id: number;
  runId: string;
  seq: number;
  service: string | null;
  step: string;
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  startedAt: number;
  finishedAt: number | null;
  detail: Record<string, unknown> | null;
}

export interface IntentRow {
  id: number;
  operationId: string;
  service: string | null;
  action: string;
  fromImage: string | null;
  toImage: string | null;
  containerIdsBefore: string[];
  createdAt: number;
  completedAt: number | null;
}

export class RunsRepo {
  constructor(private readonly db: Db) {}

  create(r: {
    id: string;
    kind: RunKind;
    trigger: 'manual' | 'schedule';
    scheduleId?: string | null;
    occurrenceUtc?: number | null;
    windowId?: string | null;
    windowEndUtc?: number | null;
    target: string;
    status: RunStatus;
    reason?: string | null;
    plan?: Plan | null;
    requestedBy: string;
    approvalExpiresAt?: number | null;
    options?: RunOptions;
  }): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, kind, trigger, schedule_id, occurrence_utc, window_id, window_end_utc, target, status, reason,
           plan, plan_hash, requested_by, approval_expires_at, options, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.id,
        r.kind,
        r.trigger,
        r.scheduleId ?? null,
        r.occurrenceUtc ?? null,
        r.windowId ?? null,
        r.windowEndUtc ?? null,
        r.target,
        r.status,
        r.reason ?? null,
        r.plan ? JSON.stringify(r.plan) : null,
        r.plan?.planHash ?? null,
        r.requestedBy,
        r.approvalExpiresAt ?? null,
        JSON.stringify(r.options ?? {}),
        Date.now(),
      );
  }

  get(id: string): RunRow | undefined {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunDbRow | undefined;
    return r ? toRun(r) : undefined;
  }

  list(opts: { limit: number; status?: RunStatus; target?: string; kind?: RunKind }): RunRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.status) {
      where.push('status = ?');
      args.push(opts.status);
    }
    if (opts.target) {
      where.push('target = ?');
      args.push(opts.target);
    }
    if (opts.kind) {
      where.push('kind = ?');
      args.push(opts.kind);
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(...args, opts.limit) as RunDbRow[]
    ).map(toRun);
  }

  byStatus(status: RunStatus): RunRow[] {
    return (
      this.db.prepare('SELECT * FROM runs WHERE status = ? ORDER BY created_at').all(status) as RunDbRow[]
    ).map(toRun);
  }

  setStatus(id: string, status: RunStatus, reason?: string | null): void {
    this.db
      .prepare('UPDATE runs SET status = ?, reason = COALESCE(?, reason) WHERE id = ?')
      .run(status, reason ?? null, id);
  }

  setWindowEnd(id: string, endUtc: number | null): void {
    this.db.prepare('UPDATE runs SET window_end_utc = ? WHERE id = ?').run(endUtc, id);
  }

  setPlan(id: string, plan: Plan): void {
    this.db
      .prepare('UPDATE runs SET plan = ?, plan_hash = ? WHERE id = ?')
      .run(JSON.stringify(plan), plan.planHash, id);
  }

  approve(id: string, by: string, planHash: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE runs SET status='approved', approved_by=?, approved_at=?, approved_plan_hash=? WHERE id=? AND status='awaiting_approval'",
        )
        .run(by, Date.now(), planHash, id).changes > 0
    );
  }

  markStarted(id: string): void {
    this.db.prepare("UPDATE runs SET status='running', started_at=? WHERE id=?").run(Date.now(), id);
  }

  finish(
    id: string,
    status: RunStatus,
    result: RunResult | null,
    guidance: string[] | null,
    reason?: string | null,
  ): void {
    this.db
      .prepare(
        'UPDATE runs SET status=?, finished_at=?, result=?, guidance=?, reason=COALESCE(?, reason) WHERE id=?',
      )
      .run(
        status,
        Date.now(),
        result ? JSON.stringify(result) : null,
        guidance ? JSON.stringify(guidance) : null,
        reason ?? null,
        id,
      );
  }

  /** Crash recovery (spec 7.4): runs left `running` are `interrupted`, never resumed. Returns them. */
  interruptRunning(): RunRow[] {
    const rows = this.byStatus('running');
    this.db
      .prepare(
        "UPDATE runs SET status='interrupted', finished_at=?, reason='Quaymaster stopped while this run was in progress' WHERE status='running'",
      )
      .run(Date.now());
    return rows;
  }

  /** Overdue approvals (spec 7.4): awaiting_approval past their expiry become `skipped`. */
  expireApprovals(now: number): RunRow[] {
    const rows = (
      this.db
        .prepare(
          "SELECT * FROM runs WHERE status='awaiting_approval' AND approval_expires_at IS NOT NULL AND approval_expires_at <= ?",
        )
        .all(now) as RunDbRow[]
    ).map(toRun);
    this.db
      .prepare(
        "UPDATE runs SET status='skipped', finished_at=?, reason='approval expired' WHERE status='awaiting_approval' AND approval_expires_at IS NOT NULL AND approval_expires_at <= ?",
      )
      .run(now, now);
    return rows;
  }

  /** Is any run currently executing? (single-run lock, persisted) */
  running(): RunRow | undefined {
    const r = this.db.prepare("SELECT * FROM runs WHERE status='running' LIMIT 1").get() as
      RunDbRow | undefined;
    return r ? toRun(r) : undefined;
  }

  // ---- steps
  startStep(runId: string, seq: number, service: string | null, step: string, detail?: unknown): number {
    return Number(
      this.db
        .prepare(
          "INSERT INTO run_steps (run_id, seq, service, step, status, started_at, detail) VALUES (?,?,?,?,'running',?,?)",
        )
        .run(runId, seq, service, step, Date.now(), detail === undefined ? null : JSON.stringify(detail))
        .lastInsertRowid,
    );
  }

  finishStep(id: number, status: 'succeeded' | 'failed' | 'skipped', detail?: unknown): void {
    this.db
      .prepare('UPDATE run_steps SET status = ?, finished_at = ?, detail = COALESCE(?, detail) WHERE id = ?')
      .run(status, Date.now(), detail === undefined ? null : JSON.stringify(detail), id);
  }

  steps(runId: string): StepRow[] {
    return (
      this.db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY seq, id').all(runId) as {
        id: number;
        run_id: string;
        seq: number;
        service: string | null;
        step: string;
        status: StepRow['status'];
        started_at: number;
        finished_at: number | null;
        detail: string | null;
      }[]
    ).map((r) => ({
      id: r.id,
      runId: r.run_id,
      seq: r.seq,
      service: r.service,
      step: r.step,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
    }));
  }

  /** Steps left running by a crash are closed as failed so the history is truthful. */
  failOpenSteps(runId: string): void {
    this.db
      .prepare("UPDATE run_steps SET status='failed', finished_at=? WHERE run_id=? AND status='running'")
      .run(Date.now(), runId);
  }

  // ---- write-ahead intents (RT-14)
  addIntent(i: {
    operationId: string;
    service: string | null;
    action: string;
    fromImage: string | null;
    toImage: string | null;
    containerIdsBefore: string[];
  }): number {
    return Number(
      this.db
        .prepare(
          'INSERT INTO intents (operation_id, service, action, from_image, to_image, container_ids_before, created_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          i.operationId,
          i.service,
          i.action,
          i.fromImage,
          i.toImage,
          JSON.stringify(i.containerIdsBefore),
          Date.now(),
        ).lastInsertRowid,
    );
  }
  completeIntent(id: number): void {
    this.db.prepare('UPDATE intents SET completed_at = ? WHERE id = ?').run(Date.now(), id);
  }
  openIntents(operationId?: string): IntentRow[] {
    const rows = (
      operationId
        ? this.db
            .prepare('SELECT * FROM intents WHERE completed_at IS NULL AND operation_id = ?')
            .all(operationId)
        : this.db.prepare('SELECT * FROM intents WHERE completed_at IS NULL').all()
    ) as {
      id: number;
      operation_id: string;
      service: string | null;
      action: string;
      from_image: string | null;
      to_image: string | null;
      container_ids_before: string;
      created_at: number;
      completed_at: number | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      operationId: r.operation_id,
      service: r.service,
      action: r.action,
      fromImage: r.from_image,
      toImage: r.to_image,
      containerIdsBefore: JSON.parse(r.container_ids_before) as string[],
      createdAt: r.created_at,
      completedAt: r.completed_at,
    }));
  }
}
