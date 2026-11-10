import { createHash } from 'node:crypto';
import { apiHost, type ImageRef } from './reference.js';

/** Media types we accept so the registry returns the manifest/index as published (RT-20). */
export const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export type RegistryErrorKind =
  'unauthorized' | 'not_found' | 'rate_limited' | 'network' | 'invalid' | 'other';

export class RegistryError extends Error {
  constructor(
    public readonly kind: RegistryErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

export interface Credentials {
  username: string;
  password: string;
}

export interface RegistryClientOptions {
  fetch?: typeof fetch;
  credentials?: (host: string) => Credentials | undefined;
  /** http (instead of https) is allowed for these hosts; loopback is always allowed. */
  insecureHosts?: string[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Random jitter added before each request (ms). */
  jitterMs?: () => number;
  /** Minimum gap between two requests to one registry host. */
  minIntervalMs?: number;
  /** Maximum automatic retries on HTTP 429. */
  maxRetries?: number;
  /** Retry-After (and backoff) cap. */
  maxBackoffMs?: number;
  timeoutMs?: number;
  /** Extra token-realm hosts allowed per registry host (in addition to the registry host itself). */
  realmAllowList?: Record<string, string[]>;
}

/** Token realms that legitimately live on another host than the registry (RT-20). */
export const DEFAULT_REALM_ALLOW: Record<string, string[]> = {
  'registry-1.docker.io': ['auth.docker.io'],
  'ghcr.io': ['ghcr.io'],
  'quay.io': ['quay.io'],
  'lscr.io': ['ghcr.io'],
  'registry.gitlab.com': ['gitlab.com'],
  'public.ecr.aws': ['public.ecr.aws'],
};

export interface ManifestHead {
  digest: string;
  mediaType: string | null;
}

export interface ManifestDoc {
  digest: string;
  mediaType: string;
  json: {
    mediaType?: string;
    manifests?: {
      digest: string;
      mediaType?: string;
      platform?: { os?: string; architecture?: string; variant?: string };
    }[];
    config?: { size?: number };
    layers?: { size?: number; digest?: string }[];
  };
  size: number;
}

interface Challenge {
  scheme: 'bearer' | 'basic' | 'other';
  params: Record<string, string>;
}

export function parseChallenge(header: string | null): Challenge | null {
  if (!header) return null;
  const m = /^\s*(\w+)\s*(.*)$/.exec(header);
  if (!m) return null;
  const scheme = (m[1] ?? '').toLowerCase();
  const params: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let p: RegExpExecArray | null;
  while ((p = re.exec(m[2] ?? ''))) params[(p[1] ?? '').toLowerCase()] = p[2] ?? '';
  return { scheme: scheme === 'bearer' ? 'bearer' : scheme === 'basic' ? 'basic' : 'other', params };
}

export const isLoopbackHost = (host: string): boolean => {
  const h = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
};

/**
 * Minimal Docker Registry v2 client: manifest digest by HEAD with token authentication.
 *
 * - credentials are sent only to the registry itself or to an allow-listed token realm, and only
 *   over https (loopback / explicitly insecure hosts may use http) — RT-20
 * - per-host throttle with jitter, serialised requests, honours `Retry-After` on 429 and then
 *   backs the host off so a rate-limited registry is not hammered
 */
export class RegistryClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly lastRequest = new Map<string, number>();
  private readonly backoffUntil = new Map<string, number>();
  private readonly o: Required<Omit<RegistryClientOptions, 'fetch' | 'credentials' | 'sleep' | 'now'>> & {
    credentials: (host: string) => Credentials | undefined;
  };
  requests = 0;

  constructor(opts: RegistryClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.o = {
      credentials: opts.credentials ?? (() => undefined),
      insecureHosts: opts.insecureHosts ?? [],
      jitterMs: opts.jitterMs ?? (() => Math.floor(Math.random() * 150)),
      minIntervalMs: opts.minIntervalMs ?? 250,
      maxRetries: opts.maxRetries ?? 2,
      maxBackoffMs: opts.maxBackoffMs ?? 60_000,
      timeoutMs: opts.timeoutMs ?? 15_000,
      realmAllowList: { ...DEFAULT_REALM_ALLOW, ...(opts.realmAllowList ?? {}) },
    };
  }

  private isInsecure(host: string): boolean {
    return isLoopbackHost(host) || this.o.insecureHosts.includes(host);
  }

  private baseUrl(host: string): string {
    return `${this.isInsecure(host) ? 'http' : 'https'}://${host}`;
  }

  /** Time (epoch ms) until which a rate-limited host is left alone; 0 when not backed off. */
  backedOffUntil(ref: Pick<ImageRef, 'registry'>): number {
    const u = this.backoffUntil.get(apiHost(ref)) ?? 0;
    return u > this.now() ? u : 0;
  }

  /** HEAD the manifest of `reference` (tag or digest); returns the digest the registry serves. */
  async headManifest(ref: ImageRef, reference?: string): Promise<ManifestHead> {
    const r = reference ?? ref.digest ?? ref.tag ?? 'latest';
    const res = await this.request(ref, `/v2/${ref.repo}/manifests/${r}`, 'HEAD');
    const digest = res.headers.get('docker-content-digest');
    if (digest && /^sha256:[0-9a-f]{64}$/.test(digest)) {
      return { digest, mediaType: res.headers.get('content-type') };
    }
    // some registries omit the header on HEAD: fall back to a GET and hash the body
    const doc = await this.getManifest(ref, r);
    return { digest: doc.digest, mediaType: doc.mediaType };
  }

  async getManifest(ref: ImageRef, reference?: string): Promise<ManifestDoc> {
    const r = reference ?? ref.digest ?? ref.tag ?? 'latest';
    const res = await this.request(ref, `/v2/${ref.repo}/manifests/${r}`, 'GET');
    const text = await res.text();
    if (text.length > 4 * 1024 * 1024) throw new RegistryError('invalid', 'manifest too large');
    let json: ManifestDoc['json'];
    try {
      json = JSON.parse(text) as ManifestDoc['json'];
    } catch {
      throw new RegistryError('invalid', 'registry returned a manifest that is not JSON');
    }
    const header = res.headers.get('docker-content-digest');
    const digest =
      header && /^sha256:[0-9a-f]{64}$/.test(header)
        ? header
        : `sha256:${createHash('sha256').update(text).digest('hex')}`;
    return {
      digest,
      mediaType: res.headers.get('content-type') ?? json.mediaType ?? '',
      json,
      size: Buffer.byteLength(text),
    };
  }

  /** Sum of compressed layer sizes for the platform manifest behind `digest` (for the disk preflight). */
  async compressedSize(
    ref: ImageRef,
    digest: string,
    platform = { os: 'linux', architecture: 'amd64' },
  ): Promise<number> {
    let doc = await this.getManifest(ref, digest);
    if (doc.json.manifests) {
      const m =
        doc.json.manifests.find(
          (x) => x.platform?.os === platform.os && x.platform?.architecture === platform.architecture,
        ) ?? doc.json.manifests[0];
      if (!m) return 0;
      doc = await this.getManifest(ref, m.digest);
    }
    return (doc.json.layers ?? []).reduce((s, l) => s + (l.size ?? 0), 0) + (doc.json.config?.size ?? 0);
  }

  // ---- internals -------------------------------------------------------------------------

  private async request(ref: ImageRef, path: string, method: 'HEAD' | 'GET'): Promise<Response> {
    const host = apiHost(ref);
    return this.serialised(host, async () => {
      const until = this.backoffUntil.get(host) ?? 0;
      if (this.now() < until) {
        throw new RegistryError(
          'rate_limited',
          `${host} is rate limiting us; backing off for ${Math.ceil((until - this.now()) / 1000)}s`,
          429,
        );
      }
      let attempt = 0;
      for (;;) {
        await this.throttle(host);
        const res = await this.once(ref, host, path, method);
        if (res.status !== 429) return this.check(res, host);
        const ra = Number(res.headers.get('retry-after'));
        const wait = Math.min(
          Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** attempt,
          this.o.maxBackoffMs,
        );
        if (attempt >= this.o.maxRetries) {
          this.backoffUntil.set(host, this.now() + wait);
          throw new RegistryError('rate_limited', `${host} answered HTTP 429 (rate limited)`, 429);
        }
        attempt++;
        await this.sleep(wait);
      }
    });
  }

  private check(res: Response, host: string): Response {
    if (res.ok) return res;
    if (res.status === 404) throw new RegistryError('not_found', `${host}: manifest not found`, 404);
    if (res.status === 401 || res.status === 403)
      throw new RegistryError(
        'unauthorized',
        `${host}: authentication required or denied (HTTP ${res.status})`,
        res.status,
      );
    throw new RegistryError('other', `${host}: HTTP ${res.status}`, res.status);
  }

  /** One authenticated attempt (handles the 401 challenge once). */
  private async once(ref: ImageRef, host: string, path: string, method: 'HEAD' | 'GET'): Promise<Response> {
    const url = `${this.baseUrl(host)}${path}`;
    const scopeKey = `${host}|${ref.repo}`;
    const cached = this.tokens.get(scopeKey);
    const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };
    if (cached && cached.expiresAt > this.now()) headers['Authorization'] = `Bearer ${cached.token}`;
    let res = await this.fetchTimed(url, method, headers);
    if (res.status !== 401) return res;
    const ch = parseChallenge(res.headers.get('www-authenticate'));
    if (!ch) return res;
    const creds = this.o.credentials(host);
    if (ch.scheme === 'bearer') {
      const token = await this.fetchToken(host, ch, ref, creds);
      if (!token) return res;
      this.tokens.set(scopeKey, { token: token.token, expiresAt: this.now() + token.ttlMs });
      res = await this.fetchTimed(url, method, { ...headers, Authorization: `Bearer ${token.token}` });
    } else if (ch.scheme === 'basic' && creds) {
      // Basic credentials only ever go over https (or an explicitly trusted insecure host)
      res = await this.fetchTimed(url, method, {
        ...headers,
        Authorization: `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`,
      });
    }
    return res;
  }

  private realmAllowed(host: string, realm: URL): boolean {
    if (realm.protocol !== 'https:' && !(this.isInsecure(host) && realm.protocol === 'http:')) return false;
    if (realm.host.toLowerCase() === host.toLowerCase()) return true;
    return (this.o.realmAllowList[host] ?? []).includes(realm.hostname.toLowerCase());
  }

  private async fetchToken(
    host: string,
    ch: Challenge,
    ref: ImageRef,
    creds: Credentials | undefined,
  ): Promise<{ token: string; ttlMs: number } | null> {
    const realmRaw = ch.params['realm'];
    if (!realmRaw) return null;
    let realm: URL;
    try {
      realm = new URL(realmRaw);
    } catch {
      return null;
    }
    // RT-20: never send credentials (or even a token request) to a realm the registry did not earn
    if (!this.realmAllowed(host, realm)) {
      throw new RegistryError('unauthorized', `${host}: refusing token realm on host ${realm.host}`, 401);
    }
    if (ch.params['service']) realm.searchParams.set('service', ch.params['service']);
    realm.searchParams.set('scope', ch.params['scope'] ?? `repository:${ref.repo}:pull`);
    const headers: Record<string, string> = {};
    if (creds)
      headers['Authorization'] =
        `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`;
    const res = await this.fetchTimed(realm.toString(), 'GET', headers);
    if (res.status === 429) throw new RegistryError('rate_limited', `${realm.host} answered HTTP 429`, 429);
    if (!res.ok)
      throw new RegistryError(
        'unauthorized',
        `${realm.host}: token request failed (HTTP ${res.status})`,
        res.status,
      );
    const body = (await res.json().catch(() => null)) as {
      token?: string;
      access_token?: string;
      expires_in?: number;
    } | null;
    const token = body?.token ?? body?.access_token;
    if (!token) throw new RegistryError('unauthorized', `${realm.host}: token response had no token`, 401);
    return { token, ttlMs: Math.max(10, (body?.expires_in ?? 60) - 10) * 1000 };
  }

  private async fetchTimed(url: string, method: string, headers: Record<string, string>): Promise<Response> {
    this.requests++;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs);
    try {
      // redirects are not followed automatically: a manifest request is never redirected legitimately
      return await this.fetchImpl(url, { method, headers, signal: ctl.signal, redirect: 'manual' });
    } catch (e) {
      throw new RegistryError(
        'network',
        `request failed: ${(e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async throttle(host: string): Promise<void> {
    const last = this.lastRequest.get(host) ?? 0;
    const wait = Math.max(0, last + this.o.minIntervalMs - this.now()) + this.o.jitterMs();
    if (wait > 0) await this.sleep(wait);
    this.lastRequest.set(host, this.now());
  }

  /** One request at a time per registry host. */
  private serialised<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(host) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      host,
      next.catch(() => undefined),
    );
    return next;
  }
}
