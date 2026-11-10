import { z } from 'zod';
import type { Severity } from '@quaymaster/shared';
import { headerSafe, parseWith, sendHttp, trimSlash, type NotificationChannel } from '../channel.js';
import { outboundUrl } from './common.js';

const schema = z
  .object({
    serverUrl: outboundUrl,
    topic: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'topic may contain letters, digits, _ and -'),
    token: z.string().min(1).max(512).optional(),
  })
  .strict();
export type NtfyConfig = z.infer<typeof schema>;

export const NTFY_PRIORITY: Record<Severity, number> = { info: 3, warning: 4, critical: 5 };
const TAGS: Record<Severity, string> = {
  info: 'information_source',
  warning: 'warning',
  critical: 'rotating_light',
};

export const ntfyChannel: NotificationChannel<NtfyConfig> = {
  type: 'ntfy',
  label: 'ntfy',
  fields: [
    { name: 'serverUrl', label: 'Server URL', kind: 'url', required: true, secret: true },
    { name: 'topic', label: 'Topic', kind: 'string', required: true, secret: false },
    { name: 'token', label: 'Access token', kind: 'secret', required: false, secret: true },
  ],
  parseConfig: (raw) => parseWith(schema, raw, 'ntfy'),
  send(config, event, transport) {
    const headers: Record<string, string> = {
      Title: headerSafe(event.title),
      Priority: String(NTFY_PRIORITY[event.severity]),
      Tags: `${TAGS[event.severity]},${event.type}`,
      'content-type': 'text/plain; charset=utf-8',
    };
    if (config.token) headers['Authorization'] = `Bearer ${config.token}`;
    return sendHttp(transport, {
      url: `${trimSlash(config.serverUrl)}/${config.topic}`,
      method: 'POST',
      headers,
      body: event.message,
    });
  },
};
