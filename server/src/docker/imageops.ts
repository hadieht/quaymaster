import type Dockerode from 'dockerode';
import type { AuditService } from '../audit/audit.js';
import type { RegistryCredentialsRepo, StagedRepo } from '../db/updates.js';
import { engineName, parseImageRef, stagedTag, type ImageRef } from '../registry/reference.js';
import { withPermit } from '../security/guard.js';
import { AppError, badRequest } from '../util/errors.js';
import { mapDockerError } from './containers.js';
import { isSafeRef } from './model.js';

export interface PullProgress {
  status: string;
  id?: string;
  progress?: string;
  current?: number;
  total?: number;
}

export interface PullResult {
  imageId: string;
  digest: string;
  stagedTag: string;
}

/**
 * The only code that pulls, tags and untags images (RT-03/RT-07/RT-20):
 *
 *  - pulls go through the Engine API with `X-Registry-Auth` from the encrypted credential store
 *  - pulls are BY DIGEST, then tagged `quaymaster-staged/<hash>:<digest12>`; the user-visible tag is
 *    never moved here (the deploy step moves it, RT-07)
 *  - a pull never starts, stops, recreates or retags anything that is in use
 *  - every call needs a narrow permit enforced at the transport
 */
export class ImageOps {
  constructor(
    private readonly d: {
      docker: Dockerode;
      creds: RegistryCredentialsRepo;
      staged: StagedRepo;
      audit: AuditService;
      /** Free bytes on the Docker root, or null when unknown. */
      freeBytes: () => Promise<number | null>;
      floorBytes: number;
      now?: () => number;
    },
  ) {}

  authFor(
    ref: Pick<ImageRef, 'registry'>,
  ): { username: string; password: string; serveraddress: string } | undefined {
    const host = ref.registry === 'docker.io' ? 'registry-1.docker.io' : ref.registry;
    const c = this.d.creds.get(host) ?? this.d.creds.get(ref.registry);
    return c
      ? { ...c, serveraddress: ref.registry === 'docker.io' ? 'https://index.docker.io/v1/' : ref.registry }
      : undefined;
  }

  async inspect(nameOrId: string): Promise<Dockerode.ImageInspectInfo | null> {
    if (!isSafeRef(nameOrId, 'image')) throw badRequest('Invalid image reference');
    try {
      return await this.d.docker.getImage(nameOrId).inspect();
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null;
      throw mapDockerError(e);
    }
  }

  /**
   * Pulls `repo@digest` and stages it. Aborts (leaving whatever layers arrived) when free space on the
   * Docker root falls below the floor while pulling (RT-13).
   */
  async pullByDigest(
    ref: ImageRef,
    digest: string,
    onProgress?: (p: PullProgress) => void,
    opts: { stage?: boolean } = {},
  ): Promise<PullResult> {
    const repo = engineName({ registry: ref.registry, repo: ref.repo });
    const auth = this.authFor(ref);
    const docker = this.d.docker;
    let guardTimer: NodeJS.Timeout | undefined;
    let aborted: string | null = null;
    try {
      await withPermit({ kind: 'image_pull', repo, tag: digest }, async () => {
        const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
          (
            docker.modem as unknown as {
              dial(o: object, cb: (e: unknown, s: NodeJS.ReadableStream) => void): void;
            }
          ).dial(
            {
              path: '/images/create?',
              method: 'POST',
              options: { fromImage: repo, tag: digest },
              authconfig: auth,
              isStream: true,
              statusCodes: {
                200: true,
                404: 'repository does not exist or no pull access',
                500: 'server error',
              },
            },
            (e, s) => (e ? reject(e) : resolve(s)),
          );
        });
        guardTimer = setInterval(() => {
          void this.d.freeBytes().then((free) => {
            if (free !== null && free < this.d.floorBytes && !aborted) {
              aborted = `free space on the Docker root fell below the floor (${free} < ${this.d.floorBytes} bytes)`;
              (stream as unknown as { destroy?: (e?: Error) => void }).destroy?.(new Error(aborted));
            }
          });
        }, 1500);
        guardTimer.unref();
        await new Promise<void>((resolve, reject) => {
          (
            docker.modem as unknown as {
              followProgress(
                s: NodeJS.ReadableStream,
                done: (e: Error | null, out: unknown[]) => void,
                onProgress: (ev: PullProgress & { error?: string }) => void,
              ): void;
            }
          ).followProgress(
            stream,
            (e, out) => {
              const failed = (out as { error?: string }[]).find((o) => o.error);
              if (aborted) reject(new AppError(507, 'insufficient_disk', aborted));
              else if (e) reject(e);
              else if (failed?.error) reject(new Error(failed.error));
              else resolve();
            },
            (ev) => onProgress?.(ev),
          );
        });
      });
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(
        502,
        'registry_error',
        `pull of ${repo}@${digest.slice(0, 19)} failed: ${(e as Error).message}`,
      );
    } finally {
      if (guardTimer) clearInterval(guardTimer);
    }
    const info = await this.inspect(`${repo}@${digest}`);
    if (!info) throw new AppError(502, 'registry_error', 'the pulled image is not present after the pull');
    const tag = stagedTag(ref, digest);
    // stage:false only refreshes the registry digest record of the image (no alias, no staged row)
    if (opts.stage === false) return { imageId: info.Id, digest, stagedTag: tag };
    await this.tag(info.Id, tag);
    this.d.staged.put({
      tag,
      ref: `${ref.registry}/${ref.repo}:${ref.tag ?? 'latest'}`,
      digest,
      image_id: info.Id,
      created_at: (this.d.now ?? Date.now)(),
    });
    return { imageId: info.Id, digest, stagedTag: tag };
  }

  /** Adds `repoTag` (`repo:tag`) to an image. Never removes anything. */
  async tag(imageId: string, repoTag: string): Promise<void> {
    const i = repoTag.lastIndexOf(':');
    const repo = repoTag.slice(0, i);
    const tag = repoTag.slice(i + 1);
    try {
      await withPermit({ kind: 'image_tag', imageId, repo, tag }, () =>
        this.d.docker.getImage(imageId).tag({ repo, tag }),
      );
    } catch (e) {
      throw mapDockerError(e);
    }
  }

  /**
   * Removes a tag (or, for an ID/untagged image, the image). Docker refuses to delete an image that a
   * container uses (409); that refusal is surfaced, never forced (RT-03).
   */
  async remove(nameOrId: string): Promise<void> {
    try {
      await withPermit({ kind: 'image_remove', name: nameOrId }, () =>
        this.d.docker.getImage(nameOrId).remove({ force: false }),
      );
    } catch (e) {
      throw mapDockerError(e);
    }
  }

  /** Is a user-supplied reference a plain tag reference we are willing to pull? */
  parse(refStr: string): ImageRef {
    const r = parseImageRef(refStr);
    if (!r) throw new AppError(400, 'validation', 'Invalid image reference');
    return r;
  }
}
