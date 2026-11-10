import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export function registerInventoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/images', async () => ctx.images.list());
  app.get<{ Params: { ref: string } }>('/images/:ref', async (req) => ctx.images.inspect(req.params.ref));
  app.get('/volumes', async () => ctx.volumes.list());
  app.get<{ Params: { name: string } }>('/volumes/:name', async (req) =>
    ctx.volumes.inspect(req.params.name),
  );
  app.get('/networks', async () => ctx.networks.list());
  app.get<{ Params: { ref: string } }>('/networks/:ref', async (req) => ctx.networks.inspect(req.params.ref));
}
