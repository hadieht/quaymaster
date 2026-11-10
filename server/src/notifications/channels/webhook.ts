import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { NotificationEvent } from '@quaymaster/shared';
import {
  parseWith,
  sendHttp,
  type NotificationChannel,
  type SendResult,
  type Transport,
} from '../channel.js';
import { outboundUrl } from './common.js';

const RESERVED = new Set([
  'content-type',
  'content-length',
  'host',
  'x-quaymaster-signature',
  'x-quaymaster-timestamp',
]);

const schema = z
  .object({
    url: outboundUrl,
    secret: z.string().min(1).max(512).optional(),
    headers: z
      .record(
        z
          .string()
          .regex(/^[A-Za-z0-9-]{1,64}$/, 'invalid header name')
          .refine((k) => !RESERVED.has(k.toLowerCase()), 'reserved header name'),
        z
          .string()
          .max(1024)
          .refine((v) => !/[\r\n]/.test(v), 'invalid header value'),
      )
      .optional(),
  })
  .strict();

export type WebhookConfig = z.infer<typeof schema>;

export function webhookBody(event: NotificationEvent): string {
  return JSON.stringify({
    type: event.type,
    severity: event.severity,
    title: event.title,
    message: event.message,
    data: event.data ?? {},
    time: new Date(event.ts ?? Date.now()).toISOString(),
  });
}

export const webhookChannel: NotificationChannel<WebhookConfig> = {
  type: 'webhook',
  label: 'Webhook (JSON)',
  fields: [
    { name: 'url', label: 'URL', kind: 'url', required: true, secret: true },
    {
      name: 'secret',
      label: 'Signing secret',
      kind: 'secret',
      required: false,
      secret: true,
      help: 'Adds X-Quaymaster-Signature: sha256=<HMAC-SHA256 of the body>',
    },
    {
      name: 'headers',
      label: 'Extra headers',
      kind: 'secret',
      required: false,
      secret: true,
      help: 'JSON object of additional request headers (may carry credentials)',
    },
  ],
  parseConfig: (raw) => parseWith(schema, raw, 'webhook'),
  async send(config, event, transport: Transport): Promise<SendResult> {
    const body = webhookBody(event);
    const headers: Record<string, string> = {
      ...(config.headers ?? {}),
      'content-type': 'application/json',
      'user-agent': 'Quaymaster',
      'X-Quaymaster-Timestamp': String(Math.floor((event.ts ?? Date.now()) / 1000)),
    };
    if (config.secret) {
      headers['X-Quaymaster-Signature'] =
        `sha256=${createHmac('sha256', config.secret).update(body).digest('hex')}`;
    }
    return sendHttp(transport, { url: config.url, method: 'POST', headers, body });
  },
};
