import { randomUUID } from 'node:crypto';
import type {
  MaintenanceWindow,
  MaintenanceWindowInput,
  NotificationEvent,
  Plan,
  RunDetail,
  RunInfo,
  RunStatus,
  Schedule,
  ScheduleInput,
} from '@quaymaster/shared';
import type { AuditService } from '../audit/audit.js';
import type { ComposeService } from '../compose/service.js';
import type { Config } from '../config/env.js';
import type {
  OccurrencesRepo,
  RunOptions,
  RunRow,
  RunsRepo,
  ScheduleRow,
  SchedulesRepo,
  StepRow,
  WindowRow,
  WindowsRepo,
} from '../db/maintenance.js';
import type { Actor } from '../docker/containers.js';
import { LABEL } from '../docker/model.js';
import type { ImageOps } from '../docker/imageops.js';
import type { OperationManager } from '../operations/manager.js';
import { parseImageRef } from '../registry/reference.js';
import type { Guard } from '../security/guard.js';
import type { CleanupService } from '../updates/cleanup.js';
import type { UpdateService } from '../updates/detector.js';
import { AppError, badRequest, conflict, notFound } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import type { Clock } from './clock.js';
import type { RunExecutor } from './executor.js';
import type { StandaloneUpdater } from './standalone.js';
import type { PolicyResolver } from './policy.js';
import type { Planner } from './planner.js';
import {
  cronError,
  isValidTimeZone,
  nextOccurrences,
  nextWindowStart,
  windowAt,
  windowError,
  type WindowDef,
} from './time.js';

/** An occurrence this late (or later) is a "missed run" (the app was down or busy), not a normal fire. */
export const MISSED_GRACE_MS = 5 * 60_000;

const toIso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export function toRunInfo(r: RunRow): RunInfo {
  return {
    id: r.id,
    kind: r.kind,
    trigger: r.trigger,
    scheduleId: r.scheduleId,
    occurrence: toIso(r.occurrenceUtc),
    windowId: r.windowId,
    windowEnd: toIso(r.windowEndUtc),
    target: r.target,
    status: r.status,
    reason: r.reason,
    planHash: r.planHash,
    requestedBy: r.requestedBy,
    approvalExpiresAt: toIso(r.approvalExpiresAt),
    approvedBy: r.approvedBy,
    approvedAt: toIso(r.approvedAt),
    approvedPlanHash: r.approvedPlanHash,
    result: r.result,
    guidance: r.guidance,
    createdAt: new Date(r.createdAt).toISOString(),
    startedAt: toIso(r.startedAt),
    finishedAt: toIso(r.finishedAt),
  };
}

const toStep = (s: StepRow): RunDetail['steps'][number] => ({
  id: s.id,
  seq: s.seq,
  service: s.service,
  step: s.step,
  status: s.status,
  startedAt: new Date(s.startedAt).toISOString(),
  finishedAt: toIso(s.finishedAt),
  detail: s.detail,
});

export interface CreateRunRequest {
  project: string;
  services?: string[];
  applyDrift?: boolean;
  allowUnhealthy?: boolean;
  /** Admin presses "run now": equivalent to creating and approving in one go (requires `confirm` = project). */
  startNow?: boolean;
  confirm?: string;
  windowId?: string | null;
  ignoreWindow?: boolean;
}

/**
 * Lifecycle of maintenance runs: dry runs, approval flow (bound to the plan hash, with expiry), the
 * scheduler (unique occurrences, DST-safe cron, missed-run handling), the single-run lock and crash
 * recovery. The state machine that actually changes containers lives in `RunExecutor`.
 */
export class MaintenanceService {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  readonly resolver: PolicyResolver;

  constructor(
    private readonly d: {
      runs: RunsRepo;
      windows: WindowsRepo;
      schedules: SchedulesRepo;
      occurrences: OccurrencesRepo;
      resolver: PolicyResolver;
      planner: Planner;
      executor: RunExecutor;
      standalone: StandaloneUpdater;
      ops: OperationManager;
      updates: UpdateService;
      images: ImageOps;
      cleanup: CleanupService;
      compose: ComposeService;
      guard: Guard;
      audit: AuditService;
      notify: (e: NotificationEvent) => void;
      clock: Clock;
      config: Pick<Config, 'approvalExpiryMs'>;
      log: Logger;
    },
  ) {
    this.resolver = d.resolver;
  }

