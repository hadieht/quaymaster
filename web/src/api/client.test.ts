import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, describeError, onUnauthorized, setCsrfToken } from './client';

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fn = vi.fn(async () => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('api client', () => {
  beforeEach(() => {
    setCsrfToken(null);
    onUnauthorized(null);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends the CSRF header on mutations only', async () => {
    const fn = mockFetch(200, { ok: true });
    setCsrfToken('tok123');
    await api.get('/containers');
    await api.post('/containers/x/actions/start', {});
    const [getCall, postCall] = fn.mock.calls as unknown as [string, RequestInit][][];
    const getHeaders = (getCall as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    const postHeaders = (postCall as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(getHeaders['X-QM-CSRF']).toBeUndefined();
    expect(postHeaders['X-QM-CSRF']).toBe('tok123');
    expect((postCall as unknown as [string, RequestInit])[1].credentials).toBe('same-origin');
  });

  it('builds query strings and skips empty values', async () => {
    const fn = mockFetch(200, {});
    await api.get('/events', { limit: 20, project: '', container: undefined, x: 'a b' });
    expect((fn.mock.calls[0] as unknown as [string])[0]).toBe('/api/v1/events?limit=20&x=a+b');
  });

  it('maps the error envelope to ApiError', async () => {
    mockFetch(409, { error: { code: 'read_only', message: 'Read-only mode', details: { a: 1 } } });
    const err = await api.post('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'read_only', message: 'Read-only mode' });
  });

  it('calls the unauthorized handler on 401 except for login probes', async () => {
    const handler = vi.fn();
    onUnauthorized(handler);
    mockFetch(401, { error: { code: 'unauthorized', message: 'no' } });
    await api.get('/containers').catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
    await api.post('/auth/login', {}).catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('reports network failures and rate limits in plain words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('failed'))));
    const net = await api.get('/x').catch((e: unknown) => e);
    expect(net).toMatchObject({ code: 'network', status: 0 });
    mockFetch(429, { error: { code: 'rate_limited', message: 'Too many attempts.' } }, { 'Retry-After': '30' });
    const rl = await api.post('/auth/login', {}).catch((e: unknown) => e);
    expect(describeError(rl)).toBe('Too many attempts. Try again in 30 s.');
  });

  it('tolerates non-JSON error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })));
    const err = await api.get('/x').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: 'unknown' });
  });
});
