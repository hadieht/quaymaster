import type {
  EffectivePolicy,
  HealthPolicy,
  PolicyInput,
  PolicyScopeKind,
  UpdateMode,
} from '@quaymaster/shared';
import type { PoliciesRepo } from '../db/maintenance.js';
import { AppError } from '../util/errors.js';

export const DEFAULT_HEALTH: HealthPolicy = { timeoutSeconds: 60, stabilizationSeconds: 15, probe: null };

export const DEFAULT_POLICY: Required<
  Pick<PolicyInput, 'updateMode' | 'critical' | 'requireApproval' | 'maxParallel'>
> = { updateMode: 'notify', critical: false, requireApproval: true, maxParallel: 1 };

/** What a policy lookup is for. */
export interface PolicyTarget {
  project: string | null;
  service: string | null;
  /** Standalone container name (no project). */
  container: string | null;
}

export const serviceKey = (project: string, service: string): string => `${project}/${service}`;

const UPDATE_MODES: UpdateMode[] = ['ignore', 'notify', 'pull_only', 'auto'];

/**
 * Resolves the effective policy (RT-23). `levels` is ordered least to most specific.
 *
 *  - safety flags combine as the MOST RESTRICTIVE across all levels: `critical` = OR,
 *    `require_approval` = OR, `auto_rollback` = AND (an explicit `false` anywhere wins)
 *  - every other field: the most specific level that sets it wins
 *  - global default: notify + approval required (automation is opt-in)
 */
export function resolvePolicy(levels: { level: string; policy: PolicyInput }[]): EffectivePolicy {
  const sources: Record<string, string> = {
    updateMode: 'default',
    critical: 'default',
    requireApproval: 'default',
    autoRollback: 'default',
  };
  let updateMode: UpdateMode = DEFAULT_POLICY.updateMode;
  let critical = false;
  let requireApproval = DEFAULT_POLICY.requireApproval;
  let approvalDemanded = false;
  let autoRollback: boolean | null = null;
  let updateOrder: number | null = null;
  const health: HealthPolicy = { ...DEFAULT_HEALTH };

  for (const { level, policy } of levels) {
    if (policy.updateMode !== undefined) {
      updateMode = policy.updateMode;
      sources['updateMode'] = level;
    }
    if (policy.critical === true) {
      critical = true;
      sources['critical'] = level;
    }
    if (policy.requireApproval === true) {
      requireApproval = true;
      approvalDemanded = true;
      sources['requireApproval'] = level;
    } else if (policy.requireApproval === false && !approvalDemanded) {
      requireApproval = false;
      sources['requireApproval'] = level;
    }
    if (policy.autoRollback === false) {
      autoRollback = false;
      sources['autoRollback'] = level;
    } else if (policy.autoRollback === true && autoRollback === null) {
      autoRollback = true;
      sources['autoRollback'] = level;
    }
    if (policy.updateOrder !== undefined) {
      updateOrder = policy.updateOrder;
      sources['updateOrder'] = level;
    }
    if (policy.health) {
      if (policy.health.timeoutSeconds !== undefined) health.timeoutSeconds = policy.health.timeoutSeconds;
      if (policy.health.stabilizationSeconds !== undefined)
        health.stabilizationSeconds = policy.health.stabilizationSeconds;
      if (policy.health.probe !== undefined) health.probe = policy.health.probe;
      sources['health'] = level;
    }
  }
  return {
    updateMode,
    critical,
    requireApproval,
    autoRollbackExplicit: autoRollback,
    health,
    maxParallel: 1, // v1 updates one service at a time (spec 7.5)
    updateOrder,
    sources,
  };
}

/**
 * The unattended-deploy truth table (RT-23): a deploy without a human happens only if
 * update_mode = auto ∧ schedule.mode = auto ∧ ¬require_approval ∧ ¬critical.
 * Standalone containers are never unattended (RT-12); the planner enforces that separately.
 * Returns the reasons it is NOT allowed (empty = allowed).
 */
export function unattendedBlockers(
  p: Pick<EffectivePolicy, 'updateMode' | 'critical' | 'requireApproval'>,
  scheduleMode: 'manual' | 'auto' | null,
): string[] {
  const out: string[] = [];
  if (p.updateMode !== 'auto') out.push(`update_mode is "${p.updateMode}", not "auto"`);
  if (scheduleMode !== 'auto') out.push('the schedule is not in auto mode');
  if (p.requireApproval) out.push('approval is required');
  if (p.critical) out.push('the target is critical (always needs explicit per-run approval)');
  return out;
}

