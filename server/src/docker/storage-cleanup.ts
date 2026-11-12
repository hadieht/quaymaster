import { randomUUID } from 'node:crypto';
import type Dockerode from 'dockerode';
import type {
  ErrorCode,
  ResourceRemoveResult,
  StorageCandidate,
  StorageCleanupCategory,
  StorageCleanupPreview,
  StorageCleanupRequest,
  StorageCleanupResult,
  StorageKind,
  StorageProtected,
} from '@quaymaster/shared';
import type { AuditService } from '../audit/audit.js';
import { LABEL, isSafeRef } from './model.js';
import type { Guard } from '../security/guard.js';
import { withPermit } from '../security/guard.js';
import { AppError, badRequest, notFound } from '../util/errors.js';
import type { Actor } from './containers.js';
import { mapDockerError } from './containers.js';
import { measureReclaim, type DiskUsageService } from './system.js';

export const STORAGE_CATEGORIES: StorageCleanupCategory[] = [
  'unused_networks',
  'anonymous_volumes',
  'named_volumes',
];

const PREVIEW_TTL_MS = 10 * 60_000;
const ANON_RE = /^[0-9a-f]{64}$/;
/** Networks the daemon creates itself; never removable. */
const PREDEFINED_NETWORKS = new Set(['bridge', 'host', 'none', 'ingress', 'docker_gwbridge']);

/** What Quaymaster knows about the Compose projects that still exist on disk. */
export interface ComposeOwnership {
  /** False when discovery failed: every Compose-labelled resource is then protected (fail closed). */
  ok: boolean;
  /** Projects discovered on disk (any capability level). */
  projects: Set<string>;
  /** Volume / network names declared by the resolved config of discovered projects -> project. */
  volumes: Map<string, string>;
  networks: Map<string, string>;
}

interface Refusal {
  code: ErrorCode;
  reason: string;
  /** Compose-project refusals can be overridden by an explicit opt-in (volumes only). */
  composeOptIn?: boolean;
}

interface VolumeInfo {
  Name: string;
  Driver?: string;
  CreatedAt?: string;
  Labels?: Record<string, string> | null;
  Mountpoint?: string;
}

interface NetworkInfo {
  Id: string;
  Name: string;
  Driver?: string;
  Created?: string;
  Labels?: Record<string, string> | null;
  Containers?: Record<string, unknown> | null;
  Ingress?: boolean;
}

interface StoredPreview {
  preview: StorageCleanupPreview;
  actor: string;
}

const hoursSince = (iso: string | null | undefined, now: number): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) || t <= 0 || iso.startsWith('0001') ? null : Math.round((now - t) / 3_600_000);
};

/**
 * Removal of unused volumes and networks (docs/ARCHITECTURE.md 7.6, DECISIONS: storage cleanup).
 *
 * Volume removal is permanent data loss, so the rules are the strictest in the product:
 *  - a volume that any container references (running OR stopped) is never removed;
 *  - Quaymaster's own volumes, QM_MANAGED_SCOPE, read-only mode and the Compose project check are
 *    enforced here, server-side, whatever the UI sends;
 *  - bulk removal executes only candidates of a stored, unexpired preview created by the same admin and
 *    re-inspects every one right before removing it (a volume recreated under the same name is skipped);
 *  - the Engine call itself needs a narrow permit and is never forced (Docker also refuses an in-use volume).
 * Containers are never touched.
 */
export class StorageCleanupService {
  private readonly previews = new Map<string, StoredPreview>();