  // ---- windows ---------------------------------------------------------------------------

  private windowView(w: WindowRow): MaintenanceWindow {
    const now = this.d.clock.now();
    const def: WindowDef = { days: w.days, start: w.start, end: w.end, timezone: w.timezone };
    return {
      id: w.id,
      name: w.name,
      days: w.days,
      start: w.start,
      end: w.end,
      timezone: w.timezone,
      enabled: w.enabled,
      createdAt: new Date(w.createdAt).toISOString(),
      openNow: w.enabled && windowAt(def, now) !== null,
      nextStart: toIso(w.enabled ? (nextWindowStart(def, now)?.start ?? null) : null),
    };
  }

  listWindows(): MaintenanceWindow[] {
    return this.d.windows.list().map((w) => this.windowView(w));
  }

  createWindow(input: MaintenanceWindowInput, actor: Actor): MaintenanceWindow {
    const err = windowError({
      days: input.days,
      start: input.start,
      end: input.end,
      timezone: input.timezone,
    });
    if (err) throw badRequest(err);
    const w = this.d.windows.create({
      name: input.name,
      days: [...new Set(input.days)].sort(),
      start: input.start,
      end: input.end,
      timezone: input.timezone,
      enabled: input.enabled ?? true,
    });
    this.audit(actor, 'maintenance.window.create', w.name, { id: w.id });
    return this.windowView(w);
  }

  updateWindow(id: string, input: MaintenanceWindowInput, actor: Actor): MaintenanceWindow {
    if (!this.d.windows.get(id)) throw notFound('Window');
    const err = windowError({
      days: input.days,
      start: input.start,
      end: input.end,
      timezone: input.timezone,
    });
    if (err) throw badRequest(err);
    const w = this.d.windows.update(id, {
      name: input.name,
      days: [...new Set(input.days)].sort(),
      start: input.start,
      end: input.end,
      timezone: input.timezone,
      enabled: input.enabled ?? true,
    }) as WindowRow;
    this.audit(actor, 'maintenance.window.update', w.name, { id });
    return this.windowView(w);
  }

  deleteWindow(id: string, actor: Actor): void {
    const w = this.d.windows.get(id);
    if (!w) throw notFound('Window');
    if (this.d.windows.inUse(id)) throw conflict('conflict', 'The window is used by a schedule');
    this.d.windows.delete(id);
    this.audit(actor, 'maintenance.window.delete', w.name, { id });
  }

  // ---- schedules -------------------------------------------------------------------------

  private scheduleView(s: ScheduleRow): Schedule {
    const now = this.d.clock.now();
    return {
      id: s.id,
      name: s.name,
      cron: s.cron,
      timezone: s.timezone,
      jobType: s.jobType,
      selector: s.selector,
      mode: s.mode,
      windowId: s.windowId,
      enabled: s.enabled,
      createdAt: new Date(s.createdAt).toISOString(),
      nextRuns: s.enabled
        ? nextOccurrences(s.cron, s.timezone, now, 3).map((t) => new Date(t).toISOString())
        : [],
    };
  }

  private validateSchedule(input: ScheduleInput): void {
    const e = cronError(input.cron);
    if (e) throw badRequest(`Invalid cron expression: ${e}`);
    if (!isValidTimeZone(input.timezone)) throw badRequest(`Unknown time zone "${input.timezone}"`);
    if (input.windowId && !this.d.windows.get(input.windowId)) throw badRequest('Unknown maintenance window');
    if (input.jobType === 'update') {
      const sel = input.selector ?? {};
      if (!sel.project && !sel.container)
        throw badRequest('An update schedule needs selector.project or selector.container');
      if (sel.container && input.mode === 'auto')
        throw badRequest('Standalone containers are never updated automatically (RT-12); use mode "manual"');
    }
  }

