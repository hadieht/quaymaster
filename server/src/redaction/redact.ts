/**
 * Redaction (spec 6.3 as amended by RT-04).
 *
 * Everything that leaves the process (API responses, SSE frames, persisted events and operation
 * output, notifications, logs) goes through this module. There is no per-section list: objects are
 * walked at every depth, and known secret values are additionally scrubbed from free text.
 */

export const MASK = '••••••';

/** Key names (case-insensitive substring match) whose values are treated as secrets. */
export const SECRET_KEY_RE =
  /pass|pwd|secret|token|key|credential|auth|private|cert|dsn|connection|cookie|session|salt|signature|webhook|psk|seed|mnemonic|passphrase|otp|bearer|apikey|access|license|encrypt|hash|hmac/i;

/** Keys that match the secret pattern but are known to be harmless and useful to show. */
const SAFE_KEY_RE = /^(sandboxkey|com\.docker\.compose\.config-hash|org\.opencontainers\.image\..+)$/i;

/** Query-parameter names masked in URLs (a superset of the key rules). */
const QUERY_SECRET_RE = new RegExp(`${SECRET_KEY_RE.source}|^sig$|^s?sig(nature)?$|^code$`, 'i');

/** Keys whose arrays/maps hold `NAME=value` environment entries. */
const ENV_KEYS = new Set(['env', 'environment', 'labels', 'label']);
/** Of the above, the ones `QM_REDACT_ALL_ENV` masks entirely. */
const ALL_ENV_KEYS = new Set(['env', 'environment']);

export function isSecretKey(key: string): boolean {
  if (SAFE_KEY_RE.test(key)) return false;
  return SECRET_KEY_RE.test(key);
}

// ---------------------------------------------------------------------------------------------
// Value heuristics
// ---------------------------------------------------------------------------------------------

const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const PEM_RE = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g;
const PREFIX_RES: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bdckr_pat_[A-Za-z0-9_-]{16,}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, // telegram bot token
];
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

