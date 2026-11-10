import { z } from 'zod';
import { parseWith, truncate, type NotificationChannel, type SendResult } from '../channel.js';
import { SEVERITY_LABEL } from './common.js';

const schema = z
  .object({
    host: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9.:\-[\]]+$/, 'invalid host'),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean().default(false),
    username: z.string().min(1).max(256).optional(),
    password: z.string().min(1).max(1024).optional(),
    from: z.string().email().max(320),
    to: z.array(z.string().email().max(320)).min(1).max(20),
  })
  .strict();
export type SmtpConfig = z.infer<typeof schema>;

export const smtpChannel: NotificationChannel<SmtpConfig> = {
  type: 'smtp',
  label: 'Email (SMTP)',
  fields: [
    { name: 'host', label: 'SMTP host', kind: 'string', required: true, secret: false },
    { name: 'port', label: 'Port', kind: 'number', required: true, secret: false },
    { name: 'secure', label: 'Implicit TLS (port 465)', kind: 'boolean', required: false, secret: false },
    { name: 'username', label: 'Username', kind: 'string', required: false, secret: false },
    { name: 'password', label: 'Password', kind: 'secret', required: false, secret: true },
    { name: 'from', label: 'From', kind: 'email', required: true, secret: false },
    { name: 'to', label: 'Recipients', kind: 'string_list', required: true, secret: false },
  ],
  parseConfig: (raw) => parseWith(schema, raw, 'smtp'),
  async send(config, event, transport): Promise<SendResult> {
    const lines = [event.message, ...Object.entries(event.data ?? {}).map(([k, v]) => `${k}: ${String(v)}`)];
    try {
      await transport.sendMail({
        host: config.host,
        port: config.port,
        secure: config.secure,
        ...(config.username ? { username: config.username } : {}),
        ...(config.password ? { password: config.password } : {}),
        from: config.from,
        to: config.to,
        subject: truncate(`[${SEVERITY_LABEL[event.severity]}] ${event.title}`.replace(/[\r\n]+/g, ' '), 200),
        text: lines.join('\n'),
      });
      return { ok: true, httpStatus: null, error: null };
    } catch (err) {
      return {
        ok: false,
        httpStatus: null,
        error: (err instanceof Error ? err.message : 'mail failed').slice(0, 300),
      };
    }
  },
};
