import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StorageCleanupCategory } from '@quaymaster/shared';
import { actorOf, parseBody, requirePerm } from '../app.js';
import type { AppContext } from '../context.js';

const previewBody = z
  .object({
    categories: z
      .array(z.enum(['unused_networks', 'anonymous_volumes', 'named_volumes']))
      .min(1)
      .max(3),
    includeComposeProjectVolumes: z.boolean().optional(),
    minAgeHours: z
      .number()
      .min(0)
      .max(24 * 365)
      .optional(),
  })
  .strict();
const executeBody = z.object({ previewId: z.string().uuid(), confirm: z.string().max(300) }).strict();
const volumeBody = z
  .object({ confirm: z.string().max(300), acknowledgeComposeProject: z.boolean().optional() })
  .strict();
const confirmBody = z.object({ confirm: z.string().max(300) }).strict();
const imageBody = z
  .object({ confirm: z.string().max(400), tag: z.string().min(1).max(400).optional() })
  .strict();

/**
 * Removal of volumes, networks and images, per item and in bulk (docs/ARCHITECTURE.md 7.6).
 * Routes only validate and delegate: every rule (scope, read-only, self-protection, in-use,
 * Compose ownership, confirmation, TOCTOU re-check, audit) lives in the service layer.
 */
export function registerStorageRoutes(app: FastifyInstance, ctx: AppContext): void {
  const write = { preHandler: requirePerm(ctx, 'write') };

  app.post('/storage/cleanup/preview', write, async (req) => {
    const b = parseBody(previewBody, req.body);
    return ctx.storage.preview(
      {
        categories: b.categories as StorageCleanupCategory[],
        includeComposeProjectVolumes: b.includeComposeProjectVolumes,
        minAgeHours: b.minAgeHours,
      },
      actorOf(req),
    );
  });
  app.post('/storage/cleanup/execute', write, async (req) => {
    const b = parseBody(executeBody, req.body);
    return ctx.storage.execute(b.previewId, b.confirm, actorOf(req));
  });

  app.post<{ Params: { name: string } }>('/volumes/:name/remove', write, async (req) => {
    const b = parseBody(volumeBody, req.body);
    return ctx.storage.removeVolume(req.params.name, b, actorOf(req));
  });
  app.post<{ Params: { ref: string } }>('/networks/:ref/remove', write, async (req) => {
    const b = parseBody(confirmBody, req.body);
    return ctx.storage.removeNetwork(req.params.ref, b, actorOf(req));
  });
  app.post<{ Params: { ref: string } }>('/images/:ref/remove', write, async (req) => {
    const b = parseBody(imageBody, req.body);
    return ctx.cleanup.removeImage(req.params.ref, b, actorOf(req));
  });
}
