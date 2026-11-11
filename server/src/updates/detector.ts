import type Dockerode from 'dockerode';
import type { ImageUpdateStatus, ImageUser, UpdateState } from '@quaymaster/shared';
import type { ImageChecksRepo, QuarantineRepo, StagedRepo } from '../db/updates.js';
import type { ContainerService } from '../docker/containers.js';
import { LABEL } from '../docker/model.js';
import type { RegistryClient } from '../registry/client.js';
import { RegistryError } from '../registry/client.js';
import {
  cacheKey,
  digestsForRepo,
  formatRef,
  parseImageRef,
  stagedTag,
  type ImageRef,
} from '../registry/reference.js';
import type { Logger } from '../util/logger.js';

export interface RemoteLookup {
  digest: string | null;
  source: 'registry' | 'engine' | 'cache' | 'none';
  error: { kind: string; message: string } | null;
  checkedAt: number;
}

/** Result of comparing one local image with the registry. Pure: unit-testable without Docker. */
export function classify(input: {
  ref: ImageRef | null;
  rawRef: string;
  localRepoDigests: string[];
  remote: RemoteLookup;
  /** Platform manifest digests of the remote index (for images pulled by platform digest). */
  remotePlatformDigests?: string[];
  stagedPresent: boolean;
  imageIsId: boolean;
}): { state: UpdateState; reason: string | null; localDigest: string | null } {
  const { ref } = input;
  if (input.imageIsId)
    return { state: 'unknown', reason: 'the container references an image ID, not a tag', localDigest: null };
  if (!ref)
    return { state: 'unknown', reason: `cannot parse image reference "${input.rawRef}"`, localDigest: null };
  if (ref.digest)
    return {
      state: 'pinned_digest',
      reason: 'the reference is pinned to a digest; there is nothing to update',
      localDigest: ref.digest,
    };
  const local = digestsForRepo(input.localRepoDigests, ref);
  if (local.length === 0 && input.remote.error?.kind === 'not_found')
    return {
      state: 'local_only',
      reason: 'not found in the registry and no registry digest recorded locally (built locally?)',
      localDigest: null,
    };
  if (local.length === 0 && !input.remote.digest && input.remote.error)
    return {
      state: 'local_only',
      reason: `no registry digest recorded locally (built locally or never pulled) — ${input.remote.error.message}`,
      localDigest: null,
    };
  if (input.remote.error || !input.remote.digest) {
    return {
      state: 'unknown',
      reason: input.remote.error?.message ?? 'registry did not answer',
      localDigest: local[0] ?? null,
    };
  }
  if (local.length === 0) {
    return {
      state: 'local_only',
      reason: 'the local image has no digest from this repository (built locally or retagged)',
      localDigest: null,
    };
  }
  const remote = input.remote.digest;
  if (local.includes(remote) || (input.remotePlatformDigests ?? []).some((d) => local.includes(d))) {
    return {
      state: 'up_to_date',
      reason: null,
      localDigest: local.includes(remote) ? remote : (local[0] ?? null),
    };
  }
  return {
    state: input.stagedPresent ? 'update_staged' : 'update_available',
    reason: input.stagedPresent ? 'the new image is pulled and staged; the tag has not moved yet' : null,
    localDigest: local[0] ?? null,
  };
}

interface InUse {
  ref: string;
  imageId: string;
  users: ImageUser[];
}

/**
 * Update detection (spec 7.1). For each image reference in use: the local `RepoDigests` entry of the
 * RUNNING image is compared with the registry's current manifest digest for the tag (HEAD request with
 * token auth, `Accept` for index + manifest types so the digest matches what a pull records).
 * Remote answers are cached; the client throttles, jitters and backs off on 429. If the registry cannot
 * be reached the Engine's `distribution inspect` is the fallback.
 */
export class UpdateService {
  private inflight: Promise<ImageUpdateStatus[]> | null = null;
  private inflightFresh = false;

