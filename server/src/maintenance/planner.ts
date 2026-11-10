import { createHash } from 'node:crypto';
import type Dockerode from 'dockerode';
import type {
  DependencyGraph,
  EffectivePolicy,
  ImageUpdateStatus,
  Plan,
  PlanImpact,
  PlanMount,
  PlanService,
  PreflightCheck,
  UpdateMode,
} from '@quaymaster/shared';
import type { ComposeService } from '../compose/service.js';
import {
  buildGraph,
  projectReferences,
  type ResolvedConfig,
  type ResolvedService,
} from '../compose/graph.js';
import type { Config } from '../config/env.js';
import type { QuarantineRepo } from '../db/updates.js';
import type { ContainerService, ResolvedContainer } from '../docker/containers.js';
import { LABEL } from '../docker/model.js';
import type { SystemService } from '../docker/system.js';
import type { RegistryClient } from '../registry/client.js';
import { cacheKey, parseImageRef } from '../registry/reference.js';
import type { Guard } from '../security/guard.js';
import { AppError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { PolicyResolver, resolveAutoRollback, unattendedBlockers } from './policy.js';
import type { UpdateService } from '../updates/detector.js';

// ---- pure helpers (unit-tested) -----------------------------------------------------------

/** Parses a Compose duration ("1m30s", "500ms", "2s") or a number of nanoseconds into milliseconds. */
export function parseDurationMs(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return v / 1e6; // Engine API: nanoseconds
  if (typeof v !== 'string') return null;
  let total = 0;
  let matched = false;
  for (const m of v.matchAll(/(\d+(?:\.\d+)?)(ms|us|µs|ns|s|m|h)/g)) {
    matched = true;
    const n = Number(m[1]);
    total +=
      n * ({ h: 3_600_000, m: 60_000, s: 1000, ms: 1, us: 0.001, µs: 0.001, ns: 1e-6 }[m[2] as 'h'] ?? 0);
  }
  return matched ? total : null;
}

export interface HealthcheckTimings {
  intervalMs: number;
  retries: number;
  startPeriodMs: number;
}

/** RT-10: effective timeout = max(policy, start_period + interval × retries + 30 s). */
export function effectiveHealthTimeoutSeconds(policySeconds: number, hc: HealthcheckTimings | null): number {
  if (!hc) return policySeconds;
  const own = Math.ceil((hc.startPeriodMs + hc.intervalMs * hc.retries) / 1000) + 30;
  return Math.max(policySeconds, own);
}

export interface OrderNode {
  name: string;
  order: number | null;
}

/**
 * Dependency-aware order (Kahn's algorithm): a service always comes after everything in `selected` it
 * depends on (any edge kind). Ties are broken by the policy `update_order` hint, then by name, so the
 * result is deterministic. Returns the cycle members when the selection cannot be ordered.
 */
export function orderServices(
  selected: OrderNode[],
  edges: DependencyGraph['edges'],
): { order: string[]; cycle: string[] | null } {
  const names = new Set(selected.map((n) => n.name));
  const hint = new Map(selected.map((n) => [n.name, n.order]));
  const deps = new Map<string, Set<string>>([...names].map((n) => [n, new Set<string>()]));
  // transitive closure through services outside the selection keeps indirect constraints intact
  const direct = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!direct.has(e.from)) direct.set(e.from, new Set());
    direct.get(e.from)?.add(e.to);
  }
  for (const n of names) {
    const seen = new Set<string>();
    const stack = [...(direct.get(n) ?? [])];
    while (stack.length) {
      const x = stack.pop() as string;
      if (seen.has(x)) continue;
      seen.add(x);
      if (names.has(x) && x !== n) deps.get(n)?.add(x);
      else for (const y of direct.get(x) ?? []) stack.push(y);
    }
  }
  const order: string[] = [];
  const done = new Set<string>();
  const cmp = (a: string, b: string): number => {
    const ha = hint.get(a) ?? Number.MAX_SAFE_INTEGER;
    const hb = hint.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ha !== hb ? ha - hb : a.localeCompare(b);
  };
  while (done.size < names.size) {
    const ready = [...names].filter(
      (n) => !done.has(n) && [...(deps.get(n) ?? [])].every((d) => done.has(d)),
    );
    if (ready.length === 0) return { order: [], cycle: [...names].filter((n) => !done.has(n)).sort() };
    ready.sort(cmp);
    const next = ready[0] as string;
    order.push(next);
    done.add(next);
  }
  return { order, cycle: null };
}