  listSchedules(): Schedule[] {
    return this.d.schedules.list().map((s) => this.scheduleView(s));
  }

  createSchedule(input: ScheduleInput, actor: Actor): Schedule {
    this.validateSchedule(input);
    const s = this.d.schedules.create({
      name: input.name,
      cron: input.cron.trim(),
      timezone: input.timezone,
      jobType: input.jobType,
      selector: input.selector ?? {},
      mode: input.mode,
      windowId: input.windowId ?? null,
      enabled: input.enabled ?? true,
      cursorUtc: this.d.clock.now(), // never fire for the past
    });
    this.audit(actor, 'maintenance.schedule.create', s.name, { id: s.id, cron: s.cron, mode: s.mode });
    return this.scheduleView(s);
  }

  updateSchedule(id: string, input: ScheduleInput, actor: Actor): Schedule {
    if (!this.d.schedules.get(id)) throw notFound('Schedule');
    this.validateSchedule(input);
    const s = this.d.schedules.update(id, {
      name: input.name,
      cron: input.cron.trim(),
      timezone: input.timezone,
      jobType: input.jobType,
      selector: input.selector ?? {},
      mode: input.mode,
      windowId: input.windowId ?? null,
      enabled: input.enabled ?? true,
    }) as ScheduleRow;
    this.audit(actor, 'maintenance.schedule.update', s.name, { id });
    return this.scheduleView(s);
  }

  deleteSchedule(id: string, actor: Actor): void {
    const s = this.d.schedules.get(id);
    if (!s) throw notFound('Schedule');
    this.d.schedules.delete(id);
    this.audit(actor, 'maintenance.schedule.delete', s.name, { id });
  }

  // ---- runs ------------------------------------------------------------------------------

  listRuns(opts: { limit?: number; status?: RunStatus; target?: string } = {}): RunInfo[] {
    return this.d.runs
      .list({ limit: opts.limit ?? 50, status: opts.status, target: opts.target })
      .map(toRunInfo);
  }

  getRun(id: string): RunDetail {
    const r = this.d.runs.get(id);
    if (!r) throw notFound('Run');
    return { ...toRunInfo(r), plan: r.plan, steps: this.d.runs.steps(id).map(toStep) };
  }

  /** Dry run (spec 7.5): preflight, check, validate, impact. Stores the plan; changes and pulls nothing. */
  async dryRun(
    req: {
      project: string;
      services?: string[];
      applyDrift?: boolean;
      allowUnhealthy?: boolean;
      fresh?: boolean;
    },
    actor: Actor,
  ): Promise<RunDetail> {
    const plan = await this.d.planner.planProject({ ...req, fresh: req.fresh ?? true });
    const id = randomUUID();
    this.d.runs.create({
      id,
      kind: 'dry_run',
      trigger: 'manual',
      target: req.project,
      status: 'planned',
      reason: plan.blocked?.message ?? null,
      plan,
      requestedBy: actor.name,
      options: { services: req.services, applyDrift: req.applyDrift, allowUnhealthy: req.allowUnhealthy },
    });
    this.audit(actor, 'maintenance.dry_run', req.project, {
      run: id,
      planHash: plan.planHash,
      blocked: plan.blocked?.code ?? null,
    });
    return this.getRun(id);
  }

