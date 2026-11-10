import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, requirePerm } from '../app.js';
import type { AppContext } from '../context.js';
import { notFound } from '../util/errors.js';

const eventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  beforeId: z.coerce.number().int().positive().optional(),
  container: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  project: z.string().max(100).optional(),
});
const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  beforeId: z.coerce.number().int().positive().optional(),
  action: z.string().max(100).optional(),
  actor: z.string().max(100).optional(),
});

export function registerMiscRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/events', async (req) => {
    const q = parseBody(eventsQuery, req.query);
    return { events: ctx.eventsRepo.list({ limit: q.limit, beforeId: q.beforeId, containerId: q.container, project: q.project }) };
  });

  // The audit log is admin-only and has no write/update/delete API.
  app.get('/audit', { preHandler: requirePerm(ctx, 'write') }, async (req) => {
    const q = parseBody(auditQuery, req.query);
    return { entries: ctx.audit.list(q) };
  });

  app.get('/operations', async () => ({ operations: ctx.ops.list(50) }));
  app.get<{ Params: { id: string } }>('/operations/:id', async (req) => {
    const op = ctx.ops.get(req.params.id);
    if (!op) throw notFound('Operation');
    return op;
  });
}