/** Stable JSON (sorted keys) so equal plans hash equally. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * RT-08: the approval is bound to this hash — service list and order, per-service from-image ID,
 * to-digest and config hash, and the policy snapshot. Volatile data (timestamps, disk numbers) is excluded.
 */
export function computePlanHash(p: Pick<Plan, 'kind' | 'target' | 'order' | 'services'>): string {
  const material = {
    kind: p.kind,
    target: p.target,
    order: p.order,
    services: p.services.map((s) => ({
      service: s.service,
      role: s.role,
      ref: s.ref,
      fromImageId: s.fromImageId,
      toDigest: s.toDigest,
      configHash: s.configHash,
      wasRunning: s.wasRunning,
      policy: {
        updateMode: s.updateMode,
        critical: s.critical,
        requireApproval: s.requireApproval,
        autoRollback: s.autoRollback,
        health: s.health,
      },
    })),
  };
  return createHash('sha256').update(canonicalJson(material)).digest('hex');
}

export interface PlanRequest {
  project: string;
  /** Restrict to these services (default: every service with an update). */
  services?: string[];
  /** Mode of the schedule that triggers the plan (null = manual). */
  scheduleMode?: 'manual' | 'auto' | null;
  /** Only services whose update_mode is in this list are candidates (scheduled runs: ['auto']). */
  onlyModes?: UpdateMode[];
  applyDrift?: boolean;
  allowUnhealthy?: boolean;
  /** Bypass the registry cache. */
  fresh?: boolean;
}

const MB = 1024 * 1024;

interface ServiceFacts {
  name: string;
  cfg: ResolvedService;
  containers: Dockerode.ContainerInfo[];
  inspect: ResolvedContainer | null;
}

/**
 * Builds the dry-run plan (spec 7.5 steps 1, 2, 4, 5 + RT-06…RT-29). Reads only: nothing is pulled,
 * tagged, created or restarted here. The plan stored with a run is exactly what the executor runs; the
 * executor re-plans at preflight and refuses to run (approval_stale) if the hash differs.
 */
