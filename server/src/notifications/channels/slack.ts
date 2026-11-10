import { z } from 'zod';
import type { Severity } from '@quaymaster/shared';
import { parseWith, sendHttp, truncate, type NotificationChannel } from '../channel.js';
import { outboundUrl } from './common.js';

const schema = z.object({ url: outboundUrl }).strict();
export type SlackConfig = z.infer<typeof schema>;

export const SLACK_COLOR: Record<Severity, string> = {
  info: '#3498db',
  warning: '#ecb22e',
  critical: '#e01e5a',
};
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const slackChannel: NotificationChannel<SlackConfig> = {
  type: 'slack',
  label: 'Slack',
  fields: [{ name: 'url', label: 'Incoming webhook URL', kind: 'url', required: true, secret: true }],
  parseConfig: (raw) => parseWith(schema, raw, 'slack'),
  send(config, event, transport) {
    const blocks: unknown[] = [
      { type: 'header', text: { type: 'plain_text', text: truncate(event.title, 150), emoji: false } },
      { type: 'section', text: { type: 'mrkdwn', text: truncate(esc(event.message), 3000) || ' ' } },
    ];
    const data = Object.entries(event.data ?? {}).slice(0, 10);
    if (data.length > 0) {
      blocks.push({
        type: 'section',
        fields: data.map(([k, v]) => ({
          type: 'mrkdwn',
          text: truncate(`*${esc(k)}*\n${esc(String(v))}`, 2000),
        })),
      });
    }
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${event.severity} · ${event.type}` }],
    });
    return sendHttp(transport, {
      url: config.url,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: truncate(`${event.title}: ${event.message}`, 300),
        attachments: [{ color: SLACK_COLOR[event.severity], blocks }],
      }),
    });
  },
};
