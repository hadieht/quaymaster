import { z } from 'zod';
import { parseWith, sendHttp, trimSlash, truncate, type NotificationChannel } from '../channel.js';
import { outboundUrl, SEVERITY_LABEL } from './common.js';

const schema = z
  .object({
    botToken: z
      .string()
      .min(3)
      .max(200)
      .regex(/^[^\s/?#]+$/, 'invalid token format'),
    chatId: z.string().regex(/^(-?\d{1,20}|@[A-Za-z0-9_]{3,64})$/, 'chatId must be numeric or @channelname'),
    apiBase: outboundUrl.optional(),
  })
  .strict();
export type TelegramConfig = z.infer<typeof schema>;

export const telegramChannel: NotificationChannel<TelegramConfig> = {
  type: 'telegram',
  label: 'Telegram',
  fields: [
    { name: 'botToken', label: 'Bot token', kind: 'secret', required: true, secret: true },
    { name: 'chatId', label: 'Chat ID', kind: 'string', required: true, secret: false },
    {
      name: 'apiBase',
      label: 'API base URL',
      kind: 'url',
      required: false,
      secret: false,
      help: 'Defaults to https://api.telegram.org',
    },
  ],
  parseConfig: (raw) => parseWith(schema, raw, 'telegram'),
  send(config, event, transport) {
    const base = trimSlash(config.apiBase ?? 'https://api.telegram.org');
    // The bot token is part of the URL path, so the whole URL is a secret.
    return sendHttp(transport, {
      url: `${base}/bot${config.botToken}/sendMessage`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: truncate(`[${SEVERITY_LABEL[event.severity]}] ${event.title}\n${event.message}`, 4000),
        disable_web_page_preview: true,
      }),
    });
  },
};