export class Planner {
  constructor(
    private readonly d: {
      compose: ComposeService;
      containers: ContainerService;
      updates: UpdateService;
      registry: RegistryClient;
      policies: PolicyResolver;
      quarantine: QuarantineRepo;
      system: SystemService;
      guard: Guard;
      config: Pick<Config, 'diskFloorBytes'>;
      log: Logger;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  async planProject(req: PlanRequest): Promise<Plan> {
    const base = {
      version: 1 as const,
      kind: 'compose' as const,
      target: req.project,
      createdAt: new Date(this.now()).toISOString(),
    };
    const empty = (code: string, message: string, extra: Partial<Plan> = {}): Plan =>
      this.finish({
        ...base,
        order: [],
        services: [],
        excluded: [],
        preflight: { ok: false, checks: [{ name: code, ok: false, detail: message }] },
        validation: { valid: true, errors: [], warnings: [] },
        drift: [],
        impact: { dependents: [], sharedTag: [] },
        disk: { requiredBytes: null, freeBytes: null, floorBytes: this.d.config.diskFloorBytes, ok: true },
        blocked: { code, message },
        warnings: [],
        planHash: '',
        ...extra,
      });

    // ---- 1. preflight: capability, scope, self-protection
    let target;
    let summary;
    try {
      ({ summary, target } = await this.d.compose.targetOf(req.project, true));
    } catch (e) {
      if (e instanceof AppError && e.code === 'limited_capability')
        return empty('limited_capability', e.message);
      throw e;
    }
    const checks: PreflightCheck[] = [];
    const refusal = this.d.guard.projectRefusal(req.project, undefined, { perService: true });
    if (refusal) return empty('refused', refusal.message);

    // ---- 2. validate (+ unset variables are errors)
    const validation = await this.d.compose.validate(req.project).catch((e: unknown) => ({
      valid: false,
      errors: [(e as Error).message],
      warnings: [] as string[],
    }));
    if (!validation.valid) {
      return empty(
        'validation',
        `The Compose configuration is not valid: ${validation.errors[0] ?? 'unknown error'}`,
        {
          validation,
        },
      );
    }
    let cfg: ResolvedConfig;
    try {
      cfg = (await this.d.compose.resolvedConfig(req.project, true)).config;
    } catch (e) {
      return empty('validation', (e as Error).message, {
        validation: { valid: false, errors: [(e as Error).message], warnings: [] },
      });
    }
    const refs = projectReferences(cfg);
    const scopeRefusal = this.d.guard.projectRefusal(req.project, refs, { perService: true });
    if (scopeRefusal) return empty(scopeRefusal.code, scopeRefusal.message);
    const graph = buildGraph(cfg);
    if (graph.cycle) return empty('cycle', `Dependency cycle: ${graph.cycle.join(' → ')}`);

    // ---- 3. check: facts per service + registry digests
    const rawContainers = await this.d.compose.projectContainers(req.project);
    const facts = new Map<string, ServiceFacts>();
    for (const [name, svc] of Object.entries(cfg.services ?? {})) {
      const cs = rawContainers
        .filter((c) => c.Labels?.[LABEL.service] === name && c.Labels?.[LABEL.oneoff] !== 'True')
        .sort((a, b) => a.Id.localeCompare(b.Id));
      facts.set(name, {
        name,
        cfg: svc,
        containers: cs,
        inspect: cs[0] ? await this.d.containers.resolve(cs[0].Id) : null,
      });
    }
    const requested = req.services?.length ? new Set(req.services) : null;
    if (requested) {
      for (const r of requested)
        if (!facts.has(r))
          return empty('validation', `Service "${r}" does not exist in project ${req.project}`);
    }

    const excluded: Plan['excluded'] = [];
    const warnings: string[] = [];
    const candidates = new Map<string, { status: ImageUpdateStatus; policy: EffectivePolicy }>();
    const self = this.d.guard.getSelf();
    for (const [name, f] of facts) {
      if (requested && !requested.has(name)) continue;
      const skip = (reason: string): void => {
        excluded.push({ service: name, reason });
      };
      if (f.containers.length === 0) {
        skip('no container exists yet (not created)');
        continue;
      }
      if (f.cfg.build !== undefined) {
        skip('built from source (`build:`); only registry images are updatable (RT-06)');
        continue;
      }
      const image = f.cfg.image;
      if (!image) {
        skip('no image reference');
        continue;
      }
      if (f.containers.some((c) => self.containerId && c.Id === self.containerId)) {
        skip('this is the Quaymaster container itself; it never updates itself');
        continue;
      }
      const denied = f.containers
        .map((c) =>
          this.d.guard.containerRefusal({
            id: c.Id,
            name: (c.Names?.[0] ?? '').replace(/^\//, ''),
            project: req.project,
          }),
        )
        .find((r) => r !== null);
      if (denied) {
        skip(denied.message);
        continue;
      }
      const policy = this.d.policies.resolve({ project: req.project, service: name, container: null });
      if (policy.updateMode === 'ignore') {
        skip('policy: ignore');
        continue;
      }
      if (req.onlyModes && !req.onlyModes.includes(policy.updateMode)) {
        skip(`policy update_mode "${policy.updateMode}" is not part of this run`);
        continue;
      }
      const first = f.containers[0] as Dockerode.ContainerInfo;
      if (new Set(f.containers.map((c) => c.ImageID)).size > 1)
        warnings.push(`${name}: replicas run different images; they are updated as one unit`);
      const status = await this.d.updates.statusFor(
        { ref: image, imageId: first.ImageID, users: [] },
        req.fresh === true,
      );
      if (status.state !== 'update_available' && status.state !== 'update_staged') {
        skip(
          status.state === 'up_to_date'
            ? 'already up to date'
            : `${status.state}${status.reason ? `: ${status.reason}` : ''}`,
        );
        continue;
      }
      if (!status.remoteDigest) {
        skip('no remote digest known');
        continue;
      }
      candidates.set(name, { status, policy });
    }

    // ---- 4. impact: namespace/volume dependents are recreated in the same step (RT-11)
    const selected = new Set(candidates.keys());
    const dependentOf = new Map<string, string>();
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of graph.edges) {
        if (e.kind === 'depends_on') continue;
        if (
          (selected.has(e.to) || dependentOf.has(e.to)) &&
          !selected.has(e.from) &&
          !dependentOf.has(e.from)
        ) {
          const f = facts.get(e.from);
          if (f && f.containers.length > 0) {
            dependentOf.set(e.from, dependentOf.get(e.to) ?? e.to);
            grew = true;
          }
        }
      }
    }
    const nodes = [
      ...[...selected].map((n) => ({
        name: n,
        order: candidates.get(n)?.policy.updateOrder ?? null,
      })),
      ...[...dependentOf.keys()].map((n) => ({ name: n, order: null })),
    ];
    const ordered = orderServices(nodes, graph.edges);
    if (ordered.cycle) return empty('cycle', `Cannot order services: ${ordered.cycle.join(', ')}`);

    const services: PlanService[] = [];
    for (const name of ordered.order) {
      const f = facts.get(name) as ServiceFacts;
      const cand = candidates.get(name);
      const policy =
        cand?.policy ?? this.d.policies.resolve({ project: req.project, service: name, container: null });
      const insp = f.inspect?.raw;
      const first = f.containers[0] as Dockerode.ContainerInfo;
      const mounts: PlanMount[] = (insp?.Mounts ?? []).map((m) => ({
        type: m.Type,
        source: m.Name ?? m.Source,
        target: m.Destination,
        readOnly: m.RW === false,
      }));
      const persistent = mounts.filter((m) => !m.readOnly && (m.type === 'volume' || m.type === 'bind'));
      const rb = resolveAutoRollback(policy.autoRollbackExplicit, persistent.length > 0);
      const hc = insp?.Config?.Healthcheck as
        { Test?: string[]; Interval?: number; Retries?: number; StartPeriod?: number } | undefined;
      const hasHealthcheck = !!hc?.Test && hc.Test[0] !== 'NONE';
      const timings: HealthcheckTimings | null = hasHealthcheck
        ? {
            intervalMs: (hc?.Interval ?? 30e9) / 1e6,
            retries: hc?.Retries ?? 3,
            startPeriodMs: (hc?.StartPeriod ?? 0) / 1e6,
          }
        : null;
      const oneShot = graph.edges.some(
        (e) => e.to === name && e.condition === 'service_completed_successfully',
      );
      const wasRunning = f.containers.every((c) => c.State === 'running');
      const timeoutSeconds = effectiveHealthTimeoutSeconds(policy.health.timeoutSeconds, timings);
      const quarantined =
        !!cand?.status.remoteDigest &&
        this.d.quarantine.isQuarantined(cacheKeyOf(f.cfg.image ?? ''), cand.status.remoteDigest);
      const blockers = unattendedBlockers(policy, req.scheduleMode ?? null);
      if (quarantined) blockers.push('this digest failed before and is quarantined (RT-22)');
      if (!wasRunning) blockers.push('the service is currently stopped');
      services.push({
        service: name,
        role: cand ? 'update' : 'dependent',
        ...(cand ? {} : { dependentOf: dependentOf.get(name) }),
        containers: f.containers.map((c) => ({
          id: c.Id,
          name: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''),
        })),
        ref: f.cfg.image ?? first.Image,
        fromImageId: first.ImageID,
        fromDigest: cand?.status.localDigest ?? null,
        toDigest: cand?.status.remoteDigest ?? null,
        configHash: null, // filled below
        wasRunning,
        oneShot,
        autoRollback: rb.value,
        autoRollbackReason: rb.reason,
        health: {
          kind: oneShot ? 'oneshot' : hasHealthcheck ? 'healthcheck' : 'stability',
          timeoutSeconds,
          stabilizationSeconds: policy.health.stabilizationSeconds,
          probe: policy.health.probe,
        },
        downtime: wasRunning
          ? `brief downtime expected: the container is recreated (stop, create, start, then up to ${timeoutSeconds}s health gate)`
          : 'none: the service is stopped and stays stopped (updated with --no-start, RT-28)',
        dataRisk: {
          flagged: persistent.length > 0,
          mounts,
          note:
            persistent.length > 0
              ? 'Persistent writable mounts: a rollback restores the image, not the data. A new version may have migrated it; take a backup first.'
              : 'No persistent writable mounts.',
        },
        critical: policy.critical,
        requireApproval: policy.requireApproval,
        updateMode: policy.updateMode,
        unattended: { eligible: blockers.length === 0, blockers },
        quarantined,
      });
    }

    // config hashes (RT-01) for every service in the plan, then the drift gate
    let drift: Plan['drift'] = [];
    if (services.length > 0) {
      try {
        const names = services.map((s) => s.service);
        const hashes = await this.d.compose.configHashes(target, names);
        for (const s of services) s.configHash = hashes.get(s.service) ?? null;
        drift = await this.d.compose.checkDrift(target, names);
      } catch (e) {
        return empty('validation', (e as Error).message);
      }
    }

    // impact: every container on the host that references the same tag (RT-07), and depends_on dependents (RT-29)
    const impact: PlanImpact = { dependents: [], sharedTag: [] };
    const inRun = new Set(services.map((s) => s.service));
    for (const s of services.filter((x) => x.role === 'update')) {
      for (const e of graph.edges) {
        if (e.to === s.service && !inRun.has(e.from) && e.kind === 'depends_on')
          impact.dependents.push({ service: e.from, via: s.service, kind: e.kind });
        else if (e.to === s.service && e.kind !== 'depends_on')
          impact.dependents.push({ service: e.from, via: s.service, kind: e.kind });
      }
    }
    const allContainers = await this.d.containers.listRaw(true);
    const myRefs = new Map(services.filter((s) => s.role === 'update').map((s) => [cacheKeyOf(s.ref), s]));
    for (const c of allContainers) {
      const key = cacheKeyOf(c.Image);
      const hit = myRefs.get(key);
      if (!hit) continue;
      const project = c.Labels?.[LABEL.project] ?? null;
      const service = c.Labels?.[LABEL.service] ?? null;
      const mine = project === req.project && service !== null && inRun.has(service);
      if (mine) continue;
      impact.sharedTag.push({
        ref: c.Image,
        containerName: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''),
        project,
        service,
        inRun: false,
        note: 'references the same tag: it will deploy the new image the next time anything recreates it (the tag moves during this run)',
      });
    }

