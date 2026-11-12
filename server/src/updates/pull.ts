import type { AppContext } from '../context.js';
import { cacheKey, engineName, formatRef, parseImageRef } from '../registry/reference.js';
import { AppError, badRequest } from '../util/errors.js';

/**
 * Standalone pull (RT-07/RT-20), service layer. Resolves the registry digest, pulls BY DIGEST and stages the
 * result. It never restarts, recreates or retags anything that is in use. If the tag does not exist locally
 * yet there is nothing to move, so the tag is added as well.
 *
 * Scope (audit H-02): with a managed scope, only references used by an in-scope container (or whose repository
 * name itself matches the scope) may be pulled, and
 * a missing tag is never added for anything else, so a scoped instance cannot grow the daemon with arbitrary
 * images or create tags other tools would pick up.
 */
export async function startStandalonePull(
  ctx: AppContext,
  raw: string,
  actor: { name: string; ip: string | null },
): Promise<string> {
  const ref = parseImageRef(raw);
  if (!ref || ref.digest) throw badRequest('Give a tag reference such as nginx:1.27 (not a digest)');
  const ro = ctx.guard.readOnlyReason;
  if (ro) throw new AppError(409, 'read_only', `Read-only mode: ${ro}`);

  if (ctx.guard.scope.length > 0) {
    const wanted = formatRef(ref);
    const repoName = ref.repo.split('/').pop() ?? ref.repo;
    const used =
      ctx.guard.inScope(repoName) ||
      (await ctx.containers.listRaw()).some((c) => {
        const name = (c.Names?.[0] ?? '').replace(/^\//, '');
        const project = c.Labels?.['com.docker.compose.project'] ?? null;
        if (!ctx.guard.containerInScope(name, project)) return false;
        const cr = parseImageRef(c.Image);
        return cr !== null && formatRef(cr) === wanted;
      });
    if (!used) {
      throw new AppError(
        403,
        'out_of_scope',
        `Out of managed scope: ${wanted} is not used by any in-scope container (QM_MANAGED_SCOPE=${ctx.guard.scope.join(',')})`,
      );
    }
  }

  return ctx.ops.start({
    kind: 'image.pull',
    target: formatRef(ref),
    actor: actor.name,
    params: { ref: raw },
    lockKey: `pull:${cacheKey(ref)}`,
    run: async (op) => {
      const t0 = Date.now();
      try {
        const free = (await ctx.system.host()).dockerRoot;
        if (!free)
          throw new AppError(
            409,
            'insufficient_disk',
            'Free space on the Docker root cannot be determined (mount it and set QM_DOCKER_ROOT_MOUNT); refusing to pull',
          );
        const head = await ctx.registry.headManifest(ref);
        const size = await ctx.registry.compressedSize(ref, head.digest).catch(() => 0);
        const floor = Math.max(ctx.config.diskFloorBytes, Math.floor(free.total * 0.1));
        if (free.free < Math.ceil(2.5 * size) + floor)
          throw new AppError(
            409,
            'insufficient_disk',
            `Not enough free disk space: ${Math.round(free.free / 1048576)} MiB free, need ${Math.round((Math.ceil(2.5 * size) + floor) / 1048576)} MiB`,
          );
        op.log(`registry digest for ${formatRef(ref)}: ${head.digest}\n`);
        const hadTag = (await ctx.imageOps.inspect(formatRef(ref))) !== null;
        const res = await ctx.imageOps.pullByDigest(ref, head.digest, (p) => {
          if (p.status)
            op.log(`${p.id ? `${p.id}: ` : ''}${p.status}${p.progress ? ` ${p.progress}` : ''}\n`);
        });
        op.log(`staged as ${res.stagedTag}\n`);
        if (!hadTag) {
          await ctx.imageOps.tag(res.imageId, `${engineName(ref)}:${ref.tag}`);
          op.log(`tag ${formatRef(ref)} did not exist locally; added it (nothing was moved)\n`);
        } else {
          op.log(
            'the existing tag was NOT moved: deploy happens in a maintenance run or an explicit redeploy\n',
          );
        }
        ctx.checksRepo.invalidate(cacheKey(ref));
        ctx.audit.record({
          actor: actor.name,
          ip: actor.ip,
          action: 'image.pull',
          target: formatRef(ref),
          params: { digest: head.digest, op: op.id },
          outcome: 'success',
          durationMs: Date.now() - t0,
        });
      } catch (e) {
        ctx.audit.record({
          actor: actor.name,
          ip: actor.ip,
          action: 'image.pull',
          target: formatRef(ref),
          params: { error: (e as Error).message, op: op.id },
          outcome: 'failure',
          durationMs: Date.now() - t0,
        });
        throw e;
      }
    },
  });
}
