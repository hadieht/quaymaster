import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type Dockerode from 'dockerode';
import type {
  NotificationEvent,
  Plan,
  PlanService,
  RunResult,
  RunStatus,
  ServiceOutcome,
} from '@quaymaster/shared';
import type { AuditService } from '../audit/audit.js';
import { shQuote } from '../compose/argv.js';
import type { ComposeService } from '../compose/service.js';
import type { Config } from '../config/env.js';
import type { RunRow, RunsRepo, WindowsRepo } from '../db/maintenance.js';
import type { QuarantineRepo, RollbackRepo, StagedRepo } from '../db/updates.js';
import { LABEL } from '../docker/model.js';
import type { ImageOps } from '../docker/imageops.js';
import type { OperationContext } from '../operations/manager.js';
import { redactDeep } from '../redaction/redact.js';
import { cacheKey, engineName, parseImageRef, rollbackTag, stagedTag } from '../registry/reference.js';
import type { UpdateService } from '../updates/detector.js';
import { AppError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { windowAt, type WindowDef } from './time.js';
import { waitForHealth, type HealthDeps, type HealthSpec, type InspectLite } from './health.js';
import type { Planner } from './planner.js';
import type { Clock } from './clock.js';

/** Thrown to unwind the state machine with a final status. */
class RunStop extends Error {
  constructor(
    public readonly status: RunStatus,
    message: string,
    public readonly code: string = 'stop',
  ) {
    super(message);
  }
}

export interface ExecutorDeps {
  compose: ComposeService;
  docker: Dockerode;
  images: ImageOps;
  updates: UpdateService;
  planner: Planner;
  runs: RunsRepo;
  windows: WindowsRepo;
  rollback: RollbackRepo;
  staged: StagedRepo;
  quarantine: QuarantineRepo;
  audit: AuditService;
  notify: (e: NotificationEvent) => void;
  config: Pick<Config, 'rollbackRetentionMs'>;
  clock: Clock;
  log: Logger;
  health?: Pick<HealthDeps, 'pollMs' | 'probe' | 'sleep'>;
  /** Test seam: called after each persisted step (used to simulate time passing / a crash). */
  onStep?: (e: {
    runId: string;
    step: string;
    service: string | null;
    phase: 'start' | 'end';
  }) => void | Promise<void>;
}

interface ServiceOutcomeRec {
  service: string;
  outcome: ServiceOutcome;
  detail: string;
}

const NO_OP_ACTOR = { name: 'system', ip: null as string | null };

/**
 * Executes a stored plan: the 10-step state machine of spec 7.5 in the order amended by RT-06 —
 * Preflight → Validate (+ hash gate) → Check → Recovery point → Pull → Impact → Deploy → Health →
 * Confirm/rollback → Record. Every step is persisted; one service is deployed at a time; side-effecting
 * sub-steps write an intent first (RT-14).
 */
export class RunExecutor {
  constructor(private readonly d: ExecutorDeps) {}

  /** Test seam (see `ExecutorDeps.onStep`). */
  setStepHook(fn: ExecutorDeps['onStep']): void {
    this.d.onStep = fn;
  }
  setHealthOptions(h: ExecutorDeps['health']): void {
    this.d.health = h;
  }

  /** Executes an approved run. Resolves when the run reached a final status. */
  async execute(
    runId: string,
    ctx: OperationContext,
    onStale: (oldRun: RunRow, fresh: Plan) => string,
  ): Promise<RunStatus> {
    const run = this.d.runs.get(runId);
    if (!run || !run.plan) throw new AppError(404, 'not_found', 'Run has no plan');
    if (run.status !== 'approved') throw new AppError(409, 'conflict', `Run is ${run.status}, not approved`);
    const plan = run.plan;
    this.d.runs.markStarted(runId);
    let seq = 0;
    const outcomes: ServiceOutcomeRec[] = [];
    const guidance: string[] = [];
    const log = (t: string): void => ctx.log(`${t}\n`);

    const step = async <T>(
      name: string,
      service: string | null,
      fn: () => Promise<{ value: T; detail?: unknown; failed?: boolean }>,
    ): Promise<T> => {
      const id = this.d.runs.startStep(runId, ++seq, service, name);
      await this.d.onStep?.({ runId, step: name, service, phase: 'start' });
      try {
        const { value, detail, failed } = await fn();
        this.d.runs.finishStep(id, failed ? 'failed' : 'succeeded', detail);
        await this.d.onStep?.({ runId, step: name, service, phase: 'end' });
        return value;
      } catch (e) {
        this.d.runs.finishStep(id, e instanceof RunStop && e.status === 'skipped' ? 'skipped' : 'failed', {
          error: (e as Error).message,
        });
        throw e;
      }
    };

    let status: RunStatus = 'completed';
    let reason: string | null = null;
    try {
      const ro = this.d.compose ? null : null;
      void ro;
      // ---- 1. preflight ------------------------------------------------------------------
      const fresh = await step('preflight', null, async () => {
        if (run.approvedPlanHash !== plan.planHash)
          throw new RunStop(
            'approval_stale',
            'The approved plan hash does not match the stored plan',
            'approval_stale',
          );
        let windowEnd: number | null = null;
        if (run.windowId && run.options.ignoreWindow !== true) {
          const w = this.d.windows.get(run.windowId);
          const span = w ? windowAt(w as WindowDef, this.d.clock.now()) : null;
          if (!w || !w.enabled || !span)
            throw new RunStop(
              'skipped',
              'The maintenance window is closed; the run did not start',
              'window_closed',
            );
          windowEnd = span.end;
          this.d.runs.setWindowEnd(runId, windowEnd);
        }
        const names = plan.services.filter((s) => s.role === 'update').map((s) => s.service);
        const fresh = await this.d.planner.planProject({
          project: plan.target,
          services: names,
          scheduleMode: run.options.scheduleMode ?? null,
          onlyModes: run.options.onlyModes,
          applyDrift: run.options.applyDrift === true,
          allowUnhealthy: run.options.allowUnhealthy === true,
          fresh: true,
        });
        return {
          value: { plan: fresh, windowEnd },
          detail: { planHash: fresh.planHash, checks: fresh.preflight.checks },
        };
      });
      const windowEnd = fresh.windowEnd;
      const current = fresh.plan;
      // ---- 2. validate (+ RT-01 hash gate) -----------------------------------------------
      await step('validate', null, async () => {
        if (
          current.blocked &&
          ['validation', 'blocked_drift', 'cycle', 'limited_capability', 'refused'].includes(
            current.blocked.code,
          )
        ) {
          throw new RunStop('blocked', current.blocked.message, current.blocked.code);
        }
        if (current.blocked && current.blocked.code === 'preflight')
          throw new RunStop('blocked', current.blocked.message, 'preflight');
        if (current.planHash !== plan.planHash) {
          throw new RunStop(
            'approval_stale',
            `The plan changed since it was approved: ${describeDiff(plan, current)}`,
            'approval_stale',
          );
        }
        if (current.blocked) throw new RunStop('blocked', current.blocked.message, current.blocked.code);
        return { value: undefined, detail: { warnings: current.validation.warnings, drift: current.drift } };
      });
      // ---- 3. check ----------------------------------------------------------------------
      await step('check', null, async () => ({
        value: undefined,
        detail: {
          digests: plan.services
            .filter((s) => s.role === 'update')
            .map((s) => ({ service: s.service, from: s.fromDigest, to: s.toDigest })),
        },
      }));

      const { target } = await this.d.compose.targetOf(plan.target, true);
      // ---- 4. recovery point -------------------------------------------------------------
      await step('recovery_point', null, async () => {
        const snapshot = await this.snapshot(plan.target, target.files);
        for (const s of plan.services) {
          const live = (await this.d.compose.projectContainers(plan.target)).filter(
            (c) => c.Labels?.[LABEL.service] === s.service,
          );
          // the rollback image ID comes from the RUNNING container, never from the tag (RT-06)
          const imageId = live[0]?.ImageID;
          if (!imageId || imageId !== s.fromImageId)
            throw new RunStop(
              'approval_stale',
              `${s.service} no longer runs the planned image`,
              'approval_stale',
            );
          const tag = rollbackTag(plan.target, s.service, runId);
          await this.d.images.tag(imageId, tag);
          this.d.rollback.put({
            tag,
            run_id: runId,
            project: plan.target,
            service: s.service,
            container_name: s.containers[0]?.name ?? null,
            ref: s.ref,
            image_id: imageId,
            created_at: this.d.clock.now(),
            expires_at: this.d.clock.now() + this.d.config.rollbackRetentionMs,
          });
        }
        log(`recovery points tagged for: ${plan.order.join(', ')}`);
        return { value: undefined, detail: snapshot };
      });

      // ---- 5. pull (by digest, staged; the user-visible tag does not move) --------------------
      const stagedIds = new Map<string, string>();
      await step('pull', null, async () => {
        const pulled: { ref: string; digest: string; stagedTag: string }[] = [];
        for (const s of plan.services.filter((x) => x.role === 'update')) {
          const ref = parseImageRef(s.ref);
          if (!ref || !s.toDigest) throw new RunStop('failed', `cannot pull ${s.ref}`, 'pull_failed');
          const tag = stagedTag(ref, s.toDigest);
          let id = (await this.d.images.inspect(tag))?.Id ?? null;
          if (!id) {
            log(`pulling ${engineName(ref)}@${s.toDigest}`);
            try {
              const res = await this.d.images.pullByDigest(ref, s.toDigest, (p) => {
                if (
                  p.status &&
                  (p.status.startsWith('Pull') ||
                    p.status.startsWith('Digest') ||
                    p.status.startsWith('Status'))
                )
                  ctx.log(`${p.status}\n`);
              });
              id = res.imageId;
            } catch (e) {
              throw new RunStop(
                'failed',
                `Pull failed: ${(e as Error).message}. Nothing was restarted, recreated or retagged; the services are untouched.`,
                'pull_failed',
              );
            }
          }
          stagedIds.set(s.service, id);
          pulled.push({ ref: s.ref, digest: s.toDigest, stagedTag: tag });
        }
        return { value: undefined, detail: { pulled } };
      });

      // ---- 6. impact ---------------------------------------------------------------------
      await step('impact', null, async () => ({
        value: undefined,
        detail: { impact: plan.impact, order: plan.order },
      }));

      // ---- 7-9. deploy → health → confirm/rollback, one service at a time -------------------------
      const pending = new Set(plan.order);
      const skipRest = (detail: string, stepReason: string): void => {
        for (const rest of plan.services.filter((x) => pending.has(x.service))) {
          outcomes.push({ service: rest.service, outcome: 'skipped', detail });
          this.d.runs.finishStep(this.d.runs.startStep(runId, ++seq, rest.service, 'deploy'), 'skipped', {
            reason: stepReason,
          });
        }
        pending.clear();
      };
      const anyUpdated = (): boolean =>
        outcomes.some((o) => o.outcome === 'updated' || o.outcome === 'dependent_recreated');
      for (const s of plan.services) {
        // stop conditions are evaluated BEFORE starting a service; health/rollback below never are (RT-09)
        if (ctx.shuttingDown) {
          skipRest('Quaymaster is shutting down; the service was not started', 'shutdown');
          status = anyUpdated() ? 'partial' : 'skipped';
          reason =
            'Quaymaster is shutting down; the remaining services were skipped (nothing was interrupted)';
          break;
        }
        if (windowEnd !== null && this.d.clock.now() + s.health.timeoutSeconds * 1000 > windowEnd) {
          skipRest('the maintenance window closes before it could finish', 'window closes');
          status = anyUpdated() ? 'partial' : 'skipped';
          reason = 'The maintenance window closed; the remaining services were skipped';
          break;
        }
        await this.assertNoConflict(plan, [...pending]);
        // RT-01: the hash gate runs again right before EVERY recreate, not only at preflight
        const drift = await this.driftBefore(target, s);
        if (drift) {
          skipRest(`configuration drift detected during the run (${drift})`, 'drift');
          status = anyUpdated() ? 'partial' : 'blocked';
          reason = `${s.service}: ${drift}. The run stopped before recreating it; nothing was rolled back.`;
          guidance.push(
            'The Compose configuration changed while the run was in progress. Review the change, then create a new run (with applyDrift to apply it deliberately).',
          );
          this.d.notify({
            type: 'run.failed',
            severity: 'critical',
            title: `Maintenance run stopped: ${plan.target}/${s.service} changed during the run`,
            message: reason,
            dedupeKey: `drift:${runId}:${s.service}`,
          });
          break;
        }
        pending.delete(s.service);
        const res = await this.deployOne(
          runId,
          plan,
          s,
          target,
          stagedIds.get(s.service) ?? null,
          step,
          log,
          ctx,
        );
        outcomes.push({ service: s.service, outcome: res.outcome, detail: res.detail });
        if (res.guidance) guidance.push(...res.guidance);
        if (res.outcome === 'updated' || res.outcome === 'dependent_recreated') continue;
        // failure: stop the rollout, remaining services are skipped
        status = res.outcome === 'rolled_back' ? 'rolled_back' : 'failed';
        reason = res.detail;
        skipRest(`rollout stopped after ${s.service} failed`, `rollout stopped after ${s.service}`);
        break;
      }
    } catch (e) {
      // test seam: a simulated process crash leaves the database exactly as a killed process would
      if (e instanceof Error && e.name === 'SimulatedCrash') throw e;
      if (e instanceof RunStop) {
        status = e.status;
        reason = e.message;
        if (e.status === 'approval_stale') {
          const fresh = await this.d.planner
            .planProject({
              project: plan.target,
              services: plan.services.filter((s) => s.role === 'update').map((s) => s.service),
              scheduleMode: run.options.scheduleMode ?? null,
              onlyModes: run.options.onlyModes,
              applyDrift: run.options.applyDrift === true,
              fresh: true,
            })
            .catch(() => null);
          if (fresh && !fresh.blocked) {
            const newId = onStale(run, fresh);
            reason = `${e.message}. A new approval request was created (${newId}).`;
          }
        }
        if (e.code === 'pull_failed')
          guidance.push('Nothing was changed. Fix the registry / network problem and run the update again.');
        if (e.code === 'blocked_drift')
          guidance.push(
            'Review the configuration drift, then re-create the run with applyDrift to apply it deliberately.',
          );
      } else {
        status = 'failed';
        reason = `Unexpected error: ${(e as Error).message}`;
        this.d.log.error({ err: e, run: runId }, 'run crashed');
      }
    }

    return this.record(run, plan, status, reason, outcomes, guidance, ctx);
  }

  /** One-click restore (RT-14): puts the recorded previous image back for the run's services and re-checks them. */
  async restore(
    runId: string,
    only: string[] | undefined,
    actor: { name: string; ip: string | null },
    ctx: OperationContext,
  ): Promise<void> {
    const run = this.d.runs.get(runId);
    if (!run || !run.plan) throw new AppError(404, 'not_found', 'Run has no plan');
    const plan = run.plan;
    const points = this.d.rollback.forRun(runId);
    const svcOf = (x: { service: string | null }): string => x.service ?? '';
    if (points.length === 0)
      throw new AppError(409, 'conflict', 'This run has no recovery points to restore');
    if (points.length === 0)
      throw new AppError(409, 'conflict', 'This run has no recovery points to restore');
    const { target } = await this.d.compose.targetOf(plan.target, true);
    let seq = 20_000;
    const failures: string[] = [];
    // reverse deployment order: dependents first, dependencies last
    const order = [...plan.order].reverse();
    points.sort((a, b) => order.indexOf(svcOf(a)) - order.indexOf(svcOf(b)));
    for (const pt of points) {
      const p = { ...pt, service: svcOf(pt) };
      const s = plan.services.find((x) => x.service === p.service);
      const ref = parseImageRef(p.ref);
      if (!s || !ref) continue;
      const repoTag = `${engineName(ref)}:${ref.tag ?? 'latest'}`;
      const stepId = this.d.runs.startStep(runId, ++seq, p.service, 'restore');
      try {
        const img = await this.d.images.inspect(p.image_id);
        if (!img) throw new Error('the recovery image no longer exists locally');
        await this.d.images.tag(p.image_id, repoTag);
        ctx.log(`restoring ${p.service} to ${p.image_id.slice(0, 19)}\n`);
        const dep = await this.d.compose.deployServices(
          target,
          { services: [p.service], forceRecreate: false, noStart: !s.wasRunning },
          (c) => ctx.log(c),
        );
        if (dep.code !== 0) throw new Error(`compose up exited ${dep.code}: ${dep.stderrTail}`);
        if (s.wasRunning) {
          const live = (await this.d.compose.projectContainers(plan.target)).filter(
            (c) => c.Labels?.[LABEL.service] === p.service,
          );
          const h = await this.health(
            live.map((c) => c.Id),
            s,
            p.image_id,
          );
          if (!h.ok) throw new Error(h.reason);
        }
        this.d.runs.finishStep(stepId, 'succeeded');
      } catch (e) {
        failures.push(`${p.service}: ${(e as Error).message}`);
        this.d.runs.finishStep(stepId, 'failed', { error: (e as Error).message });
      }
    }
    this.d.compose.invalidate();
    this.d.audit.record({
      actor: actor.name,
      ip: actor.ip,
      action: 'maintenance.restore',
      target: plan.target,
      params: { run: runId, services: points.map((p) => p.service), failures },
      outcome: failures.length ? 'failure' : 'success',
    });
    this.d.notify({
      type: failures.length ? 'run.failed' : 'run.rolled_back',
      severity: failures.length ? 'critical' : 'warning',
      title: `Restore ${failures.length ? 'failed' : 'completed'}: ${plan.target}`,
      message: failures.length ? failures.join('; ') : `Restored ${points.map((p) => p.service).join(', ')}`,
      dedupeKey: `restore:${runId}:${Date.now()}`,
    });
    if (failures.length) throw new Error(`restore failed: ${failures.join('; ')}`);
  }

  // ---- one service ------------------------------------------------------------------------

  /**
   * One service: the write-ahead intent is opened before the first side effect and completed only when the
   * service outcome is final (healthy, rolled back and re-verified, or left as is). A crash anywhere in
   * between leaves it open, so `recover()` can compare the live state with `fromImage` / `toImage` (RT-14).
   */
  private async deployOne(
    runId: string,
    plan: Plan,
    s: PlanService,
    target: { projectName: string; workingDir: string; files: string[] },
    stagedImageId: string | null,
    step: <T>(
      name: string,
      service: string | null,
      fn: () => Promise<{ value: T; detail?: unknown; failed?: boolean }>,
    ) => Promise<T>,
    log: (t: string) => void,
    ctx: OperationContext,
  ): Promise<{ outcome: ServiceOutcome; detail: string; guidance?: string[] }> {
    const intent = this.d.runs.addIntent({
      operationId: runId,
      service: s.service,
      action: 'deploy',
      fromImage: s.fromImageId,
      toImage: s.role === 'update' ? (stagedImageId ?? null) : null,
      containerIdsBefore: s.containers.map((c) => c.id),
    });
    try {
      const res = await this.deployInner(runId, plan, s, target, stagedImageId, step, log, ctx);
      this.d.runs.completeIntent(intent);
      return res;
    } catch (e) {
      // a simulated crash must look like a killed process: the intent stays open
      if (!(e instanceof Error && e.name === 'SimulatedCrash')) this.d.runs.completeIntent(intent);
      throw e;
    }
  }

  private async deployInner(
    runId: string,
    plan: Plan,
    s: PlanService,
    target: { projectName: string; workingDir: string; files: string[] },
    stagedImageId: string | null,
    step: <T>(
      name: string,
      service: string | null,
      fn: () => Promise<{ value: T; detail?: unknown; failed?: boolean }>,
    ) => Promise<T>,
    log: (t: string) => void,
    ctx: OperationContext,
  ): Promise<{ outcome: ServiceOutcome; detail: string; guidance?: string[] }> {
    const ref = parseImageRef(s.ref);
    const repoTag = ref ? `${engineName(ref)}:${ref.tag ?? 'latest'}` : s.ref;
    const isUpdate = s.role === 'update';

    // expected image after deploy
    let expected = s.fromImageId;
    if (isUpdate) {
      if (!stagedImageId) return { outcome: 'failed', detail: 'staged image missing' };
      expected = stagedImageId;
    }

    // ---- 7. deploy (the user-visible tag moves only here, RT-07)
    const deployRes = await step<{ ok: boolean; why: string }>('deploy', s.service, async () => {
      try {
        if (isUpdate) await this.d.images.tag(expected, repoTag);
        else expected = (await this.d.images.inspect(s.ref))?.Id ?? s.fromImageId;
        log(
          `deploying ${s.service}${s.wasRunning ? '' : ' (stays stopped: --no-start)'}${isUpdate ? '' : ' (namespace dependent: recreated with its provider)'}`,
        );
        const r = await this.d.compose.deployServices(
          target,
          { services: [s.service], forceRecreate: !isUpdate, noStart: !s.wasRunning },
          (c) => ctx.log(c),
        );
        this.d.audit.record({
          actor: 'system',
          action: 'maintenance.deploy',
          target: `${plan.target}/${s.service}`,
          params: { run: runId, image: expected.slice(0, 19), argv: r.argv },
          outcome: r.code === 0 ? 'success' : 'failure',
        });
        if (r.code !== 0)
          return {
            value: {
              ok: false as const,
              why: `docker compose up exited with code ${r.code}: ${r.stderrTail}`,
            },
            failed: true,
            detail: { code: r.code },
          };
        return { value: { ok: true as const, why: '' }, detail: { argv: r.argv } };
      } catch (e) {
        return {
          value: { ok: false as const, why: (e as Error).message },
          failed: true,
          detail: { error: (e as Error).message },
        };
      }
    });
    // the intent stays open through health and rollback: a crash anywhere before the outcome is final must be
    // reported truthfully by recover() (RT-14)

    // ---- 8. health (always completes, regardless of the window)
    let healthy = false;
    let why = deployRes.why;
    if (deployRes.ok) {
      const live = (await this.d.compose.projectContainers(plan.target)).filter(
        (c) => c.Labels?.[LABEL.service] === s.service,
      );
      if (!s.wasRunning) {
        // stays stopped: only assert that it was recreated on the expected image
        healthy = live.length > 0 && live.every((c) => c.ImageID === expected);
        why = healthy ? '' : 'the recreated container does not use the expected image';
        await step('health', s.service, async () => ({
          value: undefined,
          detail: { skipped: 'service was stopped; stays stopped', ok: healthy },
        }));
      } else {
        const r = await step('health', s.service, async () => {
          const res = await this.health(
            live.map((c) => c.Id),
            s,
            expected,
          );
          return {
            value: res,
            failed: !res.ok,
            detail: { ok: res.ok, reason: res.reason, ms: res.elapsedMs },
          };
        });
        healthy = r.ok;
        why = r.reason;
        // RT-29: dependents of a recreated service are re-verified
        if (healthy && isUpdate) {
          const dep = await this.verifyDependents(plan, s, step);
          if (dep) {
            return {
              outcome: 'failed',
              detail: `${s.service} is healthy but its dependent "${dep}" is not; the rollout was stopped and nothing was rolled back automatically`,
              guidance: [
                `Check the dependent service "${dep}" (docker compose logs). ${s.service} runs the new image.`,
              ],
            };
          }
        }
      }
    }
    if (healthy) {
      this.d.staged.delete(stagedTag(ref ?? { registry: 'docker.io', repo: s.ref }, s.toDigest ?? ''));
      if (isUpdate && ref && s.toDigest) {
        // the user-visible tag now holds the image: the staged alias can go (an untag, never an image delete)
        await this.d.images.remove(stagedTag(ref, s.toDigest)).catch(() => undefined);
      }
      return {
        outcome: isUpdate ? 'updated' : 'dependent_recreated',
        detail: isUpdate ? `now on ${s.toDigest?.slice(0, 19)}` : 'recreated',
      };
    }

    // ---- 9. failure: quarantine, then rollback or exact manual recovery
    if (isUpdate && ref && s.toDigest) {
      if (this.d.quarantine.add(cacheKey(ref), s.toDigest, runId, why, this.d.clock.now())) {
        this.d.notify({
          type: 'run.failed',
          severity: 'warning',
          title: `Update quarantined: ${plan.target}/${s.service}`,
          message: `The image ${s.toDigest.slice(0, 19)} failed its health gate and will not be retried by unattended runs until the tag moves or you clear the quarantine.`,
          dedupeKey: `quarantine:${cacheKey(ref)}:${s.toDigest}`,
          cooldownMs: 24 * 3_600_000,
        });
      }
    }
    const manual = this.manualRecovery(target, plan.target, s, repoTag);
    // RT-07 / F-08: the update did not stick, so the shared tag must not keep pointing at the failing image
    // (the next `compose up` of any project using it would deploy it again)
    let tagRestored = false;
    if (isUpdate && (!s.autoRollback || !deployRes.ok)) {
      tagRestored = await this.d.images.tag(s.fromImageId, repoTag).then(
        () => true,
        () => false,
      );
    }
    if (!s.autoRollback || !isUpdate) {
      return {
        outcome: 'failed_left_as_is',
        detail: `${s.service} failed its health gate (${why}). ${isUpdate ? `Automatic rollback is off for it (${s.autoRollbackReason}); it was left as is${tagRestored ? `, but the tag ${repoTag} was put back on the previous image so a later "compose up" does not redeploy the failing one` : ''}.` : 'Left as is.'}`,
        guidance: manual,
      };
    }
    const rb = await this.rollbackService(runId, plan, s, target, repoTag, step, log, ctx);
    if (rb.ok) {
      return {
        outcome: 'rolled_back',
        detail: `${s.service} failed its health gate (${why}) and was rolled back to the previous image, which is healthy again`,
      };
    }
    return {
      outcome: 'failed',
      detail: `${s.service} failed its health gate (${why}) and the automatic rollback also failed: ${rb.why}`,
      guidance: manual,
    };
  }

  /**
   * RT-01: compares the service's current `compose config --hash` with the one the approved plan was made
   * against. Returns a description when they differ (or cannot be computed — fail closed), else null.
   */
  private async driftBefore(
    target: { projectName: string; workingDir: string; files: string[] },
    s: PlanService,
  ): Promise<string | null> {
    if (!s.configHash) return null;
    try {
      const now = (await this.d.compose.configHashes(target, [s.service])).get(s.service);
      if (!now) return 'its configuration can no longer be resolved';
      return now === s.configHash ? null : 'its Compose configuration changed after the plan was approved';
    } catch (e) {
      return `its configuration hash could not be verified (${(e as Error).message.slice(0, 200)})`;
    }
  }

  /** Re-tags the previous image ID and redeploys; asserts the image and re-runs the health gate. */
  async rollbackService(
    runId: string,
    plan: Plan,
    s: PlanService,
    target: { projectName: string; workingDir: string; files: string[] },
    repoTag: string,
    step: <T>(
      name: string,
      service: string | null,
      fn: () => Promise<{ value: T; detail?: unknown; failed?: boolean }>,
    ) => Promise<T>,
    log: (t: string) => void,
    ctx: OperationContext,
  ): Promise<{ ok: boolean; why: string }> {
    const point = this.d.rollback.get(rollbackTag(plan.target, s.service, runId));
    const oldId = point?.image_id ?? s.fromImageId;
    const intent = this.d.runs.addIntent({
      operationId: runId,
      service: s.service,
      action: 'rollback',
      fromImage: null,
      toImage: oldId,
      containerIdsBefore: (await this.d.compose.projectContainers(plan.target))
        .filter((c) => c.Labels?.[LABEL.service] === s.service)
        .map((c) => c.Id),
    });
    const r = await step<{ ok: boolean; why: string }>('rollback', s.service, async () => {
      try {
        await this.d.images.tag(oldId, repoTag);
        log(`rolling ${s.service} back to ${oldId.slice(0, 19)}`);
        const dep = await this.d.compose.deployServices(
          target,
          { services: [s.service], forceRecreate: false, noStart: !s.wasRunning },
          (c) => ctx.log(c),
        );
        this.d.audit.record({
          actor: 'system',
          action: 'maintenance.rollback',
          target: `${plan.target}/${s.service}`,
          params: { run: runId, image: oldId.slice(0, 19) },
          outcome: dep.code === 0 ? 'success' : 'failure',
        });
        if (dep.code !== 0)
          return { value: { ok: false, why: `compose up exited ${dep.code}: ${dep.stderrTail}` } };
        const live = (await this.d.compose.projectContainers(plan.target)).filter(
          (c) => c.Labels?.[LABEL.service] === s.service,
        );
        if (!s.wasRunning)
          return { value: { ok: live.every((c) => c.ImageID === oldId), why: 'image check' } };
        // after rollback the image is asserted again and the health gate re-run (RT-06)
        const h = await this.health(
          live.map((c) => c.Id),
          s,
          oldId,
        );
        return {
          value: { ok: h.ok, why: h.reason },
          failed: !h.ok,
          detail: { ok: h.ok, reason: h.reason },
        };
      } catch (e) {
        return { value: { ok: false, why: (e as Error).message } };
      }
    });
    this.d.runs.completeIntent(intent);
    return r;
  }

  private async health(containerIds: string[], s: PlanService, expectedImageId: string) {
    const spec: HealthSpec = {
      kind: s.health.kind,
      timeoutMs: s.health.timeoutSeconds * 1000,
      stabilizationMs: s.health.stabilizationSeconds * 1000,
      probe: s.health.probe,
      expectedImageId,
    };
    return waitForHealth(
      {
        inspect: (id) => this.inspectLite(id),
        now: () => Date.now(),
        pollMs: this.d.health?.pollMs,
        sleep: this.d.health?.sleep,
        probe: this.d.health?.probe ?? defaultProbe,
      },
      containerIds,
      spec,
    );
  }

  private async inspectLite(id: string): Promise<InspectLite | null> {
    try {
      const i = await this.d.docker.getContainer(id).inspect();
      return {
        Image: i.Image,
        RestartCount: i.RestartCount,
        State: {
          Status: i.State.Status,
          Running: i.State.Running,
          Restarting: i.State.Restarting,
          ExitCode: i.State.ExitCode,
          StartedAt: i.State.StartedAt,
          Health: (i.State as { Health?: { Status: string } }).Health ?? null,
        },
      };
    } catch {
      return null;
    }
  }

  /** RT-29: after a dependency was recreated, the services that depend on it must still be healthy. */
  private async verifyDependents(
    plan: Plan,
    s: PlanService,
    step: <T>(
      name: string,
      service: string | null,
      fn: () => Promise<{ value: T; detail?: unknown; failed?: boolean }>,
    ) => Promise<T>,
  ): Promise<string | null> {
    const inRun = new Set(plan.services.map((x) => x.service));
    const deps = [
      ...new Set(
        plan.impact.dependents
          .filter((d) => d.via === s.service && d.kind === 'depends_on' && !inRun.has(d.service))
          .map((d) => d.service),
      ),
    ];
    if (deps.length === 0) return null;
    const graph = (await this.d.compose.detail(plan.target)).graph;
    for (const dep of deps) {
      const live = (await this.d.compose.projectContainers(plan.target)).filter(
        (c) => c.Labels?.[LABEL.service] === dep && c.State !== 'exited' && c.State !== 'created',
      );
      if (live.length === 0) continue; // a stopped dependent is none of our business
      const restart = graph.edges.find((e) => e.from === dep && e.to === s.service)?.restart === true;
      const check = async (): Promise<boolean> => {
        const first = await this.inspectLite(live[0]?.Id ?? '');
        if (!first) return false;
        const hasHc = first.State.Health && first.State.Health.Status !== 'none';
        const r = await waitForHealth(
          {
            inspect: (id) => this.inspectLite(id),
            pollMs: this.d.health?.pollMs,
            sleep: this.d.health?.sleep,
          },
          live.map((c) => c.Id),
          {
            kind: hasHc ? 'healthcheck' : 'stability',
            timeoutMs: 30_000,
            stabilizationMs: 3000,
            probe: null,
            expectedImageId: first.Image,
          },
        );
        return r.ok;
      };
      const ok = await step('health', dep, async () => {
        let good = await check();
        if (!good && restart) {
          for (const c of live) await this.restartContainer(c.Id);
          good = await check();
        }
        return {
          value: good,
          detail: { dependentOf: s.service, restartedBecauseDeclared: !good ? false : restart },
        };
      });
      if (!ok) return dep;
    }
    return null;
  }

  private async restartContainer(id: string): Promise<void> {
    // Engine API restart through the service layer (guard + permit)
    const { withPermit } = await import('../security/guard.js');
    await withPermit({ containerId: id, action: 'restart' }, () =>
      this.d.docker.getContainer(id).restart({ t: 5 }),
    ).catch(() => undefined);
  }

  /** RT-14: if another tool changed the run's containers meanwhile, abort WITHOUT rolling back. */
  private async assertNoConflict(plan: Plan, pending: string[]): Promise<void> {
    const live = await this.d.compose.projectContainers(plan.target);
    for (const name of pending) {
      const s = plan.services.find((x) => x.service === name);
      if (!s) continue;
      const ids = live
        .filter((c) => c.Labels?.[LABEL.service] === name)
        .map((c) => c.Id)
        .sort();
      const planned = s.containers.map((c) => c.id).sort();
      const sameIds = ids.length === planned.length && ids.every((x, i) => x === planned[i]);
      const sameImage = live
        .filter((c) => c.Labels?.[LABEL.service] === name)
        .every((c) => c.ImageID === s.fromImageId);
      if (!sameIds || !sameImage) {
        this.d.notify({
          type: 'run.conflict',
          severity: 'critical',
          title: `Maintenance run aborted: ${plan.target}/${name} changed underneath it`,
          message: `Another tool recreated or modified ${name} while the run was in progress. The run stopped and did NOT roll anything back.`,
          dedupeKey: `conflict:${plan.target}:${name}`,
        });
        throw new RunStop(
          'failed',
          `Another tool changed ${name} during the run (containers or image differ from the plan). The run stopped without rolling back.`,
          'conflict',
        );
      }
    }
  }

  private async snapshot(project: string, files: string[]): Promise<unknown> {
    const hashes = files.map((f) => {
      try {
        return { file: f, sha256: createHash('sha256').update(readFileSync(f)).digest('hex') };
      } catch {
        return { file: f, sha256: null };
      }
    });
    let config: unknown = null;
    try {
      config = redactDeep((await this.d.compose.resolvedConfig(project)).config);
    } catch {
      /* the snapshot is best-effort; validation already passed */
    }
    return { files: hashes, redactedConfig: config };
  }

  private manualRecovery(
    target: { projectName: string; workingDir: string; files: string[] },
    project: string,
    s: PlanService,
    repoTag: string,
  ): string[] {
    const files = target.files.map((f) => `--file ${shQuote(f)}`).join(' ');
    const cmds = [
      `docker tag ${s.fromImageId} ${shQuote(repoTag)}`,
      `docker compose --project-name ${shQuote(project)} --project-directory ${shQuote(target.workingDir)} ${files} up -d --no-deps --no-build --pull never -- ${shQuote(s.service)}`,
    ];
    return [
      `To restore ${s.service} to the previous image (${s.fromImageId.slice(0, 19)}), run:`,
      ...cmds,
      ...(s.dataRisk.flagged
        ? [
            'Note: the service has persistent mounts. If the new version migrated its data, the old image may not start; restore your backup first.',
          ]
        : []),
    ];
  }

  // ---- 10. record & notify ---------------------------------------------------------------------

  private record(
    run: RunRow,
    plan: Plan,
    status: RunStatus,
    reason: string | null,
    outcomes: ServiceOutcomeRec[],
    guidance: string[],
    ctx: OperationContext,
  ): RunStatus {
    const summary =
      status === 'completed'
        ? `Updated ${outcomes.filter((o) => o.outcome === 'updated').length} service(s) in ${plan.target}`
        : (reason ?? status);
    const result: RunResult = { services: outcomes, summary };
    const id = this.d.runs.startStep(run.id, 9999, null, 'record');
    this.d.runs.finishStep(id, 'succeeded', { status });
    this.d.runs.finish(run.id, status, result, guidance.length ? guidance : null, reason);
    this.d.compose.invalidate();
    this.d.updates.statuses({ fresh: false }).catch(() => undefined);
    this.d.audit.record({
      actor: run.approvedBy ?? run.requestedBy,
      action: 'maintenance.run.finish',
      target: `${plan.target}`,
      params: {
        run: run.id,
        status,
        planHash: plan.planHash,
        approvedPlanHash: run.approvedPlanHash,
        summary,
      },
      outcome: status === 'completed' || status === 'partial' || status === 'skipped' ? 'success' : 'failure',
      durationMs: run.startedAt ? this.d.clock.now() - run.startedAt : null,
    });
    ctx.log(`run ${run.id} finished: ${status}${reason ? ` — ${reason}` : ''}\n`);
    this.d.notify(notificationFor(run, plan, status, summary, guidance));
    return status;
  }
}

function describeDiff(a: Plan, b: Plan): string {
  const out: string[] = [];
  const ma = new Map(a.services.map((s) => [s.service, s]));
  const mb = new Map(b.services.map((s) => [s.service, s]));
  for (const [n, s] of ma) {
    const t = mb.get(n);
    if (!t) out.push(`${n} is no longer part of the plan`);
    else {
      if (t.toDigest !== s.toDigest) out.push(`${n}: target digest moved`);
      if (t.fromImageId !== s.fromImageId) out.push(`${n}: running image changed`);
      if (t.configHash !== s.configHash) out.push(`${n}: configuration changed`);
    }
  }
  for (const n of mb.keys()) if (!ma.has(n)) out.push(`${n} was added`);
  return out.length ? out.join('; ') : 'service order or policy changed';
}

async function defaultProbe(url: string): Promise<number> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'manual' });
    return res.status;
  } finally {
    clearTimeout(t);
  }
}