    // ---- preflight checks
    if (!req.allowUnhealthy) {
      for (const [name, f] of facts) {
        if (requested && !requested.has(name)) continue;
        if (!services.some((s) => s.service === name)) continue;
        const bad = f.containers.find(
          (c) => c.State === 'restarting' || c.State === 'dead' || /unhealthy/.test(c.Status),
        );
        checks.push({
          name: `service ${name} is stable`,
          ok: !bad,
          detail: bad
            ? `container ${(bad.Names?.[0] ?? '').replace(/^\//, '')} is ${bad.State} (${bad.Status})`
            : 'ok',
        });
      }
    }
    const disk = await this.diskCheck(services);
    checks.push({
      name: 'free disk space on the Docker root',
      ok: disk.ok,
      detail:
        disk.freeBytes === null
          ? 'free space cannot be determined (container mode needs QM_DOCKER_ROOT_MOUNT); failing closed'
          : `${Math.round(disk.freeBytes / MB)} MiB free, need ≥ ${Math.round(((disk.requiredBytes ?? 0) + disk.floorBytes) / MB)} MiB (2.5 × download + floor)`,
    });
    const preflightOk = checks.every((c) => c.ok);

    let blocked: Plan['blocked'] = null;
    if (!preflightOk) {
      const failed = checks.find((c) => !c.ok);
      blocked = { code: 'preflight', message: `Preflight failed: ${failed?.name} — ${failed?.detail}` };
    } else if (drift.length > 0 && req.applyDrift !== true) {
      blocked = {
        code: 'blocked_drift',
        message: `The Compose configuration differs from what runs for: ${drift.map((x) => x.service).join(', ')}. An update would also apply those changes. Review the redacted configuration and re-plan with applyDrift to proceed manually.`,
      };
    } else if (services.length === 0) {
      blocked = { code: 'nothing_to_do', message: 'No service has an available update' };
    }
    if (drift.length > 0 && req.applyDrift === true)
      warnings.push(`Configuration drift will be applied for: ${drift.map((x) => x.service).join(', ')}`);
    void summary;

