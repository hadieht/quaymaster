import type Dockerode from 'dockerode';
import type { NotificationEvent } from '@quaymaster/shared';
import type { AuditService } from '../audit/audit.js';
import type { Config } from '../config/env.js';
import type { RunsRepo } from '../db/maintenance.js';
import type { RollbackRepo, StagedRepo } from '../db/updates.js';
import type { ContainerService } from '../docker/containers.js';
import type { ImageOps } from '../docker/imageops.js';
import type { OperationContext } from '../operations/manager.js';
import { engineName, parseImageRef, rollbackTag, stagedTag } from '../registry/reference.js';
import { withPermit, type Guard } from '../security/guard.js';
import type { UpdateService } from '../updates/detector.js';
import { AppError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import type { Clock } from './clock.js';
import { buildCloneSpec } from './clone.js';
import { waitForHealth, type InspectLite } from './health.js';
import type { PolicyResolver } from './policy.js';

/** Suffix of a stopped standalone rollback point: `<name>-qm-old-<epoch seconds>`. */
export const OLD_SUFFIX_RE = /-qm-old-\d+$/;

export interface StandaloneDeps {
  docker: Dockerode;
  containers: ContainerService;
  images: ImageOps;
  updates: UpdateService;
  runs: RunsRepo;
  rollback: RollbackRepo;
  staged: StagedRepo;
  resolver: PolicyResolver;
  guard: Guard;
  audit: AuditService;
  notify: (e: NotificationEvent) => void;
  config: Pick<Config, 'rollbackRetentionMs'>;
  clock: Clock;
  log: Logger;
  health?: { pollMs?: number };
}

export interface StandalonePrepared {
  containerId: string;
  name: string;
  ref: string;
  toDigest: string;
  fromImageId: string;
}

class HealthFailure extends Error {}

/**
 * Standalone container update by config clone (RT-12). Manual only — never unattended.
 * Sequence: create the clone (stopped) → stop the old one → rename it aside → rename the clone →
 * start → health gate. Any failure: remove the clone, rename the old one back, start it, restore the tag.
 */
export class StandaloneUpdater {
  constructor(private readonly d: StandaloneDeps) {}

  /** Validates everything that can be validated before the run starts (no side effects). */
  async prepare(containerRef: string, confirm: string | undefined): Promise<StandalonePrepared> {
    const ro = this.d.guard.readOnlyReason;
    if (ro) throw new AppError(409, 'read_only', `Read-only mode: ${ro}`);
    const c = await this.d.containers.resolve(containerRef);
    if (confirm !== c.name)
      throw new AppError(409, 'confirmation_required', `Confirm by sending {"confirm":"${c.name}"}`, {
        expected: c.name,
      });
    this.d.guard.assertContainer({ id: c.id, name: c.name, project: c.project }, 'recreate');
    if (c.project)
      throw new AppError(409, 'unsupported', 'Compose-managed containers are updated through their project.');
    const statuses = await this.d.updates.statuses({ fresh: true });
    const st = statuses.find((s) => s.usedBy.some((u) => u.containerId === c.id));
    if (!st) throw new AppError(409, 'conflict', 'No update information for this container’s image');
    if ((st.state !== 'update_available' && st.state !== 'update_staged') || !st.remoteDigest)
      throw new AppError(409, 'conflict', `The image is ${st.state}; there is nothing to update`);
    // F-06 (RT-03): the tag moves for every container that uses it; refuse when that includes fenced-off ones
    const fenced = st.usedBy
      .filter((u) => u.containerId !== c.id)
      .filter((u) => {
        const r = this.d.guard.containerRefusal({
          id: u.containerId,
          name: u.containerName,
          project: u.project,
        });
        return r !== null && r.code !== 'read_only';
      })
      .map((u) => u.containerName);
    if (fenced.length > 0)
      throw new AppError(
        409,
        'out_of_scope',
        `Refused: ${fenced.join(', ')} use the same image tag but are outside QM_MANAGED_SCOPE or protected`,
      );
    const pol = this.d.resolver.resolve({ project: null, service: null, container: c.name });
    if (pol.updateMode === 'ignore')
      throw new AppError(409, 'conflict', 'The update policy of this container is "ignore"');
    const img = await this.d.images.inspect(c.raw.Image);
    if (!img) throw new AppError(409, 'conflict', 'The container’s image is no longer in the local store');
    buildCloneSpec(c.raw, img, st.ref); // validates cloneability early (network mode, --rm, ...)
    return {
      containerId: c.id,
      name: c.name,
      ref: st.ref,
      toDigest: st.remoteDigest,
      fromImageId: c.raw.Image,
    };
  }

  async execute(
    runId: string,
    p: StandalonePrepared,
    ctx: OperationContext,
  ): Promise<'completed' | 'rolled_back' | 'failed'> {
    const d = this.d;
    const run = d.runs.get(runId);
    if (!run) throw new AppError(404, 'not_found', 'Run not found');
    d.runs.markStarted(runId);
    let seq = 0;
    const log = (t: string): void => ctx.log(`${t}\n`);
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const id = d.runs.startStep(runId, ++seq, p.name, name);
      try {
        const v = await fn();
        d.runs.finishStep(id, 'succeeded');
        return v;
      } catch (e) {
        d.runs.finishStep(id, 'failed', { error: (e as Error).message });
        throw e;
      }
    };
    const ref = parseImageRef(p.ref);
    if (!ref) throw new AppError(400, 'validation', 'Invalid image reference');
    const repoTag = `${engineName(ref)}:${ref.tag ?? 'latest'}`;
    const stamp = Math.floor(d.clock.now() / 1000);
    const oldName = `${p.name}-qm-old-${stamp}`;
    const tmpName = `${p.name}-qm-new-${stamp}`;
    const guidance: string[] = [];
    let status: 'completed' | 'rolled_back' | 'failed' = 'completed';
    let reason: string | null = null;
    let newId: string | null = null;
    let oldStopped = false;
    let oldRenamed = false;
    let newRenamed = false;
    let tagMoved = false;
    let intent: number | null = null;
    let policyChanged = false;
    let origPolicy = { Name: 'no', MaximumRetryCount: 0 };
    try {
      const c = await step('preflight', async () => {
        const cur = await d.containers.resolve(p.containerId);
        if (cur.name !== p.name || cur.raw.Image !== p.fromImageId)
          throw new AppError(409, 'conflict', 'The container changed since the request; nothing was done');
        return cur;
      });
      const oldImage = await d.images.inspect(p.fromImageId);
      if (!oldImage) throw new AppError(409, 'conflict', 'The previous image is gone');
      // recovery point: the old image ID is tagged so it survives cleanup (RT-06)
      const rbTag = rollbackTag('standalone', p.name, runId);
      await step('recovery_point', async () => {
        await d.images.tag(p.fromImageId, rbTag);
        d.rollback.put({
          tag: rbTag,
          run_id: runId,
          project: 'standalone',
          service: p.name,
          container_name: oldName,
          ref: p.ref,
          image_id: p.fromImageId,
          created_at: d.clock.now(),
          expires_at: d.clock.now() + d.config.rollbackRetentionMs,
        });
      });
      const staged = await step('pull', async () => {
        const tag = stagedTag(ref, p.toDigest);
        const have = await d.images.inspect(tag);
        if (have) return have.Id;
        try {
          const res = await d.images.pullByDigest(ref, p.toDigest, (pr) => {
            if (pr.status) ctx.log(`${pr.status}\n`);
          });
          return res.imageId;
        } catch (e) {
          throw new AppError(
            502,
            'registry_error',
            `Pull failed: ${(e as Error).message}. Nothing was stopped, recreated or retagged.`,
          );
        }
      });
      const spec = buildCloneSpec(c.raw, oldImage, repoTag);
      intent = d.runs.addIntent({
        operationId: runId,
        service: p.name,
        action: 'standalone_clone',
        fromImage: p.fromImageId,
        toImage: staged,
        containerIdsBefore: [p.containerId],
      });
      // the user-visible tag moves only now, immediately before the clone is created from it (RT-07)
      await d.images.tag(staged, repoTag);
      tagMoved = true;
      newId = await step('create', async () => {
        const created = await withPermit({ kind: 'container_create', name: tmpName }, () =>
          d.docker.createContainer({ ...spec.body, name: tmpName } as Dockerode.ContainerCreateOptions),
        );
        for (const n of spec.extraNetworks) {
          await withPermit({ kind: 'network_connect', network: n.network, containerId: created.id }, () =>
            d.docker.getNetwork(n.network).connect({
              Container: created.id,
              EndpointConfig: {
                Aliases: n.aliases,
                ...(n.ipv4 || n.ipv6
                  ? { IPAMConfig: { IPv4Address: n.ipv4 ?? undefined, IPv6Address: n.ipv6 ?? undefined } }
                  : {}),
              },
            }),
          );
        }
        for (const note of spec.notes) log(note);
        return created.id;
      });
      const nid = newId;
      await step('swap', async () => {
        await withPermit({ containerId: p.containerId, action: 'stop' }, () =>
          d.docker.getContainer(p.containerId).stop({ t: 10 }),
        ).catch((e: { statusCode?: number }) => {
          if (e.statusCode !== 304) throw e;
        });
        oldStopped = true;
        // RT-12: the kept container must NOT come back after a daemon/host restart, next to the clone,
        // on the same volumes. The original policy is remembered for the undo and written into the result.
        const hp = (c.raw.HostConfig as { RestartPolicy?: { Name?: string; MaximumRetryCount?: number } })
          .RestartPolicy;
        origPolicy = { Name: hp?.Name || 'no', MaximumRetryCount: hp?.MaximumRetryCount ?? 0 };
        if (origPolicy.Name !== 'no') {
          await withPermit({ kind: 'container_restart_policy', containerId: p.containerId }, () =>
            d.docker
              .getContainer(p.containerId)
              .update({ RestartPolicy: { Name: 'no', MaximumRetryCount: 0 } } as never),
          );
          policyChanged = true;
        }
        await withPermit({ kind: 'container_rename', containerId: p.containerId, newName: oldName }, () =>
          d.docker.getContainer(p.containerId).rename({ name: oldName }),
        );
        oldRenamed = true;
        await withPermit({ kind: 'container_rename', containerId: nid, newName: p.name }, () =>
          d.docker.getContainer(nid).rename({ name: p.name }),
        );
        newRenamed = true;
        if (c.raw.State.Running)
          await withPermit({ containerId: nid, action: 'start' }, () => d.docker.getContainer(nid).start());
      });
      d.audit.record({
        actor: 'system',
        action: 'maintenance.standalone.deploy',
        target: p.name,
        params: { run: runId, from: p.fromImageId.slice(0, 19), to: staged.slice(0, 19), notes: spec.notes },
        outcome: 'success',
      });
      if (c.raw.State.Running) {
        const hc = (
          c.raw.Config as {
            Healthcheck?: { Test?: string[]; Interval?: number; Retries?: number; StartPeriod?: number };
          }
        ).Healthcheck;
        const hasHc = !!hc?.Test && hc.Test[0] !== 'NONE';
        const pol = d.resolver.resolve({ project: null, service: null, container: p.name });
        const hcSeconds = hasHc
          ? ((hc?.StartPeriod ?? 0) + (hc?.Interval ?? 30e9) * (hc?.Retries ?? 3)) / 1e9 + 30
          : 0;
        await step('health', async () => {
          const r = await waitForHealth(
            { inspect: (id) => this.inspectLite(id), pollMs: d.health?.pollMs },
            [nid],
            {
              kind: hasHc ? 'healthcheck' : 'stability',
              timeoutMs: Math.max(pol.health.timeoutSeconds, hcSeconds) * 1000,
              stabilizationMs: pol.health.stabilizationSeconds * 1000,
              probe: pol.health.probe,
              expectedImageId: staged,
            },
          );
          if (!r.ok) throw new HealthFailure(r.reason);
          return r;
        });
      }
      d.staged.delete(stagedTag(ref, p.toDigest));
      await d.images.remove(stagedTag(ref, p.toDigest)).catch(() => undefined);
      reason = `${p.name} now runs ${p.toDigest.slice(0, 19)}; the previous container is kept stopped as ${oldName} for ${Math.round(d.config.rollbackRetentionMs / 3_600_000)} h${policyChanged ? ` (its restart policy "${origPolicy.Name}" was set to "no" so it cannot start next to the new container after a reboot; to go back: docker stop ${p.name} && docker rename ${p.name} ${p.name}-new && docker rename ${oldName} ${p.name} && docker update --restart=${origPolicy.Name}${origPolicy.Name === 'on-failure' && origPolicy.MaximumRetryCount ? `:${origPolicy.MaximumRetryCount}` : ''} ${p.name} && docker start ${p.name})` : ''}`;
    } catch (e) {
      const why = (e as Error).message;
      reason = why;
      status = 'failed';
      if (newId) {
        const id = newId;
        const undone = await step('rollback', async () => {
          await withPermit({ containerId: id, action: 'stop' }, () =>
            d.docker.getContainer(id).stop({ t: 5 }),
          ).catch(() => undefined);
          if (newRenamed)
            await withPermit({ kind: 'container_rename', containerId: id, newName: tmpName }, () =>
              d.docker.getContainer(id).rename({ name: tmpName }),
            );
          await withPermit({ containerId: id, action: 'remove' }, () =>
            d.docker.getContainer(id).remove({ force: false, v: false }),
          );
          if (oldRenamed)
            await withPermit({ kind: 'container_rename', containerId: p.containerId, newName: p.name }, () =>
              d.docker.getContainer(p.containerId).rename({ name: p.name }),
            );
          if (oldStopped) {
            if (policyChanged)
              await withPermit({ kind: 'container_restart_policy', containerId: p.containerId }, () =>
                d.docker.getContainer(p.containerId).update({ RestartPolicy: origPolicy } as never),
              );
            await withPermit({ containerId: p.containerId, action: 'start' }, () =>
              d.docker.getContainer(p.containerId).start(),
            );
          }
          if (tagMoved) await d.images.tag(p.fromImageId, repoTag);
          return true;
        }).catch((er: Error) => {
          guidance.push(
            `Automatic undo failed (${er.message}). Restore by hand:`,
            `docker rm -f ${tmpName}   # the clone, if it exists`,
            `docker rename ${oldName} ${p.name}`,
            `docker start ${p.name}`,
          );
          return false;
        });
        if (undone) {
          status = e instanceof HealthFailure ? 'rolled_back' : 'failed';
          reason = `${why}. The previous container was restored and is running again.`;
        }
      } else if (tagMoved) {
        await d.images.tag(p.fromImageId, repoTag).catch(() => undefined);
      }
    }

    if (intent !== null) d.runs.completeIntent(intent); // outcome is final (success, undone, or undo failed + guidance)
    const outcome = status === 'completed' ? 'updated' : status === 'rolled_back' ? 'rolled_back' : 'failed';
    d.runs.finish(
      runId,
      status,
      { services: [{ service: p.name, outcome, detail: reason ?? '' }], summary: reason ?? status },
      guidance.length ? guidance : null,
      reason,
    );
    d.containers.invalidate();
    d.updates.statuses({ fresh: false }).catch(() => undefined);
    d.audit.record({
      actor: run.requestedBy,
      action: 'maintenance.run.finish',
      target: p.name,
      params: { run: runId, status, standalone: true },
      outcome: status === 'completed' ? 'success' : 'failure',
    });
    d.notify({
      type:
        status === 'completed'
          ? 'run.succeeded'
          : status === 'rolled_back'
            ? 'run.rolled_back'
            : 'run.failed',
      severity: status === 'completed' ? 'info' : status === 'rolled_back' ? 'warning' : 'critical',
      title: `Container update ${status}: ${p.name}`,
      message: reason ?? status,
      dedupeKey: `run:${runId}`,
    });
    ctx.log(`run ${runId} finished: ${status}\n`);
    return status;
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
}
