import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EffectivePolicy, MonitorSettings, PolicyScopeKind, RunStatus } from '@quaymaster/shared';
import { actorOf, parseBody, requirePerm } from '../app.js';
import type { AppContext } from '../context.js';
import { validatePolicy } from '../maintenance/policy.js';
import { AppError, badRequest, notFound } from '../util/errors.js';

const windowBody = z
  .object({
    name: z.string().min(1).max(100),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
    timezone: z.string().min(1).max(100),
    enabled: z.boolean().optional(),
  })
  .strict();
const scheduleBody = z
  .object({
    name: z.string().min(1).max(100),
    cron: z.string().min(1).max(100),
    timezone: z.string().min(1).max(100),
    jobType: z.enum(['image_check', 'image_pull', 'update', 'cleanup_report']),
    selector: z
      .object({
        project: z.string().max(100).optional(),
        container: z.string().max(200).optional(),
        services: z.array(z.string().max(100)).max(100).optional(),
      })
      .strict()
      .optional(),
    mode: z.enum(['manual', 'auto']),
    windowId: z.string().uuid().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const planBody = z
  .object({
    project: z.string().min(1).max(100),
    services: z.array(z.string().max(100)).max(100).optional(),
    applyDrift: z.boolean().optional(),
    allowUnhealthy: z.boolean().optional(),
  })
  .strict();
const runBody = planBody
  .extend({
    startNow: z.boolean().optional(),
    confirm: z.string().max(200).optional(),
    windowId: z.string().uuid().nullable().optional(),
    ignoreWindow: z.boolean().optional(),
  })
  .strict();
const approveBody = z.object({ planHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.string().max(40).optional(),
  target: z.string().max(200).optional(),
});
const effectiveQuery = z.object({
  project: z.string().max(100).optional(),
  service: z.string().max(100).optional(),
  container: z.string().max(200).optional(),
});
const monitorBody = z
  .object({
    enabled: z.boolean(),
    diskFreePercentBelow: z.number().min(0).max(100),
    diskFreeBytesBelow: z.number().min(0),
    cpuPercentAbove: z.number().min(1).max(1000),
    memoryPercentAbove: z.number().min(1).max(100),
    sustainSeconds: z.number().int().min(0).max(86_400),
    restartLoopCount: z.number().int().min(2).max(1000),
    restartLoopWindowSeconds: z.number().int().min(10).max(86_400),
    upcomingMaintenanceMinutes: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60),
  })
  .strict();

/** HTTP probe verification (RT-10): a probe is only saved if it passes against the CURRENT version. */
async function verifyProbe(url: string, expectStatus: number): Promise<void> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'manual' });
    if (res.status !== expectStatus)
      throw new AppError(
        400,
        'validation',
        `The probe answered HTTP ${res.status}, expected ${expectStatus}. Probes are only enabled once they pass against the running version.`,
      );
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(
      400,
      'validation',
      `The probe could not be reached from Quaymaster (${(e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message}). It must be reachable from Quaymaster's network (publish a port or attach Quaymaster to the network).`,
    );
  } finally {
    clearTimeout(t);
  }
}