export function notificationFor(
  run: RunRow,
  plan: Plan,
  status: RunStatus,
  summary: string,
  guidance: string[],
): NotificationEvent {
  const base = { dedupeKey: `run:${run.id}`, data: { run: run.id, target: plan.target, status } };
  switch (status) {
    case 'completed':
      return {
        type: 'run.succeeded',
        severity: 'info',
        title: `Update completed: ${plan.target}`,
        message: summary,
        ...base,
      };
    case 'rolled_back':
      return {
        type: 'run.rolled_back',
        severity: 'warning',
        title: `Update rolled back: ${plan.target}`,
        message: summary,
        ...base,
      };
    case 'partial':
      return {
        type: 'run.partial',
        severity: 'warning',
        title: `Update partially completed: ${plan.target}`,
        message: summary,
        ...base,
      };
    case 'skipped':
      return {
        type: 'run.skipped',
        severity: 'info',
        title: `Update skipped: ${plan.target}`,
        message: summary,
        ...base,
      };
    default:
      return {
        type: 'run.failed',
        severity: 'critical',
        title: `Update ${status}: ${plan.target}`,
        message: `${summary}${guidance.length ? `\n${guidance.join('\n')}` : ''}`,
        ...base,
      };
  }
}

export { NO_OP_ACTOR };
