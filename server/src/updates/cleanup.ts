import { randomUUID } from 'node:crypto';
import type Dockerode from 'dockerode';
import type {
  ResourceRemoveResult,
  CleanupCandidate,
  CleanupCategory,
  CleanupPreview,
  CleanupProtected,
  CleanupResult,
} from '@quaymaster/shared';
import type { AuditService } from '../audit/audit.js';
import type { RollbackRepo, StagedRepo } from '../db/updates.js';
import type { Actor, ContainerService } from '../docker/containers.js';
import type { ImageOps } from '../docker/imageops.js';
import { LABEL, isSafeRef } from '../docker/model.js';
import { measureReclaim, type DfMeasure, type DiskUsageService } from '../docker/system.js';
import { cacheKey, isInternalTag, parseImageRef, repoBaseName } from '../registry/reference.js';
import type { Guard } from '../security/guard.js';
import { AppError, badRequest, notFound } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

export const ALL_CATEGORIES: CleanupCategory[] = [
  'dangling_images',
  'unused_images',
  'stopped_containers',
  'expired_rollback',
];

const PREVIEW_TTL_MS = 10 * 60_000;

interface StoredPreview {
  preview: CleanupPreview;
  actor: string;
  /** Needed to repeat the scope check at execute time (an untagged image is in scope only via the filter). */
  labelFilter: string | null;
}

/**
 * Cleanup (spec 7.6 + RT-24). A preview is MANDATORY: removal executes only the candidates of a
 * preview the same admin created in the last 10 minutes, and every candidate is re-verified right
 * before it is removed. Never removed: images used by any container, images referenced by a
 * discovered Compose project, rollback / staged tags within retention, anything younger than the
 * minimum age, anything outside QM_MANAGED_SCOPE, the Quaymaster container itself. Volumes and
 * networks are not handled here (see StorageCleanupService); they are only counted in `reportOnly`.
 */
export class CleanupService {
  private readonly previews = new Map<string, StoredPreview>();