  constructor(
    private readonly d: {
      docker: Dockerode;
      containers: ContainerService;
      registry: RegistryClient;
      checks: ImageChecksRepo;
      staged: StagedRepo;
      quarantine: QuarantineRepo;
      ttlMs: number;
      log: Logger;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** Image references currently used by containers, with their users. */
  async inUse(): Promise<InUse[]> {
    const containers = await this.d.containers.listRaw(true);
    const byRef = new Map<string, InUse>();
    for (const c of containers) {
      const key = `${c.Image}\u0000${c.ImageID}`;
      const user: ImageUser = {
        containerId: c.Id,
        containerName: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''),
        project: c.Labels?.[LABEL.project] ?? null,
        service: c.Labels?.[LABEL.service] ?? null,
        imageId: c.ImageID,
      };
      const hit = byRef.get(key);
      if (hit) hit.users.push(user);
      else byRef.set(key, { ref: c.Image, imageId: c.ImageID, users: [user] });
    }
    return [...byRef.values()];
  }

  /** Status of every image in use. `fresh` bypasses the cache; concurrent calls share one run. */
  async statuses(opts: { fresh?: boolean } = {}): Promise<ImageUpdateStatus[]> {
    const fresh = opts.fresh === true;
    // concurrent calls share one run; a fresh request never piggybacks on a cached one that started earlier
    // (it could return answers from before a registry change the caller just made)
    while (this.inflight && fresh && !this.inflightFresh) await this.inflight.catch(() => undefined);
    if (this.inflight) return this.inflight;
    this.inflightFresh = fresh;
    const run = (async () => {
      const out: ImageUpdateStatus[] = [];
      for (const u of await this.inUse()) out.push(await this.statusFor(u, fresh));
      return out;
    })().finally(() => {
      if (this.inflight === run) this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  /** Status for the image reference + image ID (e.g. of a Compose service's running container). */
  async statusFor(u: InUse, fresh = false): Promise<ImageUpdateStatus> {
    const ref = parseImageRef(u.ref);
    const imageIsId = /^sha256:[0-9a-f]{64}$/.test(u.ref) || /^[0-9a-f]{12,64}$/.test(u.ref);
    let repoDigests: string[] = [];
    try {
      repoDigests = (await this.d.docker.getImage(u.imageId).inspect()).RepoDigests ?? [];
    } catch {
      /* image vanished: classify() reports it */
    }
    let remote: RemoteLookup = { digest: null, source: 'none', error: null, checkedAt: this.now() };
    let platformDigests: string[] = [];
    const wantRemote = ref && !ref.digest && !imageIsId;
    if (wantRemote) {
      remote = await this.remoteDigest(ref, fresh);
      const local = digestsForRepo(repoDigests, ref);
      if (remote.digest && local.length > 0 && !local.includes(remote.digest)) {
        platformDigests = await this.platformDigests(ref, remote.digest);
      }
    }
    const stagedPresent = !!ref && !!remote.digest && (await this.isStaged(ref, remote.digest));
    const c = classify({
      ref,
      rawRef: u.ref,
      localRepoDigests: repoDigests,
      remote,
      remotePlatformDigests: platformDigests,
      stagedPresent,
      imageIsId,
    });
    const target = ref ? cacheKey(ref) : u.ref;
    return {
      ref: u.ref,
      state: c.state,
      reason: c.reason,
      localDigest: c.localDigest,
      remoteDigest: remote.digest,
      checkedAt: remote.source === 'none' ? null : new Date(remote.checkedAt).toISOString(),
      source: remote.source,
      quarantined:
        c.state !== 'up_to_date' && !!remote.digest && this.d.quarantine.isQuarantined(target, remote.digest),
      usedBy: u.users,
    };
  }

  async isStaged(ref: ImageRef, digest: string): Promise<boolean> {
    const tag = stagedTag(ref, digest);
    if (!this.d.staged.get(tag)) return false;
    try {
      await this.d.docker.getImage(tag).inspect();
      return true;
    } catch {
      this.d.staged.delete(tag);
      return false;
    }
  }

  /** Remote digest of `ref` (cached; registry first, Engine `distribution inspect` as fallback). */
  async remoteDigest(ref: ImageRef, fresh = false): Promise<RemoteLookup> {
    const key = cacheKey(ref);
    const now = this.now();
    if (!fresh) {
      const hit = this.d.checks.get(key);
      if (hit && hit.expires_at > now) {
        return {
          digest: hit.remote_digest,
          source: 'cache',
          error:
            hit.state === 'error' ? { kind: 'cached', message: hit.reason ?? 'earlier lookup failed' } : null,
          checkedAt: hit.checked_at,
        };
      }
    }
    const backedOff = this.d.registry.backedOffUntil(ref);
    if (backedOff && !fresh) {
      const stale = this.d.checks.get(key);
      if (stale?.remote_digest)
        return { digest: stale.remote_digest, source: 'cache', error: null, checkedAt: stale.checked_at };
    }
    let result: RemoteLookup;
    try {
      const head = await this.d.registry.headManifest(ref);
      result = { digest: head.digest, source: 'registry', error: null, checkedAt: now };
    } catch (e) {
      const err = e instanceof RegistryError ? e : new RegistryError('other', (e as Error).message);
      // fallback: ask the Engine (uses the daemon's own credentials)
      const viaEngine = err.kind === 'not_found' ? null : await this.engineDigest(ref);
      result = viaEngine
        ? { digest: viaEngine, source: 'engine', error: null, checkedAt: now }
        : {
            digest: null,
            source: 'registry',
            error: { kind: err.kind, message: err.message },
            checkedAt: now,
          };
    }
    this.d.checks.put({
      ref: key,
      state: result.error ? 'error' : 'ok',
      reason: result.error?.message ?? null,
      local_digest: null,
      remote_digest: result.digest,
      source: result.source,
      checked_at: now,
      // failures are retried sooner than successes
      expires_at: now + (result.error ? Math.min(this.d.ttlMs, 5 * 60_000) : this.d.ttlMs),
    });
    return result;
  }

  private async engineDigest(ref: ImageRef): Promise<string | null> {
    try {
      const name = formatRef({ ...ref, digest: null });
      const raw = await new Promise<{ Descriptor?: { digest?: string } }>((resolve, reject) => {
        (
          this.d.docker.modem as unknown as {
            dial(o: object, cb: (e: unknown, d: { Descriptor?: { digest?: string } }) => void): void;
          }
        ).dial(
          {
            path: `/distribution/${name}/json`,
            method: 'GET',
            statusCodes: { 200: true, 401: 'unauthorized', 403: 'forbidden', 404: 'not found', 500: 'error' },
          },
          (e, d) => (e ? reject(e) : resolve(d)),
        );
      });
      const dg = raw.Descriptor?.digest;
      return dg && /^sha256:[0-9a-f]{64}$/.test(dg) ? dg : null;
    } catch {
      return null;
    }
  }

  /** Per-platform manifest digests behind a remote index (a local image may have been pulled by platform digest). */
  private async platformDigests(ref: ImageRef, indexDigest: string): Promise<string[]> {
    try {
      const doc = await this.d.registry.getManifest(ref, indexDigest);
      return (doc.json.manifests ?? [])
        .filter((m) => !m.platform || (m.platform.os === 'linux' && m.platform.architecture === 'amd64'))
        .map((m) => m.digest);
    } catch {
      return [];
    }
  }
}
