import { z } from 'zod';
import type { Severity } from '@quaymaster/shared';
import { parseWith, sendHttp, trimSlash, type NotificationChannel } from '../channel.js';
import { outboundUrl } from './common.js';

const schema = z
  .object({
    serverUrl: outboundUrl,
    appToken: z.string().min(1).max(512),
  })
  .strict();
export type GotifyConfig = z.infer<typeof schema>;

export const GOTIFY_PRIORITY: Record<Severity, number> = { info: 3, warning: 5, critical: 8 };

export const gotifyChannel: NotificationChannel<GotifyConfig> = {
  type: 'gotify',
  label: 'Gotify',
  fields: [
    { name: 'serverUrl', label: 'Server URL', kind: 'url', required: true, secret: true },
    { name: 'appToken', label: 'Application token', kind: 'secret', required: true, secret: true },
  ],
  parseConfig: (raw) => parseWith(schema, raw, 'gotify'),
  send(config, event, transport) {
    return sendHttp(transport, {
      url: `${trimSlash(config.serverUrl)}/message`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Gotify-Key': config.appToken },
      body: JSON.stringify({
        title: event.title,
        message: event.message,
        priority: GOTIFY_PRIORITY[event.severity],
        extras: { 'client::display': { contentType: 'text/plain' } },
      }),
    });
  },
};