  /** Creates an update run from a fresh plan; it waits for approval unless an admin starts it right away. */
  async createRun(
    req: CreateRunRequest,
    actor: Actor,
    sched?: { schedule: ScheduleRow; occurrenceUtc: number; unattended: boolean },
  ): Promise<RunDetail> {
    const manual = !sched;
    const options: RunOptions = {
      services: req.services,
      applyDrift: req.applyDrift,
      allowUnhealthy: req.allowUnhealthy,
      ignoreWindow: req.ignoreWindow,
      scheduleMode: sched ? sched.schedule.mode : null,
      onlyModes: sched ? ['auto'] : undefined,
    };
    const ro = this.d.guard.readOnlyReason;
    if (ro) throw new AppError(409, 'read_only', `Read-only mode: ${ro}`);
    if (req.startNow && req.confirm !== req.project)
      throw new AppError(409, 'confirmation_required', `Confirm by sending {"confirm":"${req.project}"}`, {
        expected: req.project,
      });
    const plan = await this.d.planner.planProject({
      project: req.project,
      services: req.services,
      scheduleMode: options.scheduleMode,
      onlyModes: options.onlyModes,
      applyDrift: req.applyDrift,
      allowUnhealthy: req.allowUnhealthy,
      fresh: true,
    });
    const id = randomUUID();
    const common = {
      id,
      kind: 'update' as const,
      trigger: manual ? ('manual' as const) : ('schedule' as const),
      scheduleId: sched?.schedule.id ?? null,
      occurrenceUtc: sched?.occurrenceUtc ?? null,
      windowId: req.windowId ?? sched?.schedule.windowId ?? null,
      target: req.project,
      plan,
      requestedBy: actor.name,
      options,
    };
    if (plan.blocked) {
      const nothing = plan.blocked.code === 'nothing_to_do';
      this.d.runs.create({
        ...common,
        status: nothing ? 'skipped' : 'blocked',
        reason: plan.blocked.message,
      });
      this.d.runs.finish(
        id,
        nothing ? 'skipped' : 'blocked',
        null,
        plan.drift.length ? ['Review the configuration drift before updating.'] : null,
        plan.blocked.message,
      );
      this.audit(actor, 'maintenance.run.create', req.project, { run: id, blocked: plan.blocked.code });
      if (!manual && !nothing)
        this.d.notify({
          type: 'run.failed',
          severity: 'warning',
          title: `Scheduled update blocked: ${req.project}`,
          message: plan.blocked.message,
          dedupeKey: `blocked:${req.project}:${plan.blocked.code}`,
          cooldownMs: 24 * 3_600_000,
        });
      return this.getRun(id);
    }
    const unattended =
      !manual &&
      sched!.unattended &&
      plan.services.filter((s) => s.role === 'update').every((s) => s.unattended.eligible);
    this.d.runs.create({
      ...common,
      status: 'awaiting_approval',
      approvalExpiresAt: this.d.clock.now() + this.d.config.approvalExpiryMs,
    });
    this.audit(actor, 'maintenance.run.create', req.project, {
      run: id,
      planHash: plan.planHash,
      unattended,
    });
    if (req.startNow || unattended) {
      // unattended: the truth table (update_mode=auto ∧ schedule auto ∧ ¬approval ∧ ¬critical) was satisfied
      await this.approve(
        id,
        plan.planHash,
        unattended && !req.startNow ? { name: `schedule:${sched?.schedule.name}`, ip: null } : actor,
      );
    } else {
      this.d.notify({
        type: 'maintenance.awaiting_approval',
        severity: 'info',
        title: `Update awaiting approval: ${req.project}`,
        message: `${plan.services
          .filter((s) => s.role === 'update')
          .map((s) => s.service)
          .join(
            ', ',
          )} can be updated. Review the plan and approve it (expires ${new Date(this.d.clock.now() + this.d.config.approvalExpiryMs).toISOString()}).`,
        dedupeKey: `approval:${id}`,
        data: { run: id, planHash: plan.planHash },
      });
    }
    return this.getRun(id);
  }