/** Rollback default for a service (RT-10): off when it has writable persistent mounts. */
export function resolveAutoRollback(
  explicit: boolean | null,
  hasPersistentMounts: boolean,
): { value: boolean; reason: string } {
  if (explicit === false) return { value: false, reason: 'disabled by policy' };
  if (explicit === true) return { value: true, reason: 'enabled by policy' };
  return hasPersistentMounts
    ? {
        value: false,
        reason:
          'default is OFF: the service has writable persistent mounts, and a rollback could start old code on migrated data (the rollout stops, the service is left as is, and you are alerted)',
      }
    : { value: true, reason: 'default is ON for a stateless service' };
}

const bad = (m: string): AppError => new AppError(400, 'validation', m);

export function validatePolicy(p: unknown): PolicyInput {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) throw bad('policy must be an object');
  const o = p as Record<string, unknown>;
  const allowed = new Set([
    'updateMode',
    'critical',
    'requireApproval',
    'autoRollback',
    'health',
    'maxParallel',
    'updateOrder',
  ]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw bad(`unknown policy field "${k}"`);
  const out: PolicyInput = {};
  if (o['updateMode'] !== undefined) {
    if (!UPDATE_MODES.includes(o['updateMode'] as UpdateMode))
      throw bad('updateMode must be ignore|notify|pull_only|auto');
    out.updateMode = o['updateMode'] as UpdateMode;
  }
  for (const k of ['critical', 'requireApproval', 'autoRollback'] as const) {
    if (o[k] !== undefined) {
      if (typeof o[k] !== 'boolean') throw bad(`${k} must be a boolean`);
      out[k] = o[k] as boolean;
    }
  }
  if (o['maxParallel'] !== undefined) {
    if (o['maxParallel'] !== 1) throw bad('maxParallel is fixed to 1 in this version');
    out.maxParallel = 1;
  }
  if (o['updateOrder'] !== undefined) {
    if (!Number.isInteger(o['updateOrder'])) throw bad('updateOrder must be an integer');
    out.updateOrder = o['updateOrder'] as number;
  }
  if (o['health'] !== undefined) {
    const h = o['health'] as Record<string, unknown>;
    if (typeof h !== 'object' || h === null) throw bad('health must be an object');
    const hh: Partial<HealthPolicy> = {};
    if (h['timeoutSeconds'] !== undefined) {
      const v = h['timeoutSeconds'];
      if (typeof v !== 'number' || v < 5 || v > 3600) throw bad('health.timeoutSeconds must be 5..3600');
      hh.timeoutSeconds = v;
    }
    if (h['stabilizationSeconds'] !== undefined) {
      const v = h['stabilizationSeconds'];
      if (typeof v !== 'number' || v < 0 || v > 600) throw bad('health.stabilizationSeconds must be 0..600');
      hh.stabilizationSeconds = v;
    }
    if (h['probe'] !== undefined) {
      if (h['probe'] === null) hh.probe = null;
      else {
        const pr = h['probe'] as Record<string, unknown>;
        if (typeof pr['url'] !== 'string' || !/^https?:\/\//.test(pr['url']))
          throw bad('health.probe.url must be http(s)');
        const st = pr['expectStatus'] ?? 200;
        if (!Number.isInteger(st) || (st as number) < 100 || (st as number) > 599)
          throw bad('health.probe.expectStatus invalid');
        hh.probe = { url: pr['url'], expectStatus: st as number };
      }
    }
    out.health = hh;
  }
  return out;
}

/** Loads the levels that apply to a target, least to most specific. */
export class PolicyResolver {
  constructor(private readonly repo: PoliciesRepo) {}

  levelsFor(t: PolicyTarget): { level: string; policy: PolicyInput }[] {
    const keys: [PolicyScopeKind, string][] = [['global', '*']];
    if (t.project) keys.push(['project', t.project]);
    if (t.project && t.service) keys.push(['service', serviceKey(t.project, t.service)]);
    if (!t.project && t.container) keys.push(['container', t.container]);
    const out: { level: string; policy: PolicyInput }[] = [];
    for (const [kind, key] of keys) {
      const hit = this.repo.get(kind, key);
      if (hit) out.push({ level: `${kind}:${key}`, policy: hit.policy });
    }
    return out;
  }

  resolve(t: PolicyTarget): EffectivePolicy {
    return resolvePolicy(this.levelsFor(t));
  }
}
