import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NOTIFICATION_EVENT_TYPES } from '@quaymaster/shared';
import { actorOf, parseBody, requirePerm } from '../app.js';
import type { AppContext } from '../context.js';
import type { NotificationService } from '../notifications/service.js';
import { badRequest } from '../util/errors.js';

const severity = z.enum(['info', 'warning', 'critical']);
const events = z
  .array(z.enum(['*', ...(NOTIFICATION_EVENT_TYPES as [string, ...string[]])]))
  .min(1)
  .max(50);
const config = z.record(z.unknown());
const channelId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const createBody = z
  .object({
    type: z.enum(['webhook', 'ntfy', 'gotify', 'discord', 'slack', 'telegram', 'smtp']),
    name: z.string().min(1).max(80),
    enabled: z.boolean().optional(),
    minSeverity: severity.optional(),
    events: events.optional(),
    config,
  })
  .strict();

const patchBody = z
  .object({
    name: z.string().min(1).max(80).optional(),
    enabled: z.boolean().optional(),
    minSeverity: severity.optional(),
    events: events.optional(),
    config: config.optional(),
  })
  .strict();

const deliveriesQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(50),
    channelId: channelId.optional(),
    beforeId: z.coerce.number().int().min(1).optional(),
  })
  .strict();

function id(raw: string): string {
  const r = channelId.safeParse(raw);
  if (!r.success) throw badRequest('Invalid channel id');
  return r.data;
}

export function registerNotificationRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ctx.notifications is wired by the parent (context.ts); the cast keeps this compiling either way.
  const svc = (): NotificationService =>
    (ctx as AppContext & { notifications: NotificationService }).notifications;

  app.get('/notifications/types', async () => svc().types());
  app.get('/notifications/channels', async () => svc().listChannels());
  app.get<{ Params: { id: string } }>('/notifications/channels/:id', async (req) =>
    svc().getChannel(id(req.params.id)),
  );

  app.post('/notifications/channels', { preHandler: requirePerm(ctx, 'write') }, async (req, reply) => {
    const body = parseBody(createBody, req.body);
    const created = svc().createChannel(
      {
        type: body.type,
        name: body.name,
        config: body.config,
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.minSeverity ? { minSeverity: body.minSeverity } : {}),
        ...(body.events ? { events: body.events } : {}),
      },
      actorOf(req),
    );
    void reply.status(201);
    return created;
  });

  app.patch<{ Params: { id: string } }>(
    '/notifications/channels/:id',
    { preHandler: requirePerm(ctx, 'write') },
    async (req) => {
      const body = parseBody(patchBody, req.body);
      return svc().updateChannel(id(req.params.id), body, actorOf(req));
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/notifications/channels/:id',
    { preHandler: requirePerm(ctx, 'write') },
    async (req, reply) => {
      svc().deleteChannel(id(req.params.id), actorOf(req));
      void reply.status(204);
      return null;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/notifications/channels/:id/test',
    { preHandler: requirePerm(ctx, 'write') },
    async (req) => svc().testChannel(id(req.params.id), actorOf(req)),
  );

  app.get('/notifications/deliveries', async (req) => {
    const q = parseBody(deliveriesQuery, req.query);
    return svc().listDeliveries({
      limit: q.limit,
      ...(q.channelId ? { channelId: q.channelId } : {}),
      ...(q.beforeId ? { beforeId: q.beforeId } : {}),
    });
  });
}
