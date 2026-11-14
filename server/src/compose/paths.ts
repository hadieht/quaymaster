import { accessSync, constants, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ReasonCode } from '@quaymaster/shared';

export type PathCheck = { ok: true; real: string } | { ok: false; reason: string; code: ReasonCode };

const isUnder = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

const realOrResolved = (r: string): string => {
  try {
    return realpathSync(r);
  } catch {
    return path.resolve(r);
  }
};

/**
 * Allow-list of directories Quaymaster may run Compose against (RT-02). Compose labels are untrusted data:
 * a path is acceptable only if its realpath (symlinks resolved, `..` collapsed) lies under an allowed root and
 * not under the Docker data root, whatever the roots say.
 *
 * Roots come from two administrator-controlled sources, never from container labels:
 *  - `QM_STACK_PATHS`
 *  - (optional) bind mounts of Quaymaster's own container whose source and destination are the SAME path —
 *    the operator mounted that directory into Quaymaster on purpose (see `dynamicRoots`).
 */
export class PathPolicy {
  private readonly roots: string[];

  constructor(
    roots: string[],
    private readonly dockerRoot: () => string | null = () => null,
    private readonly dynamicRoots: () => string[] = () => [],
  ) {
    this.roots = roots.map(realOrResolved);
  }

  get allowedRoots(): string[] {
    return [...new Set([...this.roots, ...this.dynamicRoots().map(realOrResolved)])];
  }

  /** Roots that come from Quaymaster's own mounts rather than QM_STACK_PATHS (for display). */
  get mountRoots(): string[] {
    return this.dynamicRoots().map(realOrResolved);
  }

  check(p: string, opts: { requireReadable?: boolean } = {}): PathCheck {
    if (!p || !path.isAbsolute(p))
      return { ok: false, code: 'untrusted', reason: `"${p}" is not an absolute path` };
    if (p.includes('\0')) return { ok: false, code: 'untrusted', reason: 'path contains a NUL byte' };
    let real: string;
    try {
      real = realpathSync(p);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        return {
          ok: false,
          code: 'not_readable',
          reason: `${p} is not readable by Quaymaster (permission denied)`,
        };
      }
      return {
        ok: false,
        code: 'not_mounted',
        reason: `${p} does not exist inside the Quaymaster container (the directory is not mounted at this path, or is not accessible)`,
      };
    }
    const dr = this.dockerRoot();
    if (dr) {
      const drReal = realOrResolved(dr);
      if (isUnder(real, drReal))
        return { ok: false, code: 'untrusted', reason: `${p} lies inside the Docker data root` };
    }
    const roots = this.allowedRoots;
    if (!roots.some((r) => isUnder(real, r))) {
      // a symlink that leaves an allowed root is an escape attempt, not merely a missing allow-list entry
      const lexical = path.normalize(p);
      if (roots.some((r) => isUnder(lexical, r))) {
        return {
          ok: false,
          code: 'untrusted',
          reason: `${p} is a symlink that resolves outside the allowed stack paths (${real})`,
        };
      }
      return {
        ok: false,
        code: 'path_not_allowed',
        reason: `${p} is outside the allowed stack paths (QM_STACK_PATHS and directories mounted into Quaymaster at the same path)`,
      };
    }
    if (opts.requireReadable) {
      try {
        accessSync(real, constants.R_OK);
      } catch {
        return {
          ok: false,
          code: 'not_readable',
          reason: `${p} is not readable by Quaymaster (permission denied)`,
        };
      }
    }
    return { ok: true, real };
  }
}
