import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { actorOf, parseBody, requirePerm } from '../app.js';
import type { AppContext } from '../context.js';
import { badRequest } from '../util/errors.js';

const ignoreBody = z
  .object({
    kind: z.enum(['project', 'container']),
    name: z.string().min(1).max(255),
    confirm: z.string().max(255),
  })
  .strict();

/**
 * "Stop monitoring" list. Administrators only. None of these routes touches Docker or any file: they edit
 * Quaymaster's own ignore list.
 */
export function registerIgnoreRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/ignored', { preHandler: requirePerm(ctx, 'write') }, async () => ({
    entries: ctx.ignores.list(),
  }));

  app.post('/ignored', { preHandler: requirePerm(ctx, 'write') }, async (req, reply) => {
    const body = parseBody(ignoreBody, req.body);
    const entry = await ctx.ignores.ignore(body, actorOf(req));
    void reply.status(201);
    return entry;
  });

  app.delete<{ Params: { id: string } }>(
    '/ignored/:id',
    { preHandler: requirePerm(ctx, 'write') },
    async (req) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid id');
      return ctx.ignores.restore(id, actorOf(req));
    },
  );
}