function shannon(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True for values that look like a secret regardless of their key: JWTs, PEM blocks, known token
 * prefixes, or a long high-entropy string. Digest/image-ID references (`sha256:...`) and UUIDs
 * are never considered secrets.
 */
export function looksLikeSecretValue(value: string): boolean {
  const v = value.trim();
  if (v.length < 8) return false;
  if (v === MASK) return false;
  if (v.startsWith('sha256:') || UUID_RE.test(v) || v.startsWith('/')) return false;
  if (v.includes('-----BEGIN ')) return true;
  const probe = (re: RegExp) => new RegExp(re.source, re.flags.replace('g', '')).test(v);
  if (probe(JWT_RE)) return true;
  if (PREFIX_RES.some(probe)) return true;
  if (/^[A-Za-z0-9+/_=-]+$/.test(v) && v.length >= 20) {
    const classes =
      Number(/[a-z]/.test(v)) + Number(/[A-Z]/.test(v)) + Number(/\d/.test(v)) + Number(/[+/_=-]/.test(v));
    const h = shannon(v);
    if (classes >= 3 && h >= 3.7) return true;
    if (v.length >= 32 && classes >= 2 && h >= 3.5) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------------------------

type Sink = (secret: string) => void;
const URL_PARTS_RE = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*@)?([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i;

function maskPath(host: string, pathPart: string, sink?: Sink): string {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  const segs = pathPart.split('/');
  const maskSeg = (i: number) => {
    const s = segs[i];
    if (s === undefined || s === '' || s === MASK) return;
    sink?.(s);
    segs[i] = MASK;
  };
  if (/(^|\.)(discord(app)?\.com)$/.test(h)) {
    const i = segs.indexOf('webhooks');
    if (i >= 0) {
      maskSeg(i + 2);
      return segs.join('/');
    }
  }
  if (h === 'hooks.slack.com') {
    const i = segs.indexOf('services');
    if (i >= 0) for (let j = i + 1; j < segs.length; j++) maskSeg(j);
    return segs.join('/');
  }
  if (h === 'api.telegram.org') {
    for (let j = 0; j < segs.length; j++) {
      const m = /^bot(.+)$/.exec(segs[j] ?? '');
      if (m && m[1] && m[1] !== MASK) {
        sink?.(m[1]);
        segs[j] = `bot${MASK}`;
      }
    }
    return segs.join('/');
  }
  // Generic: opaque path segments (long, high entropy) are tokens (webhook URLs).
  for (let j = 0; j < segs.length; j++) {
    const s = segs[j] ?? '';
    if (s.length >= 20 && /^[A-Za-z0-9_-]+$/.test(s) && looksLikeSecretValue(s)) maskSeg(j);
  }
  return segs.join('/');
}

/** Masks userinfo, secret-named query parameters and secrets embedded in well-known webhook paths. */
export function redactUrl(url: string, sink?: Sink): string {
  const m = URL_PARTS_RE.exec(url);
  if (!m) return url;
  const [, scheme = '', userinfo, host = '', pathPart = '', query, frag = ''] = m;
  let out = scheme;
  if (userinfo) {
    const raw = userinfo.slice(0, -1);
    if (raw !== MASK) {
      const [user, ...rest] = raw.split(':');
      if (rest.length > 0) sink?.(rest.join(':'));
      else if (user) sink?.(user);
      if (user && rest.length > 0) sink?.(user);
    }
    out += `${MASK}@`;
  }
  out += host;
  out += /^https?:/i.test(scheme) ? maskPath(host, pathPart, sink) : pathPart;
  if (query) {
    const parts = query.slice(1).split('&');
    out +=
      '?' +
      parts
        .map((p) => {
          const eq = p.indexOf('=');
          if (eq < 0) return p;
          const k = p.slice(0, eq);
          const v = p.slice(eq + 1);
          let key = k;
          try {
            key = decodeURIComponent(k);
          } catch {
            /* keep raw */
          }
          if (v && v !== MASK && QUERY_SECRET_RE.test(key) && !SAFE_KEY_RE.test(key)) {
            sink?.(v);
            return `${k}=${MASK}`;
          }
          return p;
        })
        .join('&');
  }
  return out + frag;
}

/** Notification URLs are secrets as a whole (RT-04): show only scheme + host. */
export function maskUrlToSchemeHost(url: string): string {
  const m = URL_PARTS_RE.exec(url);
  if (!m) return MASK;
  const host = (m[3] ?? '').replace(/^.*@/, '');
  return `${m[1]}${host}/${MASK}`;
}

// ---------------------------------------------------------------------------------------------
// Free text
// ---------------------------------------------------------------------------------------------

const URL_IN_TEXT_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"<>`]+/g;
// --password=x, --password x, -p... (only when the flag name itself looks secret-ish)
const FLAG_RE = /(--?[A-Za-z][\w.-]*)(=|[ \t]+)(?!-)("[^"]*"|'[^']*'|\S+)/g;
// NAME=value tokens: DB_PASSWORD=hunter2
const ASSIGN_RE = /(^|[\s;&|(,{"'])([A-Za-z_][\w.-]*)=("[^"]*"|'[^']*'|[^\s;&|)'",}]+)/g;
// curl-style "-u user:password"
const USER_FLAG_RE = /(^|\s)(-u|--user|--proxy-user)([ =])([^\s:'"]+):("[^"]*"|'[^']*'|\S+)/g;
// HTTP header style "X-Token: value" / "api_key: value"
const HEADER_RE = /(^|[\s{"',(])([A-Za-z][\w.-]*)(:[ \t]+)(?!Bearer\b|Basic\b)("[^"]*"|'[^']*'|[^\s"',;)}]+)/g;
const JSON_PAIR_RE = /(["'])([A-Za-z_][\w.-]*)\1\s*:\s*(["'])((?:(?!\3).)*)\3/g;

function unquote(v: string): string {
  return /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v;
}

/**
 * Redacts secrets in an arbitrary string (command lines, error messages, CLI output).
 * `sink` receives every secret value found, for known-value scrubbing.
 */
export function redactText(text: string, sink?: Sink): string {
  if (!text) return text;
  let out = text;
  out = out.replace(PEM_RE, (m) => {
    sink?.(m);
    return MASK;
  });
  out = out.replace(URL_IN_TEXT_RE, (u) => {
    // trailing punctuation is not part of the URL
    const trail = /[.,;:)\]]+$/.exec(u)?.[0] ?? '';
    return redactUrl(trail ? u.slice(0, -trail.length) : u, sink) + trail;
  });
  out = out.replace(JWT_RE, (m) => {
    sink?.(m);
    return MASK;
  });
  for (const re of PREFIX_RES) {
    out = out.replace(re, (m) => {
      sink?.(m);
      return MASK;
    });
  }
  out = out.replace(BEARER_RE, (m) => {
    const word = m.split(/\s+/)[0] ?? 'Bearer';
    sink?.(m.slice(word.length).trim());
    return `${word} ${MASK}`;
  });
  out = out.replace(USER_FLAG_RE, (m, pre: string, flag: string, sep: string, user: string, pw: string) => {
    if (unquote(pw) === MASK) return m;
    sink?.(unquote(pw));
    return `${pre}${flag}${sep}${user}:${MASK}`;
  });
  out = out.replace(HEADER_RE, (m, pre: string, name: string, sep: string, val: string) => {
    if (!isSecretKey(name) || unquote(val) === MASK) return m;
    sink?.(unquote(val));
    return `${pre}${name}${sep}${MASK}`;
  });
  out = out.replace(FLAG_RE, (m, flag: string, sep: string, val: string) => {
    if (!isSecretKey(flag.replace(/^-+/, ''))) return m;
    if (unquote(val) === MASK) return m;
    sink?.(unquote(val));
    return `${flag}${sep}${MASK}`;
  });
  out = out.replace(ASSIGN_RE, (m, pre: string, name: string, val: string) => {
    if (!isSecretKey(name)) return m;
    if (unquote(val) === MASK) return m;
    sink?.(unquote(val));
    return `${pre}${name}=${MASK}`;
  });
  out = out.replace(JSON_PAIR_RE, (m, q1: string, name: string, q2: string, val: string) => {
    if (!isSecretKey(name) || val === MASK || val === '') return m;
    sink?.(val);
    return `${q1}${name}${q1}: ${q2}${MASK}${q2}`;
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Structured data
// ---------------------------------------------------------------------------------------------

const ENV_ENTRY_RE = /^([A-Za-z_][\w.-]*)=([\s\S]*)$/;

/** Redacts one `NAME=value` environment entry. */
export function redactEnvEntry(entry: string, opts: RedactOptions = {}): string {
  const m = ENV_ENTRY_RE.exec(entry);
  if (!m) return redactText(entry, opts.sink);
  const [, name = '', value = ''] = m;
  if (value === '' || value === MASK) return entry;
  if (opts.redactAllEnv || isSecretKey(name) || looksLikeSecretValue(value)) {
    opts.sink?.(value);
    return `${name}=${MASK}`;
  }
  return `${name}=${redactText(value, opts.sink)}`;
}

/** Redacts an argv/command array: secret-named flags mask their value (inline or next token). */
export function redactArgv(argv: readonly string[], opts: RedactOptions = {}): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    const eq = /^(--?[A-Za-z][\w.-]*)=([\s\S]*)$/.exec(a);
    if (eq) {
      const [, flag = '', val = ''] = eq;
      if (isSecretKey(flag.replace(/^-+/, '')) && val !== MASK && val !== '') {
        opts.sink?.(val);
        out.push(`${flag}=${MASK}`);
      } else out.push(redactText(a, opts.sink));
      continue;
    }
    if (/^(-u|--user|--proxy-user)$/.test(a)) {
      out.push(a);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        const [user, ...rest] = next.split(':');
        if (rest.length > 0) {
          opts.sink?.(rest.join(':'));
          out.push(`${user}:${MASK}`);
        } else out.push(next);
        i++;
      }
      continue;
    }
    if (/^--?[A-Za-z][\w.-]*$/.test(a) && isSecretKey(a.replace(/^-+/, ''))) {
      out.push(a);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        opts.sink?.(next);
        out.push(MASK);
        i++;
      }
      continue;
    }
    if (ENV_ENTRY_RE.test(a)) {
      out.push(redactEnvEntry(a, opts));
      continue;
    }
    if (looksLikeSecretValue(a)) {
      opts.sink?.(a);
      out.push(MASK);
      continue;
    }
    out.push(redactText(a, opts.sink));
  }
  return out;
}

export interface RedactOptions {
  /** Mask every environment value (`QM_REDACT_ALL_ENV`). */
  redactAllEnv?: boolean;
  /** Receives every secret value found (for known-value scrubbing). */
  sink?: Sink;
}

const MAX_DEPTH = 40;

/**
 * Walks any JSON-like value at every depth and returns a redacted deep copy.
 * Strings under secret-named keys are masked; children of secret-named containers are masked
 * wholesale; strings elsewhere get the text rules (URLs, tokens, flags, NAME=value pairs).
 */
export function redactDeep<T>(value: T, opts: RedactOptions = {}): T {
  return walk(value, undefined, false, opts, 0, []) as T;
}

/** Numeric values under these key suffixes are measurements (PrivatePort, MaxRetries), not secrets. */
const NUMERIC_SAFE_KEY_RE = /(port|count|size|length|limit|max|min|timeout|interval|retries|num|age)$/i;

function walk(
  v: unknown,
  key: string | undefined,
  forceMask: boolean,
  opts: RedactOptions,
  depth: number,
  ancestors: readonly string[],
): unknown {
  if (depth > MAX_DEPTH) return MASK;
  const lk = key?.toLowerCase();
  const secretKey = key !== undefined && isSecretKey(key);
  if (typeof v === 'string') {
    if (v === '' || v === MASK) return v;
    const inlineContent = lk === 'content' && ancestors.some((a) => a === 'secrets' || a === 'configs');
    if (forceMask || secretKey || inlineContent) {
      opts.sink?.(v);
      return MASK;
    }
    if (lk && ALL_ENV_KEYS.has(lk) && opts.redactAllEnv) {
      opts.sink?.(v);
      return MASK;
    }
    return redactText(v, opts.sink);
  }
  if (typeof v === 'number') {
    if (forceMask || (secretKey && !NUMERIC_SAFE_KEY_RE.test(key ?? ''))) {
      opts.sink?.(String(v));
      return MASK;
    }
    return v;
  }
  if (v === null || v === undefined || typeof v === 'boolean') return v;
  const isDefinitionMap = lk === 'secrets' || lk === 'configs';
  const childForce = forceMask || (secretKey && !isDefinitionMap);
  const childAncestors = lk ? [...ancestors, lk] : ancestors;
  const envish = lk !== undefined && ENV_KEYS.has(lk);
  if (Array.isArray(v)) {
    if (!childForce && v.every((x) => typeof x === 'string')) {
      const strs = v as string[];
      if (envish) {
        const o = ALL_ENV_KEYS.has(lk ?? '') ? opts : { ...opts, redactAllEnv: false };
        return strs.map((s) => redactEnvEntry(s, o));
      }
      return redactArgv(strs, opts);
    }
    return v.map((x) => walk(x, undefined, childForce, opts, depth + 1, childAncestors));
  }
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (envish && typeof val === 'string' && opts.redactAllEnv && ALL_ENV_KEYS.has(lk ?? '') && val !== '') {
        opts.sink?.(val);
        out[k] = MASK;
      } else if (envish && typeof val === 'string' && !childForce && !isSecretKey(k) && looksLikeSecretValue(val)) {
        opts.sink?.(val);
        out[k] = MASK;
      } else if (isDefinitionMap && val !== null && typeof val === 'object' && !Array.isArray(val)) {
        // entries of top-level `secrets:` / `configs:` are named after the secret; the name is not one
        out[k] = walk(val, undefined, false, opts, depth + 1, childAncestors);
      } else {
        out[k] = walk(val, k, childForce, opts, depth + 1, childAncestors);
      }
    }
    return out;
  }
  return MASK;
}

/** Redacts the values of a labels map (entropy rule applies: labels are free-form). */
export function redactLabels(labels: Record<string, string>, opts: RedactOptions = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (v === '' || v === MASK) out[k] = v;
    else if (isSecretKey(k) || looksLikeSecretValue(v)) {
      opts.sink?.(v);
      out[k] = MASK;
    } else out[k] = redactText(v, opts.sink);
  }
  return out;
}

/** Collects every secret value the redaction rules find in `value` (without keeping the redacted copy). */
export function collectSecretValues(value: unknown, opts: Omit<RedactOptions, 'sink'> = {}): string[] {
  const found = new Set<string>();
  redactDeep(value, { ...opts, sink: (s) => found.add(s) });
  return [...found];
}

// ---------------------------------------------------------------------------------------------
// Known-value scrubbing
// ---------------------------------------------------------------------------------------------

const TRIVIAL = new Set(['true', 'false', 'null', 'none', 'yes', 'info', 'warn', 'error', 'debug', 'trace']);

/**
 * Removes literal secret values (and their URL-encoded / JSON-escaped forms) from free text:
 * captured CLI output, error messages, event attributes, log lines.
 */
export class Scrubber {
  private values = new Set<string>();
  private sorted: string[] = [];

  add(secret: string | undefined | null): void {
    if (!secret) return;
    const forms = new Set<string>([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]);
    let changed = false;
    for (const f of forms) {
      if (f.length < 4 || TRIVIAL.has(f.toLowerCase()) || f === MASK || this.values.has(f)) continue;
      this.values.add(f);
      changed = true;
    }
    if (changed) this.sorted = [...this.values].sort((a, b) => b.length - a.length);
  }

  addAll(secrets: Iterable<string>): void {
    for (const s of secrets) this.add(s);
  }

  get size(): number {
    return this.values.size;
  }

  scrub(text: string): string {
    let out = text;
    for (const s of this.sorted) {
      if (out.includes(s)) out = out.split(s).join(MASK);
    }
    return out;
  }

  /** Scrubs, then applies the text rules. Use for anything free-form. */
  clean(text: string): string {
    return redactText(this.scrub(text));
  }
}

/** Process-wide scrubber fed by every loaded container / project / channel. Used by logging and errors. */
export const globalScrubber = new Scrubber();