    return this.finish({
      ...base,
      order: ordered.order,
      services,
      excluded,
      preflight: { ok: preflightOk, checks },
      validation,
      drift,
      impact,
      disk,
      blocked,
      warnings,
      planHash: '',
    });
  }

  private finish(p: Plan): Plan {
    return { ...p, planHash: computePlanHash(p) };
  }

  /** RT-13: free ≥ 2.5 × Σ compressed sizes + max(floor, 10 % of the filesystem); fails closed if unknown. */
  private async diskCheck(services: PlanService[]): Promise<Plan['disk']> {
    const host = await this.d.system.host().catch(() => null);
    const root = host?.dockerRoot ?? null;
    const floor = Math.max(this.d.config.diskFloorBytes, root ? Math.floor(root.total * 0.1) : 0);
    let required: number | null = 0;
    const seen = new Set<string>();
    for (const s of services.filter((x) => x.role === 'update' && x.toDigest)) {
      const ref = parseImageRef(s.ref);
      if (!ref || seen.has(`${cacheKey(ref)}@${s.toDigest}`)) continue;
      seen.add(`${cacheKey(ref)}@${s.toDigest}`);
      try {
        required += Math.ceil(2.5 * (await this.d.registry.compressedSize(ref, s.toDigest as string)));
      } catch {
        required = null; // unknown: reported, the floor still applies
        break;
      }
    }
    const need = (required ?? 0) + floor;
    return {
      requiredBytes: required,
      freeBytes: root?.free ?? null,
      floorBytes: floor,
      ok: root !== null && root.free >= need,
    };
  }
}

function cacheKeyOf(ref: string): string {
  const p = parseImageRef(ref);
  return p ? cacheKey(p) : ref;
}
