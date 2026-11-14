import path from 'node:path';

/**
 * Validation of paths that arrive in Compose LABELS. Labels are data any container creator can write, so nothing
 * here grants trust: it only decides whether a label value is even a candidate for being looked at.
 * (Trust comes from the administrator-controlled allow-list in `PathPolicy`, or from the read-only helper's
 * own narrow rules.)
 */

/** Directories that are never read through a label, whatever the label says. */
const DENIED_PREFIXES = ['/proc', '/sys', '/dev'];

export type LabelPathCheck = { ok: true; dir: string } | { ok: false; reason: string };

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * A working directory taken from a label: absolute, canonical (already what `path.posix.normalize` would
 * produce), no `..`, no NUL/control characters, not the filesystem root, not a pseudo-filesystem.
 */
export function validateLabelDir(p: unknown): LabelPathCheck {
  if (typeof p !== 'string' || p.length === 0)
    return { ok: false, reason: 'the working directory label is empty' };
  if (p.length > 4096) return { ok: false, reason: 'the working directory label is too long' };
  if (CONTROL_RE.test(p)) return { ok: false, reason: 'the working directory contains control characters' };
  if (!p.startsWith('/')) return { ok: false, reason: `"${p}" is not an absolute path` };
  if (p === '/') return { ok: false, reason: 'the filesystem root is not a project directory' };
  if (p.split('/').includes('..')) return { ok: false, reason: `"${p}" contains ".."` };
  if (path.posix.normalize(p) !== p || p.endsWith('/'))
    return { ok: false, reason: `"${p}" is not a canonical path` };
  if (DENIED_PREFIXES.some((d) => p === d || p.startsWith(`${d}/`)))
    return { ok: false, reason: `${p} is a system directory` };
  return { ok: true, dir: p };
}

/**
 * Host locations the read-only helper never bind-mounts, whatever a label says (RT4-01). A label is attacker
 * data: a plain `docker run <image>` inherits every LABEL of the image, so whoever publishes an image can point
 * `com.docker.compose.project.working_dir` anywhere. These prefixes cover system configuration, credentials and
 * runtime state; `HELPER_DENIED_EXACT` are top-level directories that are never a project themselves.
 */
const HELPER_DENIED_PREFIXES = [
  '/etc',
  '/boot',
  '/run',
  '/var/run',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/var/lib',
  '/var/log',
  '/var/spool',
  '/var/cache',
  '/var/tmp',
  '/var/mail',
  '/tmp',
  '/snap',
  '/lost+found',
];
const HELPER_DENIED_EXACT = ['/root', '/home', '/var', '/srv', '/opt', '/mnt', '/media', '/data'];

const under = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

/**
 * Whether the read-only helper may bind-mount `p` (already passed `validateLabelDir`). `extraDenied` are
 * deployment-specific locations (the Docker data root, Quaymaster's own data directory on the host).
 * Hidden path segments (`.ssh`, `.config`, `.kube`, `.docker`, ...) are refused: they hold credentials, not stacks.
 */
export function helperDirAllowed(p: string, extraDenied: readonly string[] = []): LabelPathCheck {
  const v = validateLabelDir(p);
  if (!v.ok) return v;
  if (HELPER_DENIED_EXACT.includes(p)) return { ok: false, reason: `${p} is not a project directory` };
  if (HELPER_DENIED_PREFIXES.some((d) => under(p, d)))
    return { ok: false, reason: `${p} is a system directory; it is never read through a label` };
  if (p.split('/').some((s) => s.startsWith('.')))
    return { ok: false, reason: `${p} contains a hidden directory; it is never read through a label` };
  for (const d of extraDenied) {
    if (d && path.isAbsolute(d) && (under(p, d) || under(d, p)))
      return { ok: false, reason: `${p} overlaps ${d}, which is never read through a label` };
  }
  return v;
}

/** `compose.yaml`, `compose.prod.yml`, `docker-compose.override.yaml`, ... */
export const COMPOSE_FILE_RE = /^(?:docker-)?compose(?:[._-][A-Za-z0-9._-]*)?\.ya?ml$/;
/** `.env`, `.env.production`, ... */
export const ENV_FILE_RE = /^\.env(?:[._-][A-Za-z0-9._-]*)?$/;
/** One path segment of an explicitly named config file. */
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_. @+=-]{0,254}$/;

export const isComposeFileName = (name: string): boolean => COMPOSE_FILE_RE.test(name);
export const isEnvFileName = (name: string): boolean => ENV_FILE_RE.test(name);

/** Splits `com.docker.compose.project.config_files` (comma separated). */
export function parseConfigFilesLabel(raw: string | undefined | null): string[] {
  return (raw ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
}

export interface FilesUnderDir {
  /** Paths relative to the directory, safe to hand to the read-only helper. */
  rel: string[];
  /** Label entries that were dropped, with the reason. */
  rejected: { file: string; reason: string }[];
}

/**
 * From the labelled config files, keeps only those that live strictly inside `dir` and whose FILE NAME is
 * compose-like (`compose*.yml`, `docker-compose*.yaml`, ...). Everything else is rejected (RT4-01): a label can
 * name any `*.yaml` (a cluster credential, a netplan file), so "explicitly listed" is not a reason to read it.
 * Projects started with `-f stack.yml` keep working through a mount / QM_STACK_PATHS; only the helper refuses them.
 */
export function filesUnderDir(dir: string, files: string[]): FilesUnderDir {
  const rel: string[] = [];
  const rejected: FilesUnderDir['rejected'] = [];
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  for (const f of files) {
    if (
      !f.startsWith('/') ||
      CONTROL_RE.test(f) ||
      f.split('/').includes('..') ||
      path.posix.normalize(f) !== f
    ) {
      rejected.push({ file: f, reason: 'not an absolute, canonical path' });
      continue;
    }
    if (!f.startsWith(prefix)) {
      rejected.push({ file: f, reason: 'outside the project directory' });
      continue;
    }
    const r = f.slice(prefix.length);
    const segs = r.split('/');
    if (segs.some((s) => !SEGMENT_RE.test(s))) {
      rejected.push({ file: f, reason: 'unusual characters in the file name' });
      continue;
    }
    const base = segs[segs.length - 1] ?? '';
    if (!isComposeFileName(base)) {
      rejected.push({ file: f, reason: 'not a compose file name (compose*.yml / docker-compose*.yml)' });
      continue;
    }
    rel.push(r);
  }
  return { rel, rejected };
}

/** What `docker compose` itself looks for when a project has no recorded config files. */
export const DEFAULT_COMPOSE_NAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
];

/** Mount hint for the operator: generic, copy-pasteable. */
export function mountHintFor(dir: string): { path: string; volume: string; stackPaths: string } {
  return { path: dir, volume: `- ${dir}:${dir}`, stackPaths: `QM_STACK_PATHS=${dir}` };
}
