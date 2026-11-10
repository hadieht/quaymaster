import type { PlanService } from '@quaymaster/shared';

/** The slice of `docker inspect` the health gate reads. */
export interface InspectLite {
  Image: string;
  RestartCount: number;
  State: {
    Status: string;
    Running: boolean;
    Restarting: boolean;
    ExitCode: number;
    StartedAt: string;
    Health?: { Status: string } | null;
  };
}

export interface HealthDeps {
  inspect(id: string): Promise<InspectLite | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  /** HTTP probe: resolves to the status code (rejects on network error). */
  probe?: (url: string) => Promise<number>;
}

export interface HealthSpec {
  kind: PlanService['health']['kind'];
  timeoutMs: number;
  stabilizationMs: number;
  probe: PlanService['health']['probe'];
  /** Every container must run this image ID (RT-06: a mismatch is a health failure). */
  expectedImageId: string;
}

export interface HealthResult {
  ok: boolean;
  reason: string;
  elapsedMs: number;
}

/**
 * The health gate (spec 7.5 step 8 + RT-10):
 *  - healthcheck present: wait for `healthy`; `unhealthy`, an exit or a restart loop fail immediately
 *  - no healthcheck: running, not restarting, restart count and StartedAt stable for the stabilisation period
 *  - one-shot service: success = exited with code 0 within the timeout
 *  - optional HTTP probe afterwards
 */
export async function waitForHealth(
  deps: HealthDeps,
  containerIds: string[],
  spec: HealthSpec,
): Promise<HealthResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 1000;
  const t0 = now();
  const deadline = t0 + spec.timeoutMs;
  const fail = (reason: string): HealthResult => ({ ok: false, reason, elapsedMs: now() - t0 });
  if (containerIds.length === 0) return fail('no container to check');

  const baseline = new Map<string, { restarts: number; startedAt: string }>();
  const stableSince = new Map<string, number>();
  let last = 'no data';

  for (;;) {
    let allOk = true;
    for (const id of containerIds) {
      const c = await deps.inspect(id);
      if (!c) return fail(`container ${id.slice(0, 12)} disappeared`);
      if (c.Image !== spec.expectedImageId) {
        return fail(
          `container ${id.slice(0, 12)} runs image ${c.Image.slice(0, 19)}, expected ${spec.expectedImageId.slice(0, 19)}`,
        );
      }
      const b = baseline.get(id) ?? { restarts: c.RestartCount, startedAt: c.State.StartedAt };
      baseline.set(id, b);
      const s = c.State;
      if (spec.kind === 'oneshot') {
        if (s.Status === 'exited' || s.Status === 'dead') {
          if (s.ExitCode !== 0) return fail(`one-shot container exited with code ${s.ExitCode}`);
          continue;
        }
        allOk = false;
        last = `one-shot container is ${s.Status}`;
        continue;
      }
      if (s.Status === 'exited' || s.Status === 'dead')
        return fail(`container exited with code ${s.ExitCode}`);
      if (c.RestartCount > b.restarts)
        return fail(`restart loop: restart count went ${b.restarts} → ${c.RestartCount}`);
      if (s.Restarting) {
        allOk = false;
        last = 'container is restarting';
        stableSince.delete(id);
        continue;
      }
      if (spec.kind === 'healthcheck' && s.Health && s.Health.Status !== 'none') {
        if (s.Health.Status === 'unhealthy') return fail('the healthcheck reports unhealthy');
        if (s.Health.Status !== 'healthy') {
          allOk = false;
          last = `health is ${s.Health.Status}`;
        }
        continue;
      }
      // stability check (also the fallback when a healthcheck was expected but the image defines none)
      if (!s.Running) {
        allOk = false;
        last = `container is ${s.Status}`;
        stableSince.delete(id);
        continue;
      }
      if (s.StartedAt !== b.startedAt) return fail('container was restarted during the stabilisation period');
      const since = stableSince.get(id) ?? now();
      stableSince.set(id, since);
      if (now() - since < spec.stabilizationMs) {
        allOk = false;
        last = `stabilising (${Math.round((now() - since) / 1000)}s of ${Math.round(spec.stabilizationMs / 1000)}s)`;
      }
    }
    if (allOk) break;
    if (now() >= deadline) return fail(`timed out after ${Math.round(spec.timeoutMs / 1000)}s: ${last}`);
    await sleep(pollMs);
  }

  if (spec.probe && deps.probe) {
    let lastErr = 'no response';
    for (;;) {
      try {
        const status = await deps.probe(spec.probe.url);
        if (status === spec.probe.expectStatus) return { ok: true, reason: 'healthy', elapsedMs: now() - t0 };
        lastErr = `probe answered HTTP ${status}, expected ${spec.probe.expectStatus}`;
      } catch (e) {
        lastErr = `probe failed: ${(e as Error).message}`;
      }
      if (now() >= deadline) return fail(`HTTP probe did not pass within the timeout (${lastErr})`);
      await sleep(pollMs);
    }
  }
  return { ok: true, reason: 'healthy', elapsedMs: now() - t0 };
}