  constructor(
    private readonly d: {
      docker: Dockerode;
      containers: ContainerService;
      images: ImageOps;
      guard: Guard;
      audit: AuditService;
      rollback: RollbackRepo;
      staged: StagedRepo;
      /** Image references (cache keys) named in the Compose files of all discovered projects. */
      projectImageRefs: () => Promise<Set<string>>;
      usage: Pick<DiskUsageService, 'measure'>;
      freeBytes: () => Promise<number | null>;
      minAgeMs: number;
      retentionMs: number;
      log: Logger;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** Why this image is outside the managed scope (null = in scope or no scope configured). */
  private scopeProblem(tags: string[], labelFilter: string | null): string | null {
    if (this.d.guard.scope.length === 0) return null;
    const user = tags.filter((t) => !isInternalTag(t));
    if (user.length === 0) {
      // an untagged image cannot be attributed to a name; only an explicit label filter proves it is ours
      return labelFilter ? null : 'untagged image, and QM_MANAGED_SCOPE is set without a label filter';
    }
    for (const t of user) {
      const p = parseImageRef(t);
      if (!p) return `unparseable tag ${t}`;
      const ok = this.d.guard.inScope(repoBaseName(p)) || this.d.guard.inScope(`${p.registry}/${p.repo}`);
      if (!ok) return `${t} is outside QM_MANAGED_SCOPE`;
    }
    return null;
  }

  async preview(
    req: { categories?: CleanupCategory[]; minAgeHours?: number; labelFilter?: string },
    actor: Actor,
  ): Promise<CleanupPreview> {
    const categories = req.categories?.length ? req.categories : ALL_CATEGORIES;
    for (const c of categories) if (!ALL_CATEGORIES.includes(c)) throw badRequest(`Unknown category "${c}"`);
    const minAgeMs =
      req.minAgeHours !== undefined ? Math.max(req.minAgeHours, 0) * 3_600_000 : this.d.minAgeMs;
    const labelFilter = req.labelFilter ?? null;
    if (labelFilter !== null && !/^[A-Za-z0-9_.-]+(=[A-Za-z0-9_.-]*)?$/.test(labelFilter))
      throw badRequest('labelFilter must be key or key=value');
    const [key, val] = labelFilter ? labelFilter.split('=') : [undefined, undefined];
    const labelOk = (labels: Record<string, string> | null | undefined): boolean =>
      !key || (!!labels && key in labels && (val === undefined || labels[key] === val));

    const now = this.now();
    const candidates: CleanupCandidate[] = [];
    const protectedList: CleanupProtected[] = [];
    const containers = await this.d.containers.listRawAll(true);
    // Red-team RT3-03: "in use" must be computed from EVERY container on the daemon. `listRaw` is filtered by
    // QM_VISIBLE_SCOPE, so an image used only by an invisible (stopped) container looked unused and execute
    // untagged it tag by tag until Docker refused the last one. Visibility only limits what we show/remove.
    const allContainers = await this.d.docker.listContainers({ all: true });
    const usedImageIds = new Set(allContainers.map((c) => c.ImageID));
    const usedByName = new Map<string, string>();
    for (const c of allContainers)
      usedByName.set(c.ImageID, (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''));
    const referenced = await this.d.projectImageRefs();
    const rollbackActive = new Map(this.d.rollback.active().map((r) => [r.tag, r]));
    const rollbackImageIds = new Set(
      this.d.rollback
        .active()
        .filter((r) => r.expires_at > now)
        .map((r) => r.image_id),
    );

    const wantImages = categories.some(
      (c) => c === 'dangling_images' || c === 'unused_images' || c === 'expired_rollback',
    );
    const images = wantImages ? await this.d.docker.listImages({ all: false }) : [];
    const df = wantImages ? await this.d.usage.measure().catch(() => null) : null;
    for (const img of images) {
      const tags = (img.RepoTags ?? []).filter((t) => t !== '<none>:<none>');
      const isDangling = tags.length === 0;
      const name = tags[0] ?? img.Id.replace('sha256:', '').slice(0, 12);
      const category: CleanupCategory = isDangling ? 'dangling_images' : 'unused_images';
      const internal = tags.filter(isInternalTag);
      const user = tags.filter((t) => !isInternalTag(t));
      const protect = (reason: string, cat: CleanupCategory = category): void => {
        protectedList.push({ name, category: cat, reason });
      };

      // expired rollback / staged tags are their own category: only the internal tag is removed
      if (categories.includes('expired_rollback')) {
        for (const t of internal) {
          const rb = rollbackActive.get(t);
          const st = this.d.staged.get(t);
          if (t.startsWith('quaymaster-rollback/') && !rb) {
            protectedList.push({ name: t, category: 'expired_rollback', reason: 'no rollback record; kept' });
            continue;
          }
          const expiresAt = rb ? rb.expires_at : st ? st.created_at + this.d.retentionMs : 0;
          if (expiresAt > now) {
            protectedList.push({
              name: t,
              category: 'expired_rollback',
              reason: `${t.startsWith('quaymaster-rollback/') ? 'rollback point' : 'staged image'} within retention`,
            });
            continue;
          }
          const scopeNote =
            this.d.guard.scope.length > 0 && (rb?.project ? !this.d.guard.inScope(rb.project) : !labelFilter);
          if (scopeNote) {
            protectedList.push({ name: t, category: 'expired_rollback', reason: 'outside QM_MANAGED_SCOPE' });
            continue;
          }
          candidates.push({
            id: `tag:${t}`,
            category: 'expired_rollback',
            name: t,
            size: null,
            ageHours: Math.round((now - (rb ? rb.created_at : (st?.created_at ?? now))) / 3_600_000),
            note: 'expired; only this tag is removed (the image is deleted only when nothing else uses it)',
          });
        }
      }
      if (!categories.includes(category)) continue;
      if (internal.length > 0 && user.length === 0) continue; // handled above, never an "unused image"
      if (usedImageIds.has(img.Id)) {
        protect(`in use by container ${usedByName.get(img.Id) ?? '?'}`);
        continue;
      }
      if (rollbackImageIds.has(img.Id)) {
        protect('protected as a rollback point within retention');
        continue;
      }
      if (
        user.some((t) => {
          const p = parseImageRef(t);
          return referenced.has(t) || (p !== null && referenced.has(cacheKey(p)));
        })
      ) {
        protect('referenced by a discovered Compose project');
        continue;
      }
      if (internal.length > 0) {
        protect('also carries a staged/rollback tag');
        continue;
      }
      const sp = this.scopeProblem(tags, labelFilter);
      if (sp) {
        protect(sp);
        continue;
      }
      let inspect: Dockerode.ImageInspectInfo;
      try {
        inspect = await this.d.docker.getImage(img.Id).inspect();
      } catch {
        continue;
      }
      if (!labelOk(inspect.Config?.Labels)) {
        protect(`does not match label filter ${labelFilter}`);
        continue;
      }
      const tagged = (inspect as unknown as { Metadata?: { LastTagTime?: string } }).Metadata?.LastTagTime;
      const lastTag = tagged && !tagged.startsWith('0001') ? Date.parse(tagged) : 0;
      const refTime = Math.max(Date.parse(inspect.Created) || 0, lastTag);
      if (now - refTime < minAgeMs) {
        protect(`younger than the minimum age (${Math.round(minAgeMs / 3_600_000)} h)`);
        continue;
      }
      candidates.push({
        id: `image:${img.Id}`,
        category,
        name: isDangling ? name : tags.join(', '),
        size: uniqueSize(img.Id, img.Size, df),
        virtualSize: img.Size,
        ageHours: Math.round((now - refTime) / 3_600_000),
        note:
          (isDangling ? 'untagged image' : 'tagged image that no container uses') +
          '; frees its own layers only, shared layers stay until the last image using them goes',
      });
    }

    if (categories.includes('stopped_containers')) {
      for (const c of containers) {
        if (!['exited', 'created', 'dead'].includes(c.State)) continue;
        const name = (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, '');
        const project = c.Labels?.[LABEL.project] ?? null;
        const refusal = this.d.guard.containerRefusal({ id: c.Id, name, project });
        const add = (reason: string): void => {
          protectedList.push({ name, category: 'stopped_containers', reason });
        };
        if (refusal) {
          add(refusal.message);
          continue;
        }
        if (project) {
          add(`part of Compose project "${project}" (use compose down); a stopped project is not garbage`);
          continue;
        }
        if (!labelOk(c.Labels)) {
          add(`does not match label filter ${labelFilter}`);
          continue;
        }
        const age = now - c.Created * 1000;
        if ((name.startsWith('qm-old-') || /-qm-old-\d+$/.test(name)) && age < this.d.retentionMs) {
          add('standalone rollback point within retention');
          continue;
        }
        if (age < minAgeMs) {
          add(`younger than the minimum age (${Math.round(minAgeMs / 3_600_000)} h)`);
          continue;
        }
        candidates.push({
          id: `container:${c.Id}`,
          category: 'stopped_containers',
          name,
          size: null,
          ageHours: Math.round(age / 3_600_000),
          note: 'stopped standalone container (volumes are kept)',
        });
      }
    }

    // only counted here; their removal is StorageCleanupService (docs/DECISIONS.md, "Storage cleanup")
    const [vols, nets] = await Promise.all([this.d.docker.listVolumes(), this.d.docker.listNetworks()]);
    const mounted = new Set(
      allContainers.flatMap((c) => (c.Mounts ?? []).map((m) => m.Name).filter(Boolean)),
    );
    const netUsed = new Set(
      allContainers.flatMap((c) => Object.values(c.NetworkSettings?.Networks ?? {}).map((n) => n.NetworkID)),
    );
    const unusedVolumes = (vols.Volumes ?? [])
      .filter((v) => !mounted.has(v.Name) && this.d.guard.inScope(v.Name))
      .filter((v) => labelOk(v.Labels as Record<string, string> | undefined))
      .map((v) => v.Name);
    const unusedNetworks = nets
      .filter((n) => !['bridge', 'host', 'none'].includes(n.Name) && !netUsed.has(n.Id))
      .filter((n) => this.d.guard.inScope(n.Name))
      .filter((n) => labelOk(n.Labels as Record<string, string> | undefined))
      .map((n) => n.Name);

    const preview: CleanupPreview = {
      previewId: randomUUID(),
      expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
      categories,
      minAgeHours: Math.round(minAgeMs / 3_600_000),
      candidates,
      protected: protectedList,
      reportOnly: { unusedVolumes, unusedNetworks },
      totalBytes: candidates.reduce((s, c) => s + (c.size ?? 0), 0),
    };
    for (const [id, p] of this.previews) if (Date.parse(p.preview.expiresAt) < now) this.previews.delete(id);
    this.previews.set(preview.previewId, { preview, actor: actor.name, labelFilter });
    this.d.audit.record({
      actor: actor.name,
      ip: actor.ip,
      action: 'cleanup.preview',
      target: categories.join(','),
      params: { candidates: candidates.length, protected: protectedList.length, labelFilter },
      outcome: 'success',
    });
    return preview;
  }

  async execute(previewId: string, confirm: string, actor: Actor): Promise<CleanupResult> {
    const stored = this.previews.get(previewId);
    const base = { actor: actor.name, ip: actor.ip, action: 'cleanup.execute', target: previewId };
    const fail = (e: AppError): never => {
      this.d.audit.record({ ...base, params: { error: e.message }, outcome: 'denied' });
      throw e;
    };
    if (!stored || Date.parse(stored.preview.expiresAt) < this.now())
      return fail(
        new AppError(
          409,
          'conflict',
          'No valid preview: run a cleanup preview first (previews expire after 10 minutes)',
        ),
      );
    if (stored.actor !== actor.name)
      return fail(new AppError(403, 'forbidden', 'That preview belongs to another user'));
    if (confirm !== previewId)
      return fail(
        new AppError(409, 'confirmation_required', `Confirm by sending {"confirm":"${previewId}"}`, {
          expected: previewId,
        }),
      );
    const ro = this.d.guard.readOnlyReason;
    if (ro) return fail(new AppError(409, 'read_only', `Read-only mode: ${ro}`));
    this.previews.delete(previewId);

    const removed: CleanupResult['removed'] = [];
    const skipped: CleanupResult['skipped'] = [];
    let reclaimed = 0;
    const t0 = this.now();
    const { reclaim } = await measureReclaim(this.d.usage, this.d.freeBytes, async () => {
      // unfiltered by QM_VISIBLE_SCOPE for the in-use re-check (RT3-03); `containers` stays the visible list
      const containers = await this.d.containers.listRawAll(true);
      const allNow = await this.d.docker.listContainers({ all: true });
      const usedNow = new Set(allNow.map((c) => c.ImageID));
      const referencedNow = await this.d.projectImageRefs();
      const rollbackIdsNow = new Set(
        this.d.rollback
          .active()
          .filter((r) => r.expires_at > this.now())
          .map((r) => r.image_id),
      );
      for (const c of stored.preview.candidates) {
        const kind = c.id.slice(0, c.id.indexOf(':'));
        const ref = c.id.slice(c.id.indexOf(':') + 1);
        try {
          if (kind === 'image') {
            // re-verify right before removal: a container may have started on it since the preview
            if (usedNow.has(ref)) throw new Error('now used by a container');
            const info = await this.d.images.inspect(ref);
            if (!info) throw new Error('already gone');
            const tagsNow = (info.RepoTags ?? []).filter((t) => t !== '<none>:<none>');
            if (tagsNow.some(isInternalTag)) throw new Error('carries a rollback/staged tag');
            // RT3-04: the tags are re-read here and ALL of them are removed, so every rule that depends on the
            // tags is repeated: a tag added since the preview may be outside the scope or named by a project
            const sp = this.scopeProblem(tagsNow, stored.labelFilter);
            if (sp) throw new Error(`now ${sp}`);
            if (rollbackIdsNow.has(ref)) throw new Error('now a rollback point within retention');
            if (
              tagsNow.some((t) => {
                const p = parseImageRef(t);
                return referencedNow.has(t) || (p !== null && referencedNow.has(cacheKey(p)));
              })
            )
              throw new Error('now referenced by a discovered Compose project');
            for (const t of tagsNow) await this.d.images.remove(t);
            if ((await this.d.images.inspect(ref)) !== null) await this.d.images.remove(ref);
          } else if (kind === 'tag') {
            const rb = this.d.rollback.get(ref);
            if (rb && rb.expires_at > this.now()) throw new Error('rollback point is still within retention');
            const st = this.d.staged.get(ref);
            if (st && st.created_at + this.d.retentionMs > this.now())
              throw new Error('staged image is still within retention');
            await this.d.images.remove(ref);
            this.d.rollback.release(ref);
            this.d.staged.delete(ref);
          } else if (kind === 'container') {
            const cont = containers.find((x) => x.Id === ref);
            if (!cont) throw new Error('already gone');
            const name = (cont.Names?.[0] ?? '').replace(/^\//, '');
            if (!['exited', 'created', 'dead'].includes(cont.State)) throw new Error('not stopped anymore');
            await this.d.containers.act(ref, 'remove', { confirm: name }, actor);
          }
          removed.push({ id: c.id, name: c.name });
          reclaimed += c.size ?? 0;
          this.d.audit.record({
            actor: actor.name,
            ip: actor.ip,
            action: kind === 'container' ? 'container.remove' : 'image.remove',
            target: c.name,
            params: { via: 'cleanup', previewId, id: c.id, estimatedBytes: c.size ?? 0 },
            outcome: 'success',
          });
        } catch (e) {
          skipped.push({ id: c.id, name: c.name, reason: (e as Error).message });
          this.d.audit.record({
            actor: actor.name,
            ip: actor.ip,
            action: kind === 'container' ? 'container.remove' : 'image.remove',
            target: c.name,
            params: { via: 'cleanup', previewId, id: c.id, reason: (e as Error).message },
            outcome: 'denied',
          });
        }
      }
      // RT3-06: nothing removed => nothing reclaimed, whatever else changed on the host meanwhile
      return { value: null, estimatedBytes: reclaimed, ...(removed.length === 0 ? { maxBytes: 0 } : {}) };
    });
    this.d.containers.invalidate();
    this.d.audit.record({
      ...base,
      params: { removed: removed.length, skipped: skipped.length },
      outcome: 'success',
      durationMs: this.now() - t0,
    });
    return { removed, skipped, reclaimedBytes: reclaim.reclaimedBytes, reclaim };
  }

  /**
   * Removes one image (or one tag of it) from the image list. Server-side rules, whatever the UI sends:
   * outside QM_MANAGED_SCOPE / read-only => refused; an image any container (running or stopped) uses is
   * never deleted; a rollback / staged image within retention is kept; a tag a Compose project names is
   * kept. With `tag` and other tags remaining only that tag is removed (`untagged`); without `tag` every
   * tag and the image go (`deleted`).
   */
  async removeImage(
    ref: string,
    opts: { confirm: string; tag?: string },
    actor: Actor,
  ): Promise<ResourceRemoveResult> {
    const base = { actor: actor.name, ip: actor.ip, action: 'image.remove', target: ref };
    const fail = (e: AppError): never => {
      this.d.audit.record({
        ...base,
        params: { via: 'single', tag: opts.tag ?? null, error: e.message },
        outcome: 'denied',
      });
      throw e;
    };
    if (!isSafeRef(ref, 'image')) throw badRequest('Invalid image reference');
    if (opts.tag !== undefined && !isSafeRef(opts.tag, 'image')) throw badRequest('Invalid tag');
    const ro = this.d.guard.readOnlyReason;
    if (ro) return fail(new AppError(409, 'read_only', `Read-only mode: ${ro}`));
    const info = await this.d.images.inspect(ref);
    if (!info) throw notFound('Image');
    const id = info.Id;
    const short = id.replace('sha256:', '').slice(0, 12);
    const tags = (info.RepoTags ?? []).filter((t) => t !== '<none>:<none>');
    if (opts.tag !== undefined && !tags.includes(opts.tag))
      return fail(new AppError(409, 'conflict', `Image ${short} does not carry the tag ${opts.tag}`));
    const expected = opts.tag ?? tags[0] ?? short;
    if (opts.confirm !== expected && opts.confirm !== short)
      return fail(
        new AppError(409, 'confirmation_required', `Confirm by sending {"confirm":"${expected}"}`, {
          expected,
        }),
      );
    const sp = this.scopeProblem(tags, null);
    if (sp) return fail(new AppError(409, 'out_of_scope', `Refused: ${sp}`));

    const containers = await this.d.docker.listContainers({ all: true });
    const now = this.now();
    const referenced = await this.d.projectImageRefs();
    const rollbackIds = new Set(
      this.d.rollback
        .active()
        .filter((r) => r.expires_at > now)
        .map((r) => r.image_id),
    );
    const protectedTag = (t: string): string | null => {
      if (!isInternalTag(t)) {
        const p = parseImageRef(t);
        if (referenced.has(t) || (p !== null && referenced.has(cacheKey(p))))
          return `${t} is named by a discovered Compose project`;
        return null;
      }
      const rb = this.d.rollback.get(t);
      const st = this.d.staged.get(t);
      if (rb && rb.expires_at > now) return `${t} is a rollback point within retention`;
      if (st && st.created_at + this.d.retentionMs > now) return `${t} is a staged image within retention`;
      if (t.startsWith('quaymaster-rollback/') && !rb) return `${t} has no rollback record; kept`;
      return null;
    };

    const remaining = opts.tag === undefined ? [] : tags.filter((t) => t !== opts.tag);
    const wholeImage = opts.tag === undefined || remaining.length === 0;
    if (!wholeImage) {
      const tag = opts.tag as string;
      const why = protectedTag(tag);
      if (why) return fail(new AppError(409, 'conflict', `Refused: ${why}`));
      // RT3-05: compare normalised references. A container created as `nginx` stores Image="nginx", while the
      // tag is "nginx:latest" (and "docker.io/library/nginx:latest" is the same reference too).
      const want = parseImageRef(tag);
      const sameRef = (img: string): boolean => {
        if (img === tag) return true;
        const p = parseImageRef(img);
        return want !== null && p !== null && p.digest === null && cacheKey(p) === cacheKey(want);
      };
      const byTag = containers.filter((c) => sameRef(c.Image)).map((c) => this.containerLabel(c));
      if (byTag.length)
        return fail(
          new AppError(409, 'conflict', `Refused: container ${byTag.join(', ')} was created from ${tag}`),
        );
    } else {
      const users = containers.filter((c) => c.ImageID === id).map((c) => this.containerLabel(c));
      if (users.length)
        return fail(
          new AppError(
            409,
            'conflict',
            `Refused: image ${short} is used by ${users.length === 1 ? 'container' : 'containers'} ${users.join(', ')} (a stopped container counts)`,
          ),
        );
      if (rollbackIds.has(id))
        return fail(
          new AppError(409, 'conflict', `Refused: image ${short} is a rollback point within retention`),
        );
      for (const t of tags) {
        const why = protectedTag(t);
        if (why) return fail(new AppError(409, 'conflict', `Refused: ${why}`));
      }
    }

    const t0 = this.now();
    try {
      const { reclaim } = await measureReclaim(
        this.d.usage,
        this.d.freeBytes,
        async (before: DfMeasure | null) => {
          if (!wholeImage) {
            await this.d.images.remove(opts.tag as string);
            // an expired rollback/staged tag that was untagged must not leave a dangling record behind
            this.d.rollback.release(opts.tag as string);
            this.d.staged.delete(opts.tag as string);
            return { value: null, estimatedBytes: 0, maxBytes: 0 }; // untag frees nothing (RT3-06)
          }
          for (const t of tags) await this.d.images.remove(t);
          if ((await this.d.images.inspect(id)) !== null) await this.d.images.remove(id);
          for (const t of tags) {
            this.d.rollback.release(t);
            this.d.staged.delete(t);
          }
          return {
            value: null,
            estimatedBytes: uniqueSize(id, 0, before),
            maxBytes: before?.images[id]?.size,
          };
        },
      );
      this.d.containers.invalidate();
      this.d.audit.record({
        ...base,
        params: {
          via: 'single',
          action: wholeImage ? 'deleted' : 'untagged',
          tags,
          bytes: reclaim.reclaimedBytes,
          estimatedBytes: reclaim.estimatedBytes,
        },
        outcome: 'success',
        durationMs: this.now() - t0,
      });
      return {
        kind: 'image',
        name: expected,
        action: wholeImage ? 'deleted' : 'untagged',
        removedTags: wholeImage ? tags : [opts.tag as string],
        remainingTags: remaining,
        reclaim,
      };
    } catch (e) {
      this.d.audit.record({
        ...base,
        params: { via: 'single', error: (e as Error).message },
        outcome: 'failure',
      });
      throw e;
    }
  }

  private containerLabel(c: Dockerode.ContainerInfo): string {
    return (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, '');
  }
}

/** Bytes only this image owns: reported size minus layers shared with other images (unknown = full size). */
function uniqueSize(id: string, fallback: number, df: DfMeasure | null): number {
  const e = df?.images[id];
  if (!e) return fallback;
  return Math.max(e.size - (e.shared ?? 0), 0);
}