  /** Approves exactly the plan the human saw (`planHash`), then starts it. */
  async approve(id: string, planHash: string, actor: Actor): Promise<RunDetail> {
    const run = this.d.runs.get(id);
    if (!run) throw notFound('Run');
    if (run.status !== 'awaiting_approval')
      throw conflict('conflict', `Run is ${run.status}, not awaiting approval`);
    if (run.approvalExpiresAt !== null && run.approvalExpiresAt <= this.d.clock.now()) {
      this.d.runs.expireApprovals(this.d.clock.now());
      throw conflict('conflict', 'The approval request has expired; create a new run');
    }
    if (!run.plan || run.plan.planHash !== planHash)
      throw new AppError(
        409,
        'approval_stale',
        'The plan changed since you reviewed it; review the current plan and approve again',
      );
    const ro = this.d.guard.readOnlyReason;
    if (ro) throw new AppError(409, 'read_only', `Read-only mode: ${ro}`);
    if (run.windowId && run.options.ignoreWindow !== true) {
      const w = this.d.windows.get(run.windowId);
      if (!w || !windowAt(w as WindowDef, this.d.clock.now()))
        throw new AppError(
          409,
          'window_closed',
          'The maintenance window is closed; approve inside the window or send ignoreWindow when creating the run',
        );
    }
    if (this.d.ops.busy() || this.d.runs.running())
      throw conflict('conflict', 'Another maintenance run is in progress (one run at a time)');
    if (!this.d.runs.approve(id, actor.name, planHash))
      throw conflict('conflict', 'Run is no longer awaiting approval');
    this.audit(actor, 'maintenance.run.approve', run.target, { run: id, approvedPlanHash: planHash });
    this.start(id, actor);
    return this.getRun(id);
  }

  reject(id: string, actor: Actor): RunDetail {
    const run = this.d.runs.get(id);
    if (!run) throw notFound('Run');
    if (run.status !== 'awaiting_approval')
      throw conflict('conflict', `Run is ${run.status}, not awaiting approval`);
    this.d.runs.finish(id, 'rejected', null, null, `rejected by ${actor.name}`);
    this.audit(actor, 'maintenance.run.reject', run.target, { run: id });
    return this.getRun(id);
  }

  private start(id: string, actor: Actor): void {
    const run = this.d.runs.get(id) as RunRow;
    this.d.ops.start({
      id,
      kind: 'maintenance.update',
      target: run.target,
      actor: actor.name,
      params: { run: id, planHash: run.planHash },
      lockKey: 'maintenance',
      run: async (ctx) => {
        const status = await this.d.executor.execute(id, ctx, (old, fresh) => this.requestAgain(old, fresh));
        if (!['completed', 'partial', 'skipped'].includes(status)) {
          throw new Error(`run ${status}: ${this.d.runs.get(id)?.reason ?? ''}`);
        }
      },
    });
  }

  /** Standalone container update by config clone (RT-12): manual only, typed confirmation, never unattended. */
  async startStandalone(req: { container: string; confirm?: string }, actor: Actor): Promise<RunDetail> {
    const prepared = await this.d.standalone.prepare(req.container, req.confirm);
    if (this.d.ops.busy() || this.d.runs.running())
      throw conflict('conflict', 'Another maintenance run is in progress (one run at a time)');
    const id = randomUUID();
    this.d.runs.create({
      id,
      kind: 'update',
      trigger: 'manual',
      target: prepared.name,
      status: 'approved',
      requestedBy: actor.name,
      options: {},
    });
    this.audit(actor, 'maintenance.standalone.start', prepared.name, {
      run: id,
      from: prepared.fromImageId.slice(0, 19),
      to: prepared.toDigest.slice(0, 19),
    });
    this.d.ops.start({
      id,
      kind: 'maintenance.update',
      target: prepared.name,
      actor: actor.name,
      params: { run: id, standalone: true },
      lockKey: 'maintenance',
      run: async (ctx) => {
        const status = await this.d.standalone.execute(id, prepared, ctx);
        if (status !== 'completed') throw new Error(`run ${status}: ${this.d.runs.get(id)?.reason ?? ''}`);
      },
    });
    return this.getRun(id);
  }

