import { z } from 'zod';
import type { Severity } from '@quaymaster/shared';
import { parseWith, sendHttp, truncate, type NotificationChannel } from '../channel.js';
import { outboundUrl } from './common.js';

const schema = z.object({ url: outboundUrl }).strict();
export type DiscordConfig = z.infer<typeof schema>;

export const DISCORD_COLOR: Record<Severity, number> = {
  info: 0x3498db,
  warning: 0xf1c40f,
  critical: 0xe74c3c,
};

export const discordChannel: NotificationChannel<DiscordConfig> = {
  type: 'discord',
  label: 'Discord',
  fields: [{ name: 'url', label: 'Webhook URL', kind: 'url', required: true, secret: true }],
  parseConfig: (raw) => parseWith(schema, raw, 'discord'),
  send(config, event, transport) {
    const fields = Object.entries(event.data ?? {})
      .slice(0, 25)
      .map(([k, v]) => ({
        name: truncate(k, 256) || '-',
        value: truncate(String(v), 1024) || '-',
        inline: true,
      }));
    return sendHttp(transport, {
      url: config.url,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'Quaymaster',
        allowed_mentions: { parse: [] },
        embeds: [
          {
            title: truncate(event.title, 256),
            description: truncate(event.message, 4000),
            color: DISCORD_COLOR[event.severity],
            timestamp: new Date(event.ts ?? Date.now()).toISOString(),
            footer: { text: `${event.severity} · ${event.type}` },
            fields,
          },
        ],
      }),
    });
  },
};
