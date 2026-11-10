import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DockerEventRecord } from '@quaymaster/shared';
import { parseBody, requirePerm } from '../app.js';
import type { AppContext } from '../context.js';
import { notFound } from '../util/errors.js';

const logStreamQuery = z.object({
  tail: z.coerce.number().int().min(0).max(2000).default(100),
  timestamps: z.enum(['true', 'false']).optional(),
});
const eventStreamQuery = z.object({ sinceId: z.coerce.number().int().min(0).optional() });

/** SSE streams. Each is registered in the SseHub and bound to the caller's session (RT-15). */
export function registerStreamRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/stream/events', async (req, reply) => {
    const q = parseBody(eventStreamQuery, req.query);
    const conn = ctx.sse.open(req, reply, req.auth as NonNullable<typeof req.auth>);
    if (q.sinceId !== undefined) {
      for (const e of ctx.eventsRepo.list({ limit: 200, sinceId: q.sinceId }).reverse()) conn.send('docker-event', e);
    }
    const onEvent = (e: DockerEventRecord) => conn.send('docker-event', e);
    ctx.events.on('event', onEvent);
    conn.onClose(() => ctx.events.off('event', onEvent));
  });

  app.get('/stream/stats', async (req, reply) => {
    const conn = ctx.sse.open(req, reply, req.auth as NonNullable<typeof req.auth>);
    conn.send('snapshot', ctx.stats.latest());
    const onSample = (s: unknown) => conn.send('stats', s);
    ctx.stats.on('sample', onSample);
    conn.onClose(() => ctx.stats.off('sample', onSample));
  });

  app.get<{ Params: { ref: string } }>('/stream/logs/:ref', { preHandler: requirePerm(ctx, 'logs') }, async (req, reply) => {
    const q = parseBody(logStreamQuery, req.query);
    // resolve first so 404/400 are reported as normal JSON errors, before the stream is opened
    await ctx.containers.resolve(req.params.ref);
    const session = req.auth as NonNullable<typeof req.auth>;
    const conn = ctx.sse.open(req, reply, session);
    let follow: { close(): void } | null = null;
    try {
      follow = await ctx.containers.logsFollow(
        req.params.ref,
        { tail: q.tail, timestamps: q.timestamps !== 'false' },
        (line) => conn.send('log', line),
        () => conn.close('container log stream ended'),
      );
    } catch (e) {
      conn.send('error', { message: (e as Error).message });
      conn.close('error');
      return;
    }
    conn.onClose(() => follow?.close());
  });

  app.get<{ Params: { id: string } }>('/stream/operations/:id', async (req, reply) => {
    if (!ctx.ops.get(req.params.id)) throw notFound('Operation');
    const conn = ctx.sse.open(req, reply, req.auth as NonNullable<typeof req.auth>);
    const unsub = ctx.ops.subscribe(req.params.id, (e) => {
      if (e.type === 'output') conn.send('output', { text: e.text });
      else {
        conn.send('status', { status: e.status, error: e.error });
        if (e.status !== 'running') setTimeout(() => conn.close('operation finished'), 50).unref();
      }
    });
    conn.onClose(() => unsub?.());
  });
}
