import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ContainerAction, ContainerSummary } from '@quaymaster/shared';
import { actorOf, parseBody, requirePerm } from '../app.js';
import type { AppContext } from '../context.js';
import { CONTAINER_ACTIONS } from '../docker/containers.js';
import { badRequest, notFound } from '../util/errors.js';

const actionBody = z
  .object({
    confirm: z.string().max(300).optional(),
    applyDrift: z.boolean().optional(),
    confirmNamespaceProvider: z.boolean().optional(),
    signal: z.string().max(12).optional(),
    timeoutSeconds: z.number().int().min(0).max(600).optional(),
  })
  .strict();
const logsQuery = z.object({
  tail: z.coerce.number().int().min(1).max(5000).optional(),
  since: z.coerce.number().int().min(0).optional(),
  timestamps: z.enum(['true', 'false']).optional(),
});
const historyQuery = z.object({ minutes: z.coerce.number().int().min(1).max(7 * 24 * 60).default(60) });

export function registerContainerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/containers', async (): Promise<ContainerSummary[]> => {
    const [list, projects] = await Promise.all([ctx.containers.list(), ctx.compose.discover()]);
    const level = new Map(projects.map((p) => [p.name, p.level]));
    return list.map((c) => ({
      ...c,
      capability: c.composeProject ? (level.get(c.composeProject) ?? 'limited') : 'standalone',
    }));
  });

  app.get<{ Params: { ref: string } }>('/containers/:ref', async (req) => ctx.containers.inspect(req.params.ref));

  app.get<{ Params: { ref: string } }>('/containers/:ref/logs', { preHandler: requirePerm(ctx, 'logs') }, async (req) => {
    const q = parseBody(logsQuery, req.query);
    const lines = await ctx.containers.logsTail(req.params.ref, {
      tail: q.tail,
      since: q.since,
      timestamps: q.timestamps !== 'false',
    });
    return { lines };
  });

  app.get<{ Params: { ref: string } }>('/containers/:ref/stats', async (req) => {
    const c = await ctx.containers.resolve(req.params.ref);
    return { points: ctx.stats.history(c.id) };
  });

  app.get<{ Params: { ref: string } }>('/containers/:ref/stats/history', async (req) => {
    const q = parseBody(historyQuery, req.query);
    const c = await ctx.containers.resolve(req.params.ref);
    const since = Math.floor(Date.now() / 60_000) - q.minutes;
    return { rollups: ctx.statsRepo.history(c.id, since) };
  });

  app.post<{ Params: { ref: string; action: string } }>(
    '/containers/:ref/actions/:action',
    { preHandler: requirePerm(ctx, 'write') },
    async (req) => {
      const action = req.params.action as ContainerAction;
      if (!CONTAINER_ACTIONS.includes(action)) throw badRequest(`Unknown action "${req.params.action}"`);
      const body = parseBody(actionBody, req.body);
      const res = await ctx.containers.act(req.params.ref, action, body, actorOf(req));
      if (!res) throw notFound('Container');
      return res;
    },
  );
}
