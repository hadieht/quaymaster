import type { ErrorCode, ErrorEnvelope } from '@quaymaster/shared';

/** All HTTP traffic goes through here: CSRF header, JSON handling, error envelope, 401 → login. */
export const API_BASE = '/api/v1';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | 'network' | 'unknown';
  readonly details: unknown;
  readonly retryAfter: number | null;
  constructor(
    status: number,
    code: ErrorCode | 'network' | 'unknown',
    message: string,
    details?: unknown,
    retryAfter: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

let csrfToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}
export function getCsrfToken(): string | null {
  return csrfToken;
}
/** Called once per 401 on an authenticated endpoint (the app shows the login page). */
export function onUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

/** Endpoints where a 401 is an expected answer (wrong password / not logged in yet), not an expired session. */
const AUTH_PROBES = new Set(['/auth/login', '/auth/setup', '/auth/status']);

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${API_BASE}${path}`;
  if (!query) return url;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${url}?${s}` : url;
}

export async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    if (csrfToken) headers['X-QM-CSRF'] = csrfToken;
  }
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      credentials: 'same-origin',
      signal: opts.signal,
      body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'Cannot reach the Quaymaster server');
  }
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (!res.ok) {
    const env = (data as Partial<ErrorEnvelope> | undefined)?.error;
    const retry = Number(res.headers.get('Retry-After'));
    const err = new ApiError(
      res.status,
      env?.code ?? 'unknown',
      env?.message ?? `Request failed (HTTP ${res.status})`,
      env?.details,
      Number.isFinite(retry) && retry > 0 ? retry : null,
    );
    if (res.status === 401 && !AUTH_PROBES.has(path)) {
      csrfToken = null;
      unauthorizedHandler?.();
    }
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
    request<T>('GET', path, undefined, { query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};

/** Human wording for an error, used by toasts and error states. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'rate_limited' && e.retryAfter) return `${e.message} Try again in ${e.retryAfter} s.`;
    return e.message;
  }
  return e instanceof Error ? e.message : 'Unexpected error';
}
