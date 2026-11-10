import { accessSync, constants, realpathSync } from 'node:fs';
import path from 'node:path';

export type PathCheck = { ok: true; real: string } | { ok: false; reason: string };

const isUnder = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/**
 * `QM_STACK_PATHS` allow-list (RT-02). Compose labels are untrusted data: a path is acceptable only
 * if its realpath (symlinks resolved, `..` collapsed) lies under an allowed root and not under the
 * Docker data root, whatever the roots say.
 */
export class PathPolicy {
  private readonly roots: string[];

  constructor(
    roots: string[],
    private readonly dockerRoot: () => string | null = () => null,
  ) {
    this.roots = roots.map((r) => {
      try {
        return realpathSync(r);
      } catch {
        return path.resolve(r);
      }
    });
  }

  get allowedRoots(): string[] {
    return this.roots;
  }

  check(p: string, opts: { requireReadable?: boolean } = {}): PathCheck {
    if (!p || !path.isAbsolute(p)) return { ok: false, reason: `"${p}" is not an absolute path` };
    if (p.includes('\0')) return { ok: false, reason: 'path contains a NUL byte' };
    let real: string;
    try {
      real = realpathSync(p);
    } catch {
      return { ok: false, reason: `${p} does not exist or is not readable by Quaymaster (mount it at the same path, under QM_STACK_PATHS)` };
    }
    const dr = this.dockerRoot();
    if (dr) {
      let drReal = dr;
      try {
        drReal = realpathSync(dr);
      } catch {
        /* keep as given */
      }
      if (isUnder(real, drReal)) return { ok: false, reason: `${p} lies inside the Docker data root` };
    }
    if (!this.roots.some((r) => isUnder(real, r))) {
      return { ok: false, reason: `${p} is outside QM_STACK_PATHS` };
    }
    if (opts.requireReadable) {
      try {
        accessSync(real, constants.R_OK);
      } catch {
        return { ok: false, reason: `${p} is not readable` };
      }
    }
    return { ok: true, real };
  }
}