  constructor(
    private readonly d: {
      docker: Dockerode;
      guard: Guard;
      audit: AuditService;
      usage: Pick<DiskUsageService, 'measure'>;
      freeBytes: () => Promise<number | null>;
      composeOwnership: () => Promise<ComposeOwnership>;
      minAgeMs: number;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private roRefusal(): AppError | null {
    const ro = this.d.guard.readOnlyReason;
    return ro ? new AppError(409, 'read_only', `Read-only mode: ${ro}`) : null;
  }

  // ---- eligibility (pure, shared by preview, execute and single removal) ----------------------

  /** Why this volume must not be removed right now (null = eligible). `users` = containers referencing it. */
  volumeRefusal(
    v: VolumeInfo,
    users: string[],
    own: ComposeOwnership,
    includeCompose: boolean,
  ): Refusal | null {
    const g = this.d.guard;
    const labels = v.Labels ?? {};
    const project = labels[LABEL.project] ?? null;
    const self = g.volumeProtectedReason(v.Name);
    if (self) return { code: 'self_protected', reason: `Refused: volume ${v.Name} is ${self}` };
    if (!g.inScope(v.Name) || (project !== null && !g.inScope(project)))
      return {
        code: 'out_of_scope',
        reason: `Refused: volume "${v.Name}"${project ? ` (project "${project}")` : ''} is outside QM_MANAGED_SCOPE`,
      };
    if (users.length > 0)
      return {
        code: 'conflict',
        reason: `in use by ${users.length === 1 ? 'container' : 'containers'} ${users.join(', ')} (a stopped container counts)`,
      };
    const declaredBy = own.volumes.get(v.Name) ?? null;
    if (project !== null || declaredBy !== null) {
      const proj = project ?? declaredBy;
      if (!own.ok)
        return {
          code: 'conflict',
          reason: 'Compose projects could not be discovered, so Compose volumes are kept',
        };
      if (!includeCompose) {
        if ((project !== null && own.projects.has(project)) || declaredBy !== null)
          return {
            code: 'conflict',
            reason: `belongs to Compose project "${proj}", which still exists on disk (opt in explicitly to remove it)`,
            composeOptIn: true,
          };
        // Red-team RT3-01: "not discovered" is NOT "deleted from disk". After `docker compose down` a project has
        // no containers, and if its directory is outside QM_STACK_PATHS (or the compose CLI is missing, or the
        // project is outside QM_VISIBLE_SCOPE) Quaymaster cannot see it. Its volume is then most likely a stopped
        // stack's database, so the same explicit opt-in is required.
        return {
          code: 'conflict',
          reason: `belongs to Compose project "${proj}", which Quaymaster cannot find (no containers, not under QM_STACK_PATHS); it may still exist on disk (opt in explicitly to remove it)`,
          composeOptIn: true,
        };
      }
    }
    return null;
  }

  networkRefusal(n: NetworkInfo, users: string[], own: ComposeOwnership): Refusal | null {
    const g = this.d.guard;
    const labels = n.Labels ?? {};
    const project = labels[LABEL.project] ?? null;
    if (PREDEFINED_NETWORKS.has(n.Name) || n.Ingress === true)
      return { code: 'conflict', reason: 'predefined Docker network' };
    const self = g.networkProtectedReason(n.Name);
    if (self) return { code: 'self_protected', reason: `Refused: network ${n.Name} is ${self}` };
    if (!g.inScope(n.Name) || (project !== null && !g.inScope(project)))
      return {
        code: 'out_of_scope',
        reason: `Refused: network "${n.Name}"${project ? ` (project "${project}")` : ''} is outside QM_MANAGED_SCOPE`,
      };
    const attached = Object.keys(n.Containers ?? {});
    if (attached.length > 0 || users.length > 0)
      return {
        code: 'conflict',
        reason: `containers are attached: ${(users.length ? users : attached.map((a) => a.slice(0, 12))).join(', ')}`,
      };
    const declaredBy = own.networks.get(n.Name) ?? null;
    if (!own.ok && (project !== null || declaredBy !== null))
      return {
        code: 'conflict',
        reason: 'Compose projects could not be discovered, so Compose networks are kept',
      };
    if (declaredBy !== null || (project !== null && own.projects.has(project)))
      return {
        code: 'conflict',
        reason: `defined by Compose project "${declaredBy ?? project}", which still exists on disk`,
      };
    return null;
  }

  private containerName(c: Dockerode.ContainerInfo): string {
    return (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, '');
  }

  /**
   * QM_VISIBLE_SCOPE (same rule as the Volumes & Networks inventory): a resource outside it does not exist for
   * the UI/API, so it is neither listed by a preview (not even as "protected") nor removable (red-team RT3-02).
   */
  private visibleResource(name: string, labels: Record<string, string> | null | undefined): boolean {
    const g = this.d.guard;
    if (!g.visibilityRestricted) return true;
    const project = (labels ?? {})[LABEL.project];
    return g.visible(name) || (project !== undefined && g.visible(project));
  }

  /**
   * Containers (any state, deliberately NOT filtered by QM_VISIBLE_SCOPE) that reference the volume.
   * Matches on the container's mounts; the daemon-side `volume` filter is not used so nothing depends on it.
   */
  private async volumeUsers(name: string): Promise<string[]> {
    const list = await this.d.docker.listContainers({ all: true });
    return list
      .filter((c) => (c.Mounts ?? []).some((m) => m.Name === name))
      .map((c) => this.containerName(c));
  }

  /**
   * Containers (any state) that are attached to, or configured for, the network. A stopped container has
   * no live endpoint and an empty NetworkID, so it is matched by network name / ID in its settings and
   * in its HostConfig.NetworkMode (the daemon-side `network` filter misses these).
   */
  private async networkUsers(n: NetworkInfo): Promise<string[]> {
    const list = await this.d.docker.listContainers({ all: true });
    return list.filter((c) => usesNetwork(c, n.Id, n.Name)).map((c) => this.containerName(c));
  }

  private lastKnownUser(labels: Record<string, string>): string | null {
    const p = labels[LABEL.project];
    const vol = labels['com.docker.compose.volume'];
    if (p) return `Compose project ${p}${vol ? ` (volume "${vol}")` : ''}`;
    return null;
  }

  // ---- preview -------------------------------------------------------------------------------

  async preview(req: StorageCleanupRequest, actor: Actor): Promise<StorageCleanupPreview> {
    const categories = [...new Set(req.categories)];
    if (categories.length === 0) throw badRequest('Choose at least one category');
    for (const c of categories)
      if (!STORAGE_CATEGORIES.includes(c)) throw badRequest(`Unknown category "${c}"`);
    const includeCompose = req.includeComposeProjectVolumes === true;
    const minAgeMs =
      req.minAgeHours !== undefined ? Math.max(req.minAgeHours, 0) * 3_600_000 : this.d.minAgeMs;
    const now = this.now();
    const wantVolumes = categories.includes('anonymous_volumes') || categories.includes('named_volumes');
    const wantNetworks = categories.includes('unused_networks');

    const own = await this.d.composeOwnership();
    const candidates: StorageCandidate[] = [];
    const prot: StorageProtected[] = [];
    const mkMinAge = (name: string, kind: StorageKind, age: number | null): boolean => {
      if (age !== null && age * 3_600_000 < minAgeMs) {
        prot.push({
          name,
          kind,
          reason: `younger than the minimum age (${Math.round(minAgeMs / 3_600_000)} h)`,
        });
        return true;
      }
      return false;
    };

    if (wantVolumes) {
      const [vols, containers, sizes] = await Promise.all([
        this.d.docker.listVolumes().catch((e: unknown) => {
          throw mapDockerError(e);
        }),
        this.d.docker.listContainers({ all: true }),
        this.d.usage.measure().catch(() => null),
      ]);
      const users = new Map<string, string[]>();
      for (const c of containers)
        for (const m of c.Mounts ?? [])
          if (m.Name) users.set(m.Name, [...(users.get(m.Name) ?? []), this.containerName(c)]);
      for (const v of (vols.Volumes ?? []) as VolumeInfo[]) {
        if (!this.visibleResource(v.Name, v.Labels)) continue; // RT3-02: QM_VISIBLE_SCOPE
        const anonymous = ANON_RE.test(v.Name) && !(v.Labels ?? {})[LABEL.project];
        const category: StorageCleanupCategory = anonymous ? 'anonymous_volumes' : 'named_volumes';
        if (!categories.includes(category)) continue;
        const refusal = this.volumeRefusal(v, users.get(v.Name) ?? [], own, includeCompose);
        if (refusal) {
          prot.push({ name: v.Name, kind: 'volume', reason: refusal.reason });
          continue;
        }
        const age = hoursSince(v.CreatedAt, now);
        if (mkMinAge(v.Name, 'volume', age)) continue;
        const labels = (v.Labels ?? {}) as Record<string, string>;
        candidates.push({
          id: `volume:${v.Name}`,
          kind: 'volume',
          category,
          name: v.Name,
          size: sizes ? (sizes.volumes[v.Name] ?? null) : null,
          createdAt: v.CreatedAt ?? null,
          ageHours: age,
          anonymous,
          composeProject: labels[LABEL.project] ?? null,
          lastKnownUser: this.lastKnownUser(labels),
          note: anonymous
            ? 'anonymous volume (unnamed hash) that no container references'
            : 'named volume that no container references; its data is deleted permanently',
        });
      }
    }

    if (wantNetworks) {
      const [nets, containers] = await Promise.all([
        this.d.docker.listNetworks().catch((e: unknown) => {
          throw mapDockerError(e);
        }),
        this.d.docker.listContainers({ all: true }),
      ]);
      for (const n of nets as unknown as NetworkInfo[]) {
        if (!this.visibleResource(n.Name, n.Labels)) continue; // RT3-02: QM_VISIBLE_SCOPE
        const used = containers.filter((c) => usesNetwork(c, n.Id, n.Name)).map((c) => this.containerName(c));
        const refusal = this.networkRefusal(n, used, own);
        if (refusal) {
          // the daemon's own networks are not worth listing as "protected"
          if (!PREDEFINED_NETWORKS.has(n.Name))
            prot.push({ name: n.Name, kind: 'network', reason: refusal.reason });
          continue;
        }
        const age = hoursSince(n.Created, now);
        if (mkMinAge(n.Name, 'network', age)) continue;
        const labels = (n.Labels ?? {}) as Record<string, string>;
        candidates.push({
          id: `network:${n.Id}`,
          kind: 'network',
          category: 'unused_networks',
          name: n.Name,
          size: 0,
          createdAt: n.Created ?? null,
          ageHours: age,
          anonymous: false,
          composeProject: labels[LABEL.project] ?? null,
          lastKnownUser: labels[LABEL.project] ? `Compose project ${labels[LABEL.project]}` : null,
          note: 'network with no attached containers (networks free no disk space)',
        });
      }
    }

    const volCount = candidates.filter((c) => c.kind === 'volume').length;
    const preview: StorageCleanupPreview = {
      previewId: randomUUID(),
      expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
      categories,
      includeComposeProjectVolumes: includeCompose,
      minAgeHours: Math.round(minAgeMs / 3_600_000),
      candidates,
      protected: prot,
      estimatedBytes: candidates.reduce((s, c) => s + (c.size ?? 0), 0),
      confirmPhrase: volCount > 0 ? `delete ${volCount} ${volCount === 1 ? 'volume' : 'volumes'}` : null,
      deletesData: volCount > 0,
    };
    for (const [id, p] of this.previews) if (Date.parse(p.preview.expiresAt) < now) this.previews.delete(id);
    this.previews.set(preview.previewId, { preview, actor: actor.name });
    this.d.audit.record({
      actor: actor.name,
      ip: actor.ip,
      action: 'storage.cleanup.preview',
      target: categories.join(','),
      params: { candidates: candidates.length, protected: prot.length, includeCompose },
      outcome: 'success',
    });
    return preview;
  }

  // ---- bulk execute --------------------------------------------------------------------------

  async execute(previewId: string, confirm: string, actor: Actor): Promise<StorageCleanupResult> {
    const base = { actor: actor.name, ip: actor.ip, action: 'storage.cleanup.execute', target: previewId };
    const fail = (e: AppError): never => {
      this.d.audit.record({ ...base, params: { error: e.message }, outcome: 'denied' });
      throw e;
    };
    const ro = this.roRefusal();
    if (ro) return fail(ro);
    const stored = this.previews.get(previewId);
    if (!stored || Date.parse(stored.preview.expiresAt) < this.now())
      return fail(
        new AppError(
          409,
          'conflict',
          'No valid preview: run a storage cleanup preview first (previews expire after 10 minutes)',
        ),
      );
    if (stored.actor !== actor.name)
      return fail(new AppError(403, 'forbidden', 'That preview belongs to another user'));
    const expected = stored.preview.confirmPhrase ?? previewId;
    if (confirm !== expected)
      return fail(
        new AppError(
          409,
          'confirmation_required',
          stored.preview.confirmPhrase
            ? `This permanently deletes data. Type "${expected}" to confirm`
            : `Confirm by sending {"confirm":"${expected}"}`,
          { expected },
        ),
      );
    this.previews.delete(previewId);
    const p = stored.preview;
    const t0 = this.now();

    const { value, reclaim } = await measureReclaim(this.d.usage, this.d.freeBytes, async (before) => {
      const removed: StorageCleanupResult['removed'] = [];
      const skipped: StorageCleanupResult['skipped'] = [];
      let estimated = 0;
      let max = 0;
      const own = await this.d.composeOwnership();
      for (const c of p.candidates) {
        const ref = c.id.slice(c.id.indexOf(':') + 1);
        const item = { ip: actor.ip, actor: actor.name, target: c.name };
        try {
          if (c.kind === 'volume') {
            const info = await this.inspectVolume(ref);
            if (!info) throw new Skip('already gone', 'success');
            if (c.createdAt !== null && info.CreatedAt !== c.createdAt)
              throw new Skip('was recreated since the preview', 'denied');
            const anonNow = ANON_RE.test(info.Name) && !(info.Labels ?? {})[LABEL.project];
            if (anonNow !== c.anonymous) throw new Skip('changed kind since the preview', 'denied');
            const r = this.volumeRefusal(
              info,
              await this.volumeUsers(ref),
              own,
              p.includeComposeProjectVolumes,
            );
            if (r) throw new Skip(r.reason, 'denied');
            await this.engineRemoveVolume(ref);
          } else {
            const info = await this.inspectNetwork(ref);
            if (!info) throw new Skip('already gone', 'success');
            if (info.Id !== ref) throw new Skip('changed since the preview', 'denied');
            const r = this.networkRefusal(info, await this.networkUsers(info), own);
            if (r) throw new Skip(r.reason, 'denied');
            await this.engineRemoveNetwork(info.Id);
          }
          removed.push({ id: c.id, name: c.name, kind: c.kind, bytes: c.size ?? 0 });
          estimated += c.size ?? 0;
          if (c.kind === 'volume') max += before?.volumes[c.name] ?? c.size ?? 0;
          this.d.audit.record({
            ...item,
            action: `${c.kind}.remove`,
            params: { via: 'storage-cleanup', previewId, bytes: c.size ?? 0, category: c.category },
            outcome: 'success',
          });
        } catch (e) {
          const reason = e instanceof Skip ? e.message : (mapDockerError(e).message ?? 'failed');
          skipped.push({ id: c.id, name: c.name, reason });
          this.d.audit.record({
            ...item,
            action: `${c.kind}.remove`,
            params: { via: 'storage-cleanup', previewId, reason },
            outcome: e instanceof Skip ? e.outcome : 'failure',
          });
        }
      }
      return { value: { removed, skipped }, estimatedBytes: estimated, maxBytes: max };
    });
    this.d.audit.record({
      ...base,
      params: {
        removed: value.removed.length,
        skipped: value.skipped.length,
        reclaimedBytes: reclaim.reclaimedBytes,
      },
      outcome: 'success',
      durationMs: this.now() - t0,
    });
    return { ...value, reclaim };
  }

  // ---- single removal ------------------------------------------------------------------------

  async removeVolume(
    name: string,
    opts: { confirm: string; acknowledgeComposeProject?: boolean },
    actor: Actor,
  ): Promise<ResourceRemoveResult> {
    const base = { actor: actor.name, ip: actor.ip, action: 'volume.remove', target: name };
    const fail = (e: AppError): never => {
      this.d.audit.record({ ...base, params: { via: 'single', error: e.message }, outcome: 'denied' });
      throw e;
    };
    if (!isSafeRef(name, 'volume')) throw badRequest('Invalid volume name');
    const ro = this.roRefusal();
    if (ro) return fail(ro);
    if (opts.confirm !== name)
      return fail(
        new AppError(
          409,
          'confirmation_required',
          `This permanently deletes the volume's data. Type the exact volume name to confirm`,
          { expected: name },
        ),
      );
    const info = await this.inspectVolume(name);
    if (!info || !this.visibleResource(info.Name, info.Labels)) throw notFound('Volume');
    const own = await this.d.composeOwnership();
    const r = this.volumeRefusal(
      info,
      await this.volumeUsers(name),
      own,
      opts.acknowledgeComposeProject === true,
    );
    if (r)
      return fail(
        new AppError(
          409,
          r.code,
          r.code === 'conflict' ? `Refused: volume ${name} is ${r.reason}` : r.reason,
          {
            requires: r.composeOptIn ? 'acknowledgeComposeProject' : undefined,
          },
        ),
      );
    const t0 = this.now();
    try {
      const { reclaim } = await measureReclaim(this.d.usage, this.d.freeBytes, async (before) => {
        await this.engineRemoveVolume(name);
        return {
          value: null,
          estimatedBytes: before?.volumes[name] ?? 0,
          maxBytes: before?.volumes[name],
        };
      });
      this.d.audit.record({
        ...base,
        params: { via: 'single', bytes: reclaim.reclaimedBytes, estimatedBytes: reclaim.estimatedBytes },
        outcome: 'success',
        durationMs: this.now() - t0,
      });
      return { kind: 'volume', name, action: 'deleted', removedTags: [], remainingTags: [], reclaim };
    } catch (e) {
      this.d.audit.record({
        ...base,
        params: { via: 'single', error: (e as Error).message },
        outcome: 'failure',
      });
      throw mapDockerError(e);
    }
  }

  async removeNetwork(ref: string, opts: { confirm: string }, actor: Actor): Promise<ResourceRemoveResult> {
    const base = { actor: actor.name, ip: actor.ip, action: 'network.remove', target: ref };
    const fail = (e: AppError): never => {
      this.d.audit.record({ ...base, params: { via: 'single', error: e.message }, outcome: 'denied' });
      throw e;
    };
    if (!isSafeRef(ref, 'network')) throw badRequest('Invalid network reference');
    const ro = this.roRefusal();
    if (ro) return fail(ro);
    const info = await this.inspectNetwork(ref);
    if (!info || !this.visibleResource(info.Name, info.Labels)) throw notFound('Network');
    if (opts.confirm !== info.Name)
      return fail(
        new AppError(409, 'confirmation_required', `Confirm by sending {"confirm":"${info.Name}"}`, {
          expected: info.Name,
        }),
      );
    const own = await this.d.composeOwnership();
    const r = this.networkRefusal(info, await this.networkUsers(info), own);
    if (r)
      return fail(
        new AppError(
          409,
          r.code,
          r.code === 'conflict' ? `Refused: network ${info.Name}: ${r.reason}` : r.reason,
        ),
      );
    const t0 = this.now();
    try {
      const { reclaim } = await measureReclaim(this.d.usage, this.d.freeBytes, async () => {
        await this.engineRemoveNetwork(info.Id);
        return { value: null, estimatedBytes: 0 };
      });
      this.d.audit.record({
        ...base,
        target: info.Name,
        params: { via: 'single', id: info.Id, bytes: 0 },
        outcome: 'success',
        durationMs: this.now() - t0,
      });
      return {
        kind: 'network',
        name: info.Name,
        action: 'deleted',
        removedTags: [],
        remainingTags: [],
        reclaim: { ...reclaim, reclaimedBytes: 0, basis: 'estimate', note: 'Networks use no disk space.' },
      };
    } catch (e) {
      this.d.audit.record({
        ...base,
        params: { via: 'single', error: (e as Error).message },
        outcome: 'failure',
      });
      throw mapDockerError(e);
    }
  }

  // ---- engine access (the only mutating calls) ------------------------------------------------

  private async inspectVolume(name: string): Promise<VolumeInfo | null> {
    try {
      return (await this.d.docker.getVolume(name).inspect()) as unknown as VolumeInfo;
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null;
      throw mapDockerError(e);
    }
  }

  private async inspectNetwork(ref: string): Promise<NetworkInfo | null> {
    try {
      return (await this.d.docker.getNetwork(ref).inspect()) as unknown as NetworkInfo;
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null;
      throw mapDockerError(e);
    }
  }

  private async engineRemoveVolume(name: string): Promise<void> {
    await withPermit({ kind: 'volume_remove', name }, () =>
      this.d.docker.getVolume(name).remove({ force: false }),
    );
  }

  private async engineRemoveNetwork(id: string): Promise<void> {
    await withPermit({ kind: 'network_remove', id }, () => this.d.docker.getNetwork(id).remove());
  }
}

function usesNetwork(c: Dockerode.ContainerInfo, id: string, name: string): boolean {
  const mode = (c as { HostConfig?: { NetworkMode?: string } }).HostConfig?.NetworkMode;
  if (mode === name || mode === id) return true;
  return Object.entries(c.NetworkSettings?.Networks ?? {}).some(
    ([k, v]) => k === name || (!!v.NetworkID && v.NetworkID === id),
  );
}

class Skip extends Error {
  constructor(
    message: string,
    readonly outcome: 'denied' | 'success',
  ) {
    super(message);
  }
}