  /** One-click restore of the recovery points of a finished run (RT-14); admin-confirmed, never automatic. */
  async restore(
    id: string,
    req: { confirm?: string; services?: string[] },
    actor: Actor,
  ): Promise<{ operationId: string }> {
    const run = this.d.runs.get(id);
    if (!run) throw notFound('Run');
    if (['running', 'approved', 'awaiting_approval', 'planned'].includes(run.status))
      throw conflict('conflict', `Run is ${run.status}; restore applies to finished runs`);
    if (run.kind !== 'update') throw badRequest('Only update runs have recovery points');
    if (req.confirm !== run.target)
      throw new AppError(409, 'confirmation_required', `Confirm by sending {"confirm":"${run.target}"}`, {
        expected: run.target,
      });
    const ro = this.d.guard.readOnlyReason;
    if (ro) throw new AppError(409, 'read_only', `Read-only mode: ${ro}`);
    if (this.d.ops.busy() || this.d.runs.running())
      throw conflict('conflict', 'Another maintenance run is in progress (one run at a time)');
    const opId = randomUUID();
    this.audit(actor, 'maintenance.run.restore', run.target, { run: id, services: req.services ?? 'all' });
    this.d.ops.start({
      id: opId,
      kind: 'maintenance.restore',
      target: run.target,
      actor: actor.name,
      params: { run: id, services: req.services ?? null },
      lockKey: 'maintenance',
      run: async (ctx) => {
        await this.d.executor.restore(id, req.services, actor, ctx);
      },
    });
    return { operationId: opId };
  }

  /** RT-08: a stale approval is never executed; a new request is created for the new plan. */
  private requestAgain(old: RunRow, fresh: Plan): string {
    const id = randomUUID();
    this.d.runs.create({
      id,
      kind: 'update',
      trigger: old.trigger,
      scheduleId: old.scheduleId,
      windowId: old.windowId,
      target: old.target,
      status: 'awaiting_approval',
      reason: `replaces ${old.id}, whose approved plan went stale`,
      plan: fresh,
      requestedBy: old.requestedBy,
      approvalExpiresAt: this.d.clock.now() + this.d.config.approvalExpiryMs,
      options: old.options,
    });
    this.d.notify({
      type: 'maintenance.awaiting_approval',
      severity: 'warning',
      title: `Approval needed again: ${old.target}`,
      message:
        'What was approved no longer matches reality (a tag moved or the configuration changed). Review the new plan.',
      dedupeKey: `approval:${id}`,
    });
    return id;
  }

  // ---- crash recovery (spec 7.4, RT-14) -----------------------------------------------------