function policyKey(kind: PolicyScopeKind, key: string): string {
  if (kind === 'global') return '*';
  if (kind === 'service' && !/^[a-z0-9][a-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(key))
    throw badRequest('service policies are keyed "project/service"');
  if (kind === 'project' && !/^[a-z0-9][a-z0-9_-]*$/.test(key)) throw badRequest('invalid project name');
  if (!key || key.length > 200) throw badRequest('invalid key');
  return key;
}

export function registerMaintenanceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const admin = { preHandler: requirePerm(ctx, 'write') };

  // ---- policies
  app.get('/maintenance/policies', async () => ({
    policies: ctx.policiesRepo.list().map((p) => ({
      scopeKind: p.kind,
      scopeKey: p.key,
      policy: p.policy,
      updatedAt: new Date(p.updatedAt).toISOString(),
    })),
  }));
  app.get('/maintenance/policies/effective', async (req): Promise<EffectivePolicy> => {
    const q = parseBody(effectiveQuery, req.query);
    return ctx.maintenance.resolver.resolve({
      project: q.project ?? null,
      service: q.service ?? null,
      container: q.container ?? null,
    });
  });
  app.put<{ Params: { kind: string; key: string } }>(
    '/maintenance/policies/:kind/:key',
    admin,
    async (req) => {
      const kind = req.params.kind as PolicyScopeKind;
      if (!['global', 'project', 'service', 'container'].includes(kind))
        throw badRequest('Unknown policy scope');
      const key = policyKey(kind, decodeURIComponent(req.params.key));
      // F-06 (RT-03): a policy for something outside QM_MANAGED_SCOPE could only ever be dead or misleading config
      const scopeName = kind === 'service' ? key.split('/')[0] : kind === 'global' ? null : key;
      if (scopeName && !ctx.guard.inScope(scopeName))
        throw new AppError(
          409,
          'out_of_scope',
          `Refused: "${scopeName}" is outside QM_MANAGED_SCOPE, so no policy can be set for it`,
        );
      const policy = validatePolicy(req.body);
      if (policy.health?.probe) await verifyProbe(policy.health.probe.url, policy.health.probe.expectStatus);
      ctx.policiesRepo.put(kind, key, policy);
      const actor = actorOf(req);
      ctx.audit.record({
        actor: actor.name,
        ip: actor.ip,
        action: 'maintenance.policy.put',
        target: `${kind}:${key}`,
        params: policy,
        outcome: 'success',
      });
      return { scopeKind: kind, scopeKey: key, policy };
    },
  );
  app.delete<{ Params: { kind: string; key: string } }>(
    '/maintenance/policies/:kind/:key',
    admin,
    async (req) => {
      const kind = req.params.kind as PolicyScopeKind;
      const key = policyKey(kind, decodeURIComponent(req.params.key));
      if (!ctx.policiesRepo.delete(kind, key)) throw notFound('Policy');
      const actor = actorOf(req);
      ctx.audit.record({
        actor: actor.name,
        ip: actor.ip,
        action: 'maintenance.policy.delete',
        target: `${kind}:${key}`,
        outcome: 'success',
      });
      return { ok: true };
    },
  );

  // ---- windows
  app.get('/maintenance/windows', async () => ({ windows: ctx.maintenance.listWindows() }));
  app.post('/maintenance/windows', admin, async (req, reply) => {
    void reply.status(201);
    return ctx.maintenance.createWindow(parseBody(windowBody, req.body), actorOf(req));
  });
  app.put<{ Params: { id: string } }>('/maintenance/windows/:id', admin, async (req) =>
    ctx.maintenance.updateWindow(req.params.id, parseBody(windowBody, req.body), actorOf(req)),
  );
  app.delete<{ Params: { id: string } }>('/maintenance/windows/:id', admin, async (req) => {
    ctx.maintenance.deleteWindow(req.params.id, actorOf(req));
    return { ok: true };
  });

  // ---- schedules
  app.get('/maintenance/schedules', async () => ({ schedules: ctx.maintenance.listSchedules() }));
  app.post('/maintenance/schedules', admin, async (req, reply) => {
    void reply.status(201);
    return ctx.maintenance.createSchedule(parseBody(scheduleBody, req.body), actorOf(req));
  });
  app.put<{ Params: { id: string } }>('/maintenance/schedules/:id', admin, async (req) =>
    ctx.maintenance.updateSchedule(req.params.id, parseBody(scheduleBody, req.body), actorOf(req)),
  );
  app.delete<{ Params: { id: string } }>('/maintenance/schedules/:id', admin, async (req) => {
    ctx.maintenance.deleteSchedule(req.params.id, actorOf(req));
    return { ok: true };
  });

  // ---- plans and runs
  /** Dry run: preflight, check, validate, impact. Changes nothing, pulls nothing. */
  app.post('/maintenance/plan', admin, async (req) =>
    ctx.maintenance.dryRun(parseBody(planBody, req.body), actorOf(req)),
  );
  app.get('/maintenance/runs', async (req) => {
    const q = parseBody(listQuery, req.query);
    return {
      runs: ctx.maintenance.listRuns({
        limit: q.limit,
        status: q.status as RunStatus | undefined,
        target: q.target,
      }),
    };
  });
  app.get<{ Params: { id: string } }>('/maintenance/runs/:id', async (req) =>
    ctx.maintenance.getRun(req.params.id),
  );
  app.post('/maintenance/runs', admin, async (req, reply) => {
    const run = await ctx.maintenance.createRun(parseBody(runBody, req.body), actorOf(req));
    void reply.status(run.status === 'approved' || run.status === 'running' ? 202 : 201);
    return run;
  });
  app.post<{ Params: { id: string } }>('/maintenance/runs/:id/approve', admin, async (req, reply) => {
    const b = parseBody(approveBody, req.body);
    const run = await ctx.maintenance.approve(req.params.id, b.planHash, actorOf(req));
    void reply.status(202);
    return run;
  });
  app.post('/maintenance/standalone', admin, async (req, reply) => {
    const b = parseBody(
      z.object({ container: z.string().min(1).max(200), confirm: z.string().max(200).optional() }).strict(),
      req.body,
    );
    const run = await ctx.maintenance.startStandalone(b, actorOf(req));
    void reply.status(202);
    return run;
  });
  app.post<{ Params: { id: string } }>('/maintenance/runs/:id/restore', admin, async (req, reply) => {
    const b = parseBody(
      z
        .object({
          confirm: z.string().max(200).optional(),
          services: z.array(z.string().max(100)).max(100).optional(),
        })
        .strict(),
      req.body,
    );
    const r = await ctx.maintenance.restore(req.params.id, b, actorOf(req));
    void reply.status(202);
    return r;
  });
  app.post<{ Params: { id: string } }>('/maintenance/runs/:id/reject', admin, async (req) =>
    ctx.maintenance.reject(req.params.id, actorOf(req)),
  );

  // ---- monitors
  app.get('/monitors/settings', async () => ctx.monitors.settings());
  app.put('/monitors/settings', admin, async (req) => {
    const s = ctx.monitors.saveSettings(parseBody(monitorBody, req.body) as MonitorSettings);
    const actor = actorOf(req);
    ctx.audit.record({
      actor: actor.name,
      ip: actor.ip,
      action: 'monitors.settings.put',
      target: 'monitors',
      params: s,
      outcome: 'success',
    });
    return s;
  });
}
