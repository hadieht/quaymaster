import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { maskUrlToSchemeHost } from '../redaction/redact.js';
import { badRequest } from '../util/errors.js';
import type { OutboundRequest } from './channel.js';

/**
 * The single outbound HTTP client policy (RT-21): http/https only, no userinfo, link-local /
 * unspecified / multicast destinations refused (cloud metadata!), loopback and RFC1918 allowed
 * (home servers), 5 s timeout, 64 KiB response cap, bodies never returned, redirects only to
 * the same host (max 3). Errors never contain the full URL (it is a secret as a whole).
 */

export const DEFAULT_TIMEOUT_MS = 5000;
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const MAX_REDIRECTS = 3;

function v4Bytes(ip: string): number[] | null {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  const n = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? n : null;
}

function v6Groups(ip: string): number[] | null {
  let s = ip.split('%')[0] ?? ip;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const b = v4Bytes(tail);
    if (!b) return null;
    s = `${s.slice(0, lastColon + 1)}${(((b[0] ?? 0) << 8) | (b[1] ?? 0)).toString(16)}:${(
      ((b[2] ?? 0) << 8) |
      (b[3] ?? 0)
    ).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const all = halves.length === 1 ? head : [...head, ...Array<string>(missing).fill('0'), ...rest];
  const g = all.map((x) => (/^[0-9a-fA-F]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
  return g.length === 8 && g.every((x) => !Number.isNaN(x)) ? g : null;
}

function checkV4(b: number[]): string | null {
  const [a, c] = [b[0] ?? 0, b[1] ?? 0];
  if (a === 0) return 'unspecified';
  if (a === 169 && c === 254) return 'link-local (cloud metadata range)';
  if (a >= 224) return a === 255 ? 'broadcast' : 'multicast';
  return null;
}

/** Returns why an IP literal must not be contacted, or null when it is allowed. */
export function disallowedAddressReason(ip: string): string | null {
  const fam = net.isIP(ip);
  if (fam === 4) return checkV4(v4Bytes(ip) ?? [0]);
  if (fam === 6) {
    const g = v6Groups(ip);
    if (!g) return 'unparseable';
    if (g.every((x) => x === 0)) return 'unspecified';
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      return checkV4([(g[6]! >> 8) & 255, g[6]! & 255, (g[7]! >> 8) & 255, g[7]! & 255]);
    }
    if ((g[0]! & 0xffc0) === 0xfe80) return 'link-local';
    if ((g[0]! & 0xff00) === 0xff00) return 'multicast';
    return null;
  }
  return 'not an IP address';
}

/** Validates scheme, userinfo and literal-IP hosts. Throws AppError 400 without echoing the URL. */
export function validateOutboundUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw badRequest('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw badRequest('Only http and https URLs are allowed');
  }
  if (u.username || u.password) {
    throw badRequest('URLs with embedded credentials (user:password@) are not allowed');
  }
  if (!u.hostname) throw badRequest('URL has no host');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    const why = disallowedAddressReason(host);
    if (why) throw badRequest(`Destination address ${host} is not allowed (${why})`);
  }
  return u;
}

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/** dns.lookup replacement that rejects unspecified/link-local/multicast results. */
export function checkedLookup(
  hostname: string,
  options: dns.LookupOptions | number | undefined,
  cb: LookupCb,
): void {
  const opts: dns.LookupOptions = typeof options === 'object' && options ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err, '');
    const list = addrs as dns.LookupAddress[];
    const bad = list.find((a) => disallowedAddressReason(a.address));
    if (bad || list.length === 0) {
      const e: NodeJS.ErrnoException = new Error(
        bad
          ? `Destination address ${bad.address} is not allowed (${disallowedAddressReason(bad.address)})`
          : 'host did not resolve',
      );
      e.code = 'EQM_BLOCKED_ADDRESS';
      return cb(e, '');
    }
    if (opts.all) return cb(null, list);
    const first = list[0]!;
    cb(null, first.address, first.family);
  });
}

/** Resolves a hostname applying the same address policy (used for SMTP). Returns one IP. */
export function resolveAllowed(hostname: string): Promise<string> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) {
    const why = disallowedAddressReason(bare);
    if (why) return Promise.reject(badRequest(`Destination address ${bare} is not allowed (${why})`));
    return Promise.resolve(bare);
  }
  return new Promise((resolve, reject) => {
    checkedLookup(hostname, {}, (err, address) => {
      if (err) reject(err);
      else resolve(typeof address === 'string' ? address : (address[0]?.address ?? ''));
    });
  });
}

export interface OutboundResult {
  status: number;
  /** Response bytes read (discarded; bodies are never returned). */
  bytesRead: number;
  truncated: boolean;
  redirects: number;
}

export class OutboundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundError';
  }
}

export class OutboundHttp {
  constructor(private readonly opts: { timeoutMs?: number; maxBytes?: number; maxRedirects?: number } = {}) {}

  async request(req: OutboundRequest): Promise<OutboundResult> {
    const timeoutMs = req.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRedirects = this.opts.maxRedirects ?? MAX_REDIRECTS;
    const deadline = Date.now() + timeoutMs;
    let current = validateOutboundUrl(req.url);
    const origin = current.host.toLowerCase();
    let method = (req.method ?? 'GET').toUpperCase();
    let body = req.body;
    for (let hop = 0; ; hop++) {
      const remaining = Math.max(1, deadline - Date.now());
      const res = await this.once(current, method, req.headers ?? {}, body, remaining);
      const loc = res.location;
      if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
        if (hop >= maxRedirects) {
          throw new OutboundError(`Too many redirects from ${maskUrlToSchemeHost(req.url)}`);
        }
        let next: URL;
        try {
          next = validateOutboundUrl(new URL(loc, current).toString());
        } catch {
          throw new OutboundError(
            `Redirect from ${maskUrlToSchemeHost(req.url)} to an invalid target refused`,
          );
        }
        if (next.host.toLowerCase() !== origin) {
          throw new OutboundError(
            `Redirect from ${maskUrlToSchemeHost(req.url)} to a different host refused`,
          );
        }
        if (res.status !== 307 && res.status !== 308) {
          method = 'GET';
          body = undefined;
        }
        current = next;
        continue;
      }
      return { status: res.status, bytesRead: res.bytesRead, truncated: res.truncated, redirects: hop };
    }
  }

  private once(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    timeoutMs: number,
  ): Promise<{ status: number; location: string | null; bytesRead: number; truncated: boolean }> {
    const masked = maskUrlToSchemeHost(url.toString());
    const maxBytes = this.opts.maxBytes ?? MAX_RESPONSE_BYTES;
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const h: Record<string, string> = { ...headers };
      if (body !== undefined && !Object.keys(h).some((k) => k.toLowerCase() === 'content-length')) {
        h['content-length'] = String(Buffer.byteLength(body));
      }
      const req = lib.request(
        url,
        { method, headers: h, lookup: checkedLookup as net.LookupFunction },
        (res) => {
          let bytes = 0;
          let truncated = false;
          const status = res.statusCode ?? 0;
          const location = typeof res.headers.location === 'string' ? res.headers.location : null;
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxBytes && !truncated) {
              truncated = true;
              res.destroy();
              done(() => resolve({ status, location, bytesRead: bytes, truncated }));
            }
          });
          res.on('end', () => done(() => resolve({ status, location, bytesRead: bytes, truncated })));
          res.on('error', () => done(() => resolve({ status, location, bytesRead: bytes, truncated })));
          res.on('close', () => done(() => resolve({ status, location, bytesRead: bytes, truncated })));
        },
      );
      const timer = setTimeout(() => {
        req.destroy();
        done(() => reject(new OutboundError(`Request to ${masked} timed out after ${timeoutMs} ms`)));
      }, timeoutMs);
      req.on('error', (err: NodeJS.ErrnoException) => {
        done(() =>
          reject(
            new OutboundError(
              err.code === 'EQM_BLOCKED_ADDRESS'
                ? `${err.message} (${masked})`
                : `Request to ${masked} failed: ${err.code ?? 'network error'}`,
            ),
          ),
        );
      });
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
}