  /** At startup: running runs become `interrupted` (never resumed); services left down raise a critical alert. */
  async recover(): Promise<number> {
    const interrupted = this.d.runs.interruptRunning();
    for (const run of interrupted) {
      this.d.runs.failOpenSteps(run.id);
      const guidance: string[] = [];
      let leftDown = false;
      const intents = this.d.runs.openIntents(run.id);
      for (const it of intents) {
        const project = run.target;
        let live: { State: string; ImageID: string }[] = [];
        try {
          live = (await this.d.compose.projectContainers(project)).filter(
            (c) => c.Labels?.[LABEL.service] === it.service,
          );
        } catch {
          /* Docker unreachable: the alert below still goes out */
        }
        const down = live.length === 0 || live.some((c) => c.State !== 'running');
        guidance.push(
          `${it.service}: interrupted during "${it.action}" (from ${it.fromImage?.slice(0, 19) ?? '?'} to ${it.toImage?.slice(0, 19) ?? '?'}); it is currently ${down ? 'NOT running' : 'running'}.`,
        );
        if (down) {
          leftDown = true;
          const plan = run.plan;
          const s = plan?.services.find((x) => x.service === it.service);
          const ref = s ? parseImageRef(s.ref) : null;
          try {
            const { target } = await this.d.compose.targetOf(project);
            const files = target.files.map((f) => `--file ${f}`).join(' ');
            guidance.push(
              `${ref && s ? `docker tag ${s.fromImageId} ${ref.registry === 'docker.io' ? ref.repo.replace(/^library\//, '') : `${ref.registry}/${ref.repo}`}:${ref.tag ?? 'latest'}\n` : ''}docker compose --project-name ${project} --project-directory ${target.workingDir} ${files} up -d --no-deps --pull never --no-build -- ${it.service}`,
            );
          } catch {
            guidance.push(
              `Bring ${it.service} back with docker compose up -d --no-deps ${it.service} in project ${project}.`,
            );
          }
          this.d.notify({
            type: 'service.left_down',
            severity: 'critical',
            title: `Service left down after a crash: ${project}/${it.service}`,
            message: `Quaymaster stopped while it was recreating ${it.service}; the service is not running. Recovery: see run ${run.id}.`,
            dedupeKey: `leftdown:${run.id}:${it.service}`,
          });
        }
        this.d.runs.completeIntent(it.id);
      }
      if (guidance.length === 0) guidance.push('The run was interrupted before any container was changed.');
      this.d.runs.finish(
        run.id,
        'interrupted',
        null,
        guidance,
        'Quaymaster stopped while this run was in progress',
      );
      this.d.notify({
        type: 'run.interrupted',
        severity: leftDown ? 'critical' : 'warning',
        title: `Maintenance run interrupted: ${run.target}`,
        message: `Quaymaster stopped during run ${run.id}. It is not resumed automatically. ${guidance[0] ?? ''}`,
        dedupeKey: `interrupted:${run.id}`,
      });
      this.d.audit.record({
        actor: 'system',
        action: 'maintenance.run.interrupted',
        target: run.target,
        params: { run: run.id, leftDown },
        outcome: 'failure',
      });
    }
    return interrupted.length;
  }

  // ---- scheduler ------------------------------------------------------------------------------

  start_(intervalMs = 20_000): void {
    this.stop();
    this.timer = setInterval(
      () => void this.tick().catch((e) => this.d.log.error({ err: e }, 'scheduler tick failed')),
      intervalMs,
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One scheduler pass. Public so tests can drive time with the injected clock. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.d.clock.now();
      for (const r of this.d.runs.expireApprovals(now)) {
        this.d.notify({
          type: 'run.skipped',
          severity: 'info',
          title: `Approval expired: ${r.target}`,
          message: `The update request ${r.id} was not approved in time and was skipped.`,
          dedupeKey: `expired:${r.id}`,
        });
        this.audit({ name: 'system', ip: null }, 'maintenance.run.expired', r.target, { run: r.id });
      }
      for (const s of this.d.schedules.list()) {
        if (!s.enabled) {
          this.d.schedules.setCursor(s.id, now);
          continue;
        }
        const due = nextOccurrences(s.cron, s.timezone, s.cursorUtc, 50, now);
        for (const [i, occ] of due.entries()) {
          if (!this.d.occurrences.claim(s.id, occ, 'claimed')) continue; // RT-09: handled before, never again
          const missed = now - occ > MISSED_GRACE_MS;
          const isLatest = i === due.length - 1;
          const window = s.windowId ? this.d.windows.get(s.windowId) : undefined;
          const inWindow = !s.windowId || (!!window?.enabled && windowAt(window as WindowDef, now) !== null);
          if (missed && !(isLatest && (s.jobType === 'update' ? !!s.windowId && inWindow : true))) {
            this.d.occurrences.update(s.id, occ, 'skipped_missed', null);
            this.d.audit.record({
              actor: 'system',
              action: 'maintenance.schedule.skipped',
              target: s.name,
              params: { occurrence: new Date(occ).toISOString(), reason: 'missed' },
              outcome: 'success',
            });
            continue;
          }
          if (s.jobType === 'update' && !inWindow) {
            this.d.occurrences.update(s.id, occ, 'skipped_window', null);
            continue;
          }
          try {
            const runId = await this.fire(s, occ);
            this.d.occurrences.update(s.id, occ, 'started', runId);
          } catch (e) {
            this.d.occurrences.update(s.id, occ, 'failed', null);
            this.d.log.error({ err: e, schedule: s.name }, 'scheduled job failed to start');
          }
        }
        this.d.schedules.setCursor(s.id, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async fire(s: ScheduleRow, occ: number): Promise<string | null> {
    const actor: Actor = { name: `schedule:${s.name}`, ip: null };
    switch (s.jobType) {
      case 'update': {
        if (!s.selector.project) return null;
        const run = await this.createRun(
          { project: s.selector.project, services: s.selector.services, windowId: s.windowId },
          actor,
          { schedule: s, occurrenceUtc: occ, unattended: s.mode === 'auto' },
        );
        return run.id;
      }
      case 'image_check': {
        const before = new Set(
          (await this.d.updates.statuses())
            .filter((x) => x.state === 'update_available')
            .map((x) => `${x.ref}@${x.remoteDigest}`),
        );
        const all = await this.d.updates.statuses({ fresh: true });
        const avail = all.filter((x) => x.state === 'update_available' || x.state === 'update_staged');
        const fresh = avail.filter((x) => !before.has(`${x.ref}@${x.remoteDigest}`));
        const id = this.recordSimpleRun(
          'image_check',
          s,
          occ,
          `${avail.length} update(s) available, ${all.length} image(s) checked`,
          actor,
        );
        if (avail.length > 0) this.announceUpdates(avail, fresh.length);
        return id;
      }
      case 'image_pull': {
        const all = await this.d.updates.statuses({ fresh: true });
        let pulled = 0;
        for (const st of all.filter((x) => x.state === 'update_available' && x.remoteDigest)) {
          const modes = st.usedBy.map(
            (u) =>
              this.d.resolver.resolve({
                project: u.project,
                service: u.service,
                container: u.project ? null : u.containerName,
              }).updateMode,
          );
          if (!modes.some((m) => m === 'pull_only' || m === 'auto')) continue;
          const ref = parseImageRef(st.ref);
          if (!ref || !st.remoteDigest) continue;
          try {
            await this.d.images.pullByDigest(ref, st.remoteDigest);
            pulled++;
          } catch (e) {
            this.d.log.warn({ err: e, ref: st.ref }, 'scheduled pull failed');
          }
        }
        return this.recordSimpleRun(
          'image_pull',
          s,
          occ,
          `${pulled} image(s) pulled and staged (no container was touched)`,
          actor,
        );
      }
      case 'cleanup_report': {
        const p = await this.d.cleanup.preview({}, actor);
        this.d.notify({
          type: 'cleanup.report',
          severity: 'info',
          title: 'Cleanup report',
          message: `${p.candidates.length} item(s) could be removed (${Math.round(p.totalBytes / 1048576)} MiB). Nothing was deleted. Review in Quaymaster and run the cleanup yourself.`,
          dedupeKey: `cleanup:${new Date(occ).toISOString().slice(0, 10)}`,
        });
        return this.recordSimpleRun(
          'cleanup_report',
          s,
          occ,
          `${p.candidates.length} candidate(s), ${p.protected.length} protected`,
          actor,
        );
      }
    }
  }

  announceUpdates(
    avail: {
      ref: string;
      state: string;
      remoteDigest: string | null;
      usedBy: { containerName: string }[];
      quarantined?: boolean;
    }[],
    newCount: number,
  ): void {
    this.d.notify({
      type: 'updates.available',
      severity: 'info',
      title: `${avail.length} image update(s) available`,
      message: avail
        .slice(0, 15)
        .map(
          (a) =>
            `${a.ref} (${a.usedBy.map((u) => u.containerName).join(', ')})${a.state === 'update_staged' ? ' [staged]' : ''}`,
        )
        .join('\n'),
      // identical digests are announced once per day, not at every check
      dedupeKey: `updates:${avail
        .map((a) => `${a.ref}@${a.remoteDigest}`)
        .sort()
        .join('|')
        .slice(0, 300)}`,
      cooldownMs: 24 * 3_600_000,
      data: { count: avail.length, new: newCount },
    });
  }

  private recordSimpleRun(
    kind: 'image_check' | 'image_pull' | 'cleanup_report',
    s: ScheduleRow,
    occ: number,
    summary: string,
    actor: Actor,
  ): string {
    const id = randomUUID();
    this.d.runs.create({
      id,
      kind,
      trigger: 'schedule',
      scheduleId: s.id,
      occurrenceUtc: occ,
      target: s.name,
      status: 'completed',
      requestedBy: actor.name,
    });
    this.d.runs.finish(id, 'completed', { services: [], summary }, null);
    this.audit(actor, `maintenance.${kind}`, s.name, { run: id, summary });
    return id;
  }

  private audit(actor: Actor, action: string, target: string, params: unknown): void {
    this.d.audit.record({ actor: actor.name, ip: actor.ip, action, target, params, outcome: 'success' });
  }
}
