import { createHash } from 'node:crypto';

/** A parsed image reference (docker/distribution reference grammar, simplified). */
export interface ImageRef {
  /** Registry host as written in canonical form: `docker.io`, `ghcr.io`, `127.0.0.1:5055`. */
  registry: string;
  /** Repository path without registry, e.g. `library/nginx`, `qmtest/app`. */
  repo: string;
  tag: string | null;
  digest: string | null;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
export const isDigest = (s: string): boolean => DIGEST_RE.test(s);

const HUB_ALIASES = new Set([
  'docker.io',
  'index.docker.io',
  'registry-1.docker.io',
  'registry.hub.docker.com',
]);

/** Parses `[registry/]repo[:tag][@sha256:digest]`. Returns null for references that are not valid. */
export function parseImageRef(input: string): ImageRef | null {
  let rest = input.trim();
  if (!rest || rest.length > 400 || /\s/.test(rest)) return null;
  let digest: string | null = null;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!isDigest(digest)) return null;
  }
  let tag: string | null = null;
  const lastSlash = rest.lastIndexOf('/');
  const colon = rest.lastIndexOf(':');
  if (colon > lastSlash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) return null;
  }
  const parts = rest.split('/');
  let registry = 'docker.io';
  const first = parts[0] ?? '';
  if (parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    registry = first.toLowerCase();
    parts.shift();
  }
  if (HUB_ALIASES.has(registry)) registry = 'docker.io';
  let repo = parts.join('/');
  if (
    !repo ||
    !/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/.test(repo)
  )
    return null;
  if (registry === 'docker.io' && !repo.includes('/')) repo = `library/${repo}`;
  if (!tag && !digest) tag = 'latest';
  return { registry, repo, tag, digest };
}

/** The host a client connects to (Docker Hub's API lives on registry-1.docker.io). */
export function apiHost(ref: Pick<ImageRef, 'registry'>): string {
  return ref.registry === 'docker.io' ? 'registry-1.docker.io' : ref.registry;
}

/** `registry/repo` — the identity used to match RepoDigests of the same repository. */
export function canonicalRepo(ref: Pick<ImageRef, 'registry' | 'repo'>): string {
  return `${ref.registry}/${ref.repo}`;
}

/** Name usable with the Engine API / `docker pull` (Docker Hub library images stay short). */
export function engineName(ref: Pick<ImageRef, 'registry' | 'repo'>): string {
  if (ref.registry === 'docker.io') return ref.repo.startsWith('library/') ? ref.repo.slice(8) : ref.repo;
  return `${ref.registry}/${ref.repo}`;
}

export function formatRef(ref: ImageRef): string {
  return `${engineName(ref)}${ref.tag ? `:${ref.tag}` : ''}${ref.digest ? `@${ref.digest}` : ''}`;
}

/** Canonical cache key for a tag reference. */
export function cacheKey(ref: ImageRef): string {
  return `${canonicalRepo(ref)}:${ref.tag ?? 'latest'}`;
}

/** Digest of `repo@sha256:...` entries from `RepoDigests` that belong to the repository of `ref`. */
export function digestsForRepo(repoDigests: string[], ref: Pick<ImageRef, 'registry' | 'repo'>): string[] {
  const want = canonicalRepo(ref);
  const out: string[] = [];
  for (const rd of repoDigests) {
    const p = parseImageRef(rd);
    if (p?.digest && canonicalRepo(p) === want) out.push(p.digest);
  }
  return out;
}

const shortHash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** `quaymaster-staged/<hash(repo)>:<digest12>` (RT-07): keeps a pulled image from being dangling or moving a tag. */
export function stagedTag(ref: Pick<ImageRef, 'registry' | 'repo'>, digest: string): string {
  return `quaymaster-staged/${shortHash(canonicalRepo(ref))}:${digest.replace(/^sha256:/, '').slice(0, 12)}`;
}

/** `quaymaster-rollback/<hash(project/service)>:<run>` (RT-06): always a valid lower-case repository name. */
export function rollbackTag(project: string, service: string, runId: string): string {
  return `quaymaster-rollback/${shortHash(`${project}/${service}`)}:${runId.toLowerCase().replace(/[^a-z0-9_.-]/g, '')}`;
}

export const isInternalTag = (tag: string): boolean =>
  tag.startsWith('quaymaster-staged/') || tag.startsWith('quaymaster-rollback/');

/** Last path segment of the repository: what QM_MANAGED_SCOPE globs are matched against for images. */
export function repoBaseName(ref: Pick<ImageRef, 'repo'>): string {
  return ref.repo.split('/').pop() ?? ref.repo;
}
