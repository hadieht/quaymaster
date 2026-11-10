import type { z, ZodTypeAny } from 'zod';
import type { ChannelFieldSpec, ChannelType, NotificationEvent } from '@quaymaster/shared';
import { AppError, badRequest } from '../util/errors.js';

export interface SendResult {
  ok: boolean;
  httpStatus: number | null;
  error: string | null;
}

export interface OutboundRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface MailOptions {
  host: string;
  port: number;
  secure: boolean;
  username?: string;
  password?: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
}

/** Injectable outbound facade (HTTP + SMTP) so tests can substitute fakes. */
export interface Transport {
  request(req: OutboundRequest): Promise<{ status: number }>;
  sendMail(opts: MailOptions): Promise<void>;
}

export interface NotificationChannel<C> {
  type: ChannelType;
  label: string;
  fields: ChannelFieldSpec[];
  /** Validates and normalises a raw config object. Throws AppError 400. */
  parseConfig(raw: unknown): C;
  send(config: C, event: NotificationEvent, transport: Transport): Promise<SendResult>;
}

/** zod parse that throws the uniform 400 error and never echoes input values. */
export function parseWith<S extends ZodTypeAny>(schema: S, raw: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(raw ?? {});
  if (!r.success) {
    throw badRequest(
      `Invalid ${what} configuration`,
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data as z.infer<S>;
}

export function resultFromStatus(status: number): SendResult {
  const ok = status >= 200 && status < 300;
  return { ok, httpStatus: status, error: ok ? null : `HTTP ${status}` };
}

/** Performs a request through the transport; transport errors become a failed SendResult. */
export async function sendHttp(transport: Transport, req: OutboundRequest): Promise<SendResult> {
  try {
    const res = await transport.request(req);
    return resultFromStatus(res.status);
  } catch (err) {
    const msg = err instanceof AppError || err instanceof Error ? err.message : 'request failed';
    return { ok: false, httpStatus: null, error: msg.slice(0, 300) };
  }
}

/** Makes a value safe for an HTTP header (no CR/LF; RFC 2047 for non-ASCII). */
export function headerSafe(v: string): string {
  const clean = v.replace(/[\r\n]+/g, ' ').trim();

  return /^[\x20-\x7e]*$/.test(clean)
    ? clean
    : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
