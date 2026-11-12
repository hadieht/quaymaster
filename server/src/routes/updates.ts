import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CleanupCategory } from '@quaymaster/shared';
import { actorOf, parseBody, requirePerm } from '../app.js';
import type { AppContext } from '../context.js';
import { cacheKey, engineName, formatRef, parseImageRef } from '../registry/reference.js';
import { AppError, badRequest, notFound } from '../util/errors.js';
import { startStandalonePull } from '../updates/pull.js';

const refBody = z.object({ ref: z.string().min(1).max(400) }).strict();
const previewBody = z
  .object({
    categories: z
      .array(z.enum(['dangling_images', 'unused_images', 'stopped_containers', 'expired_rollback']))
      .max(4)
      .optional(),
    minAgeHours: z
      .number()
      .min(0)
      .max(24 * 365)
      .optional(),
    labelFilter: z.string().max(200).optional(),
  })
  .strict();
const executeBody = z.object({ previewId: z.string().uuid(), confirm: z.string().max(100) }).strict();
const credBody = z
  .object({
    host: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9.-]+(:\d{1,5})?$/),
    username: z.string().min(1).max(200),
    password: z.string().min(1).max(4000),
  })
  .strict();
const quarantineClear = z
  .object({
    target: z.string().min(1).max(400),
    digest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

/** Registry checks, standalone pulls (staging), cleanup, credentials and quarantine. */
export function registerUpdateRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/updates', async () => ({ images: await ctx.updates.statuses() }));

  /** Forces a fresh registry lookup (outbound requests, throttled): admin only. */
  app.post('/updates/check', { preHandler: requirePerm(ctx, 'write') }, async (req) => {
    const actor = actorOf(req);
    const images = await ctx.updates.statuses({ fresh: true });
    ctx.audit.record({
      actor: actor.name,
      ip: actor.ip,
      action: 'updates.check',
      target: 'all',
      params: { images: images.length, updates: images.filter((i) => i.state.startsWith('update')).length },
      outcome: 'success',
    });
    return { images };
  });

  app.get('/updates/quarantine', async () => ({
    entries: ctx.quarantineRepo.list().map((q) => ({
      target: q.target,
      digest: q.digest,
      runId: q.run_id,
      reason: q.reason,
      createdAt: new Date(q.created_at).toISOString(),
    })),
  }));

  app.post('/updates/quarantine/clear', { preHandler: requirePerm(ctx, 'write') }, async (req) => {
    const b = parseBody(quarantineClear, req.body);
    const n = ctx.quarantineRepo.clear(b.target, b.digest ?? null, ctx.clock.now());
    const actor = actorOf(req);
    ctx.audit.record({
      actor: actor.name,
      ip: actor.ip,
      action: 'updates.quarantine.clear',
      target: b.target,
      params: { digest: b.digest ?? null, cleared: n },
      outcome: 'success',
    });
    return { cleared: n };
  });

  /**
   * Standalone pull (RT-07/RT-20): resolves the registry digest, pulls BY DIGEST and stages the result.
   * It never restarts, recreates or retags anything that is in use. If the tag does not exist locally
   * yet there is nothing to move, so the tag is added as well.
   */
  app.post('/images/pull', { preHandler: requirePerm(ctx, 'write') }, async (req, reply) => {
    const { ref: raw } = parseBody(refBody, req.body);
    const id = await startStandalonePull(ctx, raw, actorOf(req));
    void reply.status(202);
    return { operationId: id };
  });

  app.get('/images/staged', async () => ({
    staged: ctx.stagedRepo.list().map((s) => ({
      tag: s.tag,
      ref: s.ref,
      digest: s.digest,
      imageId: s.image_id,
      createdAt: new Date(s.created_at).toISOString(),
    })),
    rollbackPoints: ctx.rollbackRepo.list().map((r) => ({
      tag: r.tag,
      runId: r.run_id,
      project: r.project,
      service: r.service,
      ref: r.ref,
      imageId: r.image_id,
      createdAt: new Date(r.created_at).toISOString(),
      expiresAt: new Date(r.expires_at).toISOString(),
      released: r.released === 1,
    })),
  }));

  // ---- cleanup: preview is mandatory
  app.post('/images/cleanup/preview', { preHandler: requirePerm(ctx, 'write') }, async (req) => {
    const b = parseBody(previewBody, req.body);
    return ctx.cleanup.preview(
      {
        categories: b.categories as CleanupCategory[] | undefined,
        minAgeHours: b.minAgeHours,
        labelFilter: b.labelFilter,
      },
      actorOf(req),
    );
  });
  app.post('/images/cleanup/execute', { preHandler: requirePerm(ctx, 'write') }, async (req) => {
    const b = parseBody(executeBody, req.body);
    return ctx.cleanup.execute(b.previewId, b.confirm, actorOf(req));
  });

  // ---- registry credentials (encrypted at rest, never returned)
  app.get('/registries/credentials', { preHandler: requirePerm(ctx, 'write') }, async () => ({
    credentials: ctx.registryCreds
      .list()
      .map((c) => ({ host: c.host, username: c.username, updatedAt: new Date(c.updated_at).toISOString() })),
  }));
  app.put('/registries/credentials', { preHandler: requirePerm(ctx, 'write') }, async (req) => {
    const b = parseBody(credBody, req.body);
    ctx.registryCreds.put(b.host.toLowerCase(), b.username, b.password);
    ctx.checksRepo.invalidate();
    const actor = actorOf(req);
    ctx.audit.record({
      actor: actor.name,
      ip: actor.ip,
      action: 'registry.credentials.put',
      target: b.host,
      params: { username: b.username },
      outcome: 'success',
    });
    return { host: b.host, username: b.username };
  });
  app.delete<{ Params: { host: string } }>(
    '/registries/credentials/:host',
    { preHandler: requirePerm(ctx, 'write') },
    async (req) => {
      if (!ctx.registryCreds.delete(req.params.host.toLowerCase())) throw notFound('Credential');
      const actor = actorOf(req);
      ctx.audit.record({
        actor: actor.name,
        ip: actor.ip,
        action: 'registry.credentials.delete',
        target: req.params.host,
        outcome: 'success',
      });
      return { ok: true };
    },
  );
}
