import { randomBytes } from 'node:crypto';
import type Dockerode from 'dockerode';
import type { Config } from '../config/env.js';
import { mapDockerError } from '../docker/containers.js';
import { type Guard, withPermit } from '../security/guard.js';
import type { Logger } from '../util/logger.js';
import { COMPOSE_FILE_RE, ENV_FILE_RE, helperDirAllowed } from './labelpath.js';

/**
 * Read-only file helper (ADR "dynamic file access").
 *
 * To read the Compose files of a project whose directory is NOT mounted into Quaymaster, Quaymaster asks the Docker
 * daemon to start a short-lived container that bind-mounts exactly that directory READ-ONLY and prints the contents
 * of a handful of compose/.env files as JSON. The container:
 *
 *  - uses an image that is already present (the Quaymaster image itself unless QM_HELPER_IMAGE says otherwise);
 *    it is never pulled,
 *  - has no network, no capabilities, no new privileges, a read-only root file system, and tight memory/pid limits,
 *  - runs a fixed script passed as an argv array (no shell); the only variable input is a list of relative file
 *    names that were validated by `filesUnderDir` first,
 *  - refuses symlinks, non-regular files, world-writable files and files above 1 MiB,
 *  - is labelled `quaymaster.helper=true` and force-removed in a `finally`; leftovers are swept on start.
 *
 * Everything the helper returns is untrusted input again: names are re-validated and sizes re-checked here.
 */

export const HELPER_LABEL = 'quaymaster.helper';
const MAX_FILE = 1024 * 1024;
const MAX_TOTAL = 4 * 1024 * 1024;
const RUN_TIMEOUT_MS = 20_000;

export type HelperFileError =
  'missing' | 'unreadable' | 'symlink' | 'not_file' | 'too_large' | 'world_writable' | 'outside';

export interface HelperFile {
  name: string;
  content?: string;
  /** `.env` files: variable NAMES only (values never leave the helper). */
  keys?: string[];
  error?: HelperFileError;
  uid?: number;
  mode?: number;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/;

export type HelperResult =
  | { ok: true; dirMode: number | null; dirUid: number | null; files: HelperFile[] }
  | { ok: false; code: 'unavailable' | 'dir_missing' | 'failed'; reason: string };

/** Script run inside the helper with `node -e`. Plain JS, no dependencies, no shell. */
export const HELPER_SCRIPT = String.raw`
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = '/project';
const MAX = ${MAX_FILE};
const TOTAL = ${MAX_TOTAL};
const COMPOSE = new RegExp(${JSON.stringify(COMPOSE_FILE_RE.source)});
const ENVF = new RegExp(${JSON.stringify(ENV_FILE_RE.source)});
const wanted = new Set(process.argv.slice(1).filter((n) => COMPOSE.test(path.posix.basename(n))));
let dirMode = null, dirUid = null;
try { const d = fs.lstatSync(ROOT); dirMode = d.mode & 0o7777; dirUid = d.uid; } catch (e) {}
try { for (const n of fs.readdirSync(ROOT)) if (COMPOSE.test(n) || ENVF.test(n)) wanted.add(n); } catch (e) {}
const ENVLINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/;
const files = [];
let total = 0;
for (const rel of [...wanted].sort()) {
  const r = { name: rel };
  try {
    if (rel.startsWith('/') || rel.split('/').includes('..')) throw Object.assign(new Error('x'), { qm: 'outside' });
    let cur = ROOT;
    for (const seg of rel.split('/')) {
      cur = path.join(cur, seg);
      if (fs.lstatSync(cur).isSymbolicLink()) throw Object.assign(new Error('x'), { qm: 'symlink' });
    }
    const st = fs.lstatSync(cur);
    r.uid = st.uid; r.mode = st.mode & 0o7777;
    if (!st.isFile()) r.error = 'not_file';
    else if (st.size > MAX || total + st.size > TOTAL) r.error = 'too_large';
    else if (st.mode & 0o002) r.error = 'world_writable';
    else if (ENVF.test(path.posix.basename(rel))) {
      // .env: KEYS only. Values never leave this process: stdout ends up in the daemon's log driver (RT4-02).
      const keys = [];
      for (const line of fs.readFileSync(cur, 'utf8').split('\n')) { const m = ENVLINE.exec(line); if (m) keys.push(m[1]); }
      r.keys = keys.slice(0, 1000);
    }
    else { r.content = fs.readFileSync(cur, 'utf8'); total += st.size; }
  } catch (e) {
    r.error = e.qm || (e.code === 'ENOENT' ? 'missing' : 'unreadable');
  }
  files.push(r);
}
process.stdout.write(JSON.stringify({ dirMode, dirUid, files }));
`;

const FILE_ERRORS = new Set<string>([
  'missing',
  'unreadable',
  'symlink',
  'not_file',
  'too_large',
  'world_writable',
  'outside',
]);

/** Re-validates what came out of the helper. Exported for tests. */
export function parseHelperOutput(text: string, requested: readonly string[]): HelperResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim().split('\n').pop() ?? '');
  } catch {
    return { ok: false, code: 'failed', reason: 'the helper returned unreadable output' };
  }
  const o = raw as { dirMode?: unknown; dirUid?: unknown; files?: unknown };
  if (!o || typeof o !== 'object' || !Array.isArray(o.files))
    return { ok: false, code: 'failed', reason: 'the helper returned an unexpected shape' };
  const allowed = new Set(requested);
  const files: HelperFile[] = [];
  let total = 0;
  for (const f of o.files as unknown[]) {
    const x = f as Partial<HelperFile> & Record<string, unknown>;
    if (typeof x?.name !== 'string' || x.name.length > 300) continue;
    if (x.name.startsWith('/') || x.name.split('/').includes('..')) continue;
    const base = x.name.split('/').pop() ?? '';
    // only names we asked for, or the compose/.env names the helper discovers in the directory itself
    const plausible =
      (allowed.has(x.name) && COMPOSE_FILE_RE.test(base)) ||
      (!x.name.includes('/') && (COMPOSE_FILE_RE.test(base) || ENV_FILE_RE.test(base)));
    if (!plausible) continue;
    const out: HelperFile = { name: x.name };
    if (typeof x.error === 'string' && FILE_ERRORS.has(x.error)) out.error = x.error as HelperFileError;
    if (typeof x.uid === 'number') out.uid = x.uid;
    if (typeof x.mode === 'number') out.mode = x.mode;
    if (ENV_FILE_RE.test(base)) {
      // never content for .env files, even if a (modified) helper image printed some
      if (Array.isArray(x.keys) && !out.error)
        out.keys = (x.keys as unknown[])
          .filter((k): k is string => typeof k === 'string' && ENV_KEY_RE.test(k))
          .slice(0, 1000);
    } else if (typeof x.content === 'string' && !out.error) {
      total += Buffer.byteLength(x.content);
      if (x.content.length > MAX_FILE || total > MAX_TOTAL) out.error = 'too_large';
      else out.content = x.content;
    }
    files.push(out);
  }
  return {
    ok: true,
    dirMode: typeof o.dirMode === 'number' ? o.dirMode : null,
    dirUid: typeof o.dirUid === 'number' ? o.dirUid : null,
    files,
  };
}

/** stdout payload of a Docker multiplexed log stream (8-byte frame headers). */
export function stdoutOf(buf: Buffer): string {
  const parts: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    if (buf[i] === 1) parts.push(buf.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return Buffer.concat(parts).toString('utf8');
}

export interface HelperStatus {
  usable: boolean;
  /** Why not, when `usable` is false. */
  reason: string | null;
  image: string | null;
  /** Host directories the helper never mounts (Docker data root, Quaymaster's data directory). */
  deniedDirs?: string[];
}

/** At most this many helper containers exist at once, whoever asks (RT4-05). */
const MAX_CONCURRENT = 2;
const STATUS_CACHE_MS = 15_000;

/**
 * User the helper runs as: Quaymaster's own uid:gid, so it can read what Quaymaster could read if the directory were
 * mounted, never more. When Quaymaster itself runs as root (on the host), `nobody` (RT4-01: an image with `USER root`
 * set as QM_HELPER_IMAGE must not read root-only files such as credentials).
 */
export function helperUser(
  uid: number | undefined = process.getuid?.(),
  gid: number | undefined = process.getgid?.(),
): string {
  if (uid === undefined || gid === undefined || uid === 0) return '65534:65534';
  return `${uid}:${gid}`;
}

export class FileHelper {
  private imageCache: { at: number; value: string | null } | null = null;
  private statusCache: { at: number; value: HelperStatus } | null = null;
  private running = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(
    private readonly d: {
      docker: Dockerode;
      guard: Guard;
      config: Pick<Config, 'helper' | 'managedScope'>;
      /** Image of Quaymaster's own container (null when it does not run in one). */
      selfImage: () => Promise<string | null>;
      log: Logger;
      /** Host directories that must never be mounted into a helper. */
      deniedDirs?: () => string[];
    },
  ) {}

  private async acquire(): Promise<void> {
    if (this.running < MAX_CONCURRENT) {
      this.running++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.running--;
  }

  /** Name of the next helper container; must satisfy QM_MANAGED_SCOPE, otherwise there is no helper. */
  helperName(): string | null {
    const id = randomBytes(5).toString('hex');
    const plain = `quaymaster-helper-${id}`;
    if (this.d.guard.inScope(plain)) return plain;
    // a managed scope like "qmtest-*": use its literal prefix so the helper is itself inside the scope
    for (const g of this.d.guard.scope) {
      const star = g.indexOf('*');
      if (star > 0 && !/[?]/.test(g.slice(0, star))) {
        const n = `${g.slice(0, star)}quaymaster-helper-${id}`;
        if (this.d.guard.inScope(n)) return n;
      }
    }
    return null;
  }

  async status(): Promise<HelperStatus> {
    if (this.statusCache && Date.now() - this.statusCache.at < STATUS_CACHE_MS) return this.statusCache.value;
    const value = await this.computeStatus();
    this.statusCache = { at: Date.now(), value };
    return value;
  }

  private async computeStatus(): Promise<HelperStatus> {
    const off = (reason: string): HelperStatus => ({ usable: false, reason, image: null });
    if (!this.d.config.helper.enabled) return off('the file helper is disabled (QM_HELPER_ENABLED=false)');
    const ro = this.d.guard.readOnlyReason;
    if (ro)
      return off(
        `the file helper needs to create a short-lived container, which read-only mode forbids (${ro})`,
      );
    if (this.helperName() === null) return off('no helper container name satisfies QM_MANAGED_SCOPE');
    const image = await this.image();
    if (!image)
      return off(
        'no helper image: Quaymaster does not run in a container and QM_HELPER_IMAGE is not set (a local image that contains Node.js)',
      );
    try {
      await this.d.docker.getImage(image).inspect();
    } catch {
      return off(
        `the helper image "${image}" is not present on this Docker host (it is never pulled automatically)`,
      );
    }
    return { usable: true, reason: null, image, deniedDirs: this.deniedDirs() };
  }

  private deniedDirs(): string[] {
    try {
      return (this.d.deniedDirs?.() ?? []).filter((d) => typeof d === 'string' && d.startsWith('/'));
    } catch {
      return [];
    }
  }

  private async image(): Promise<string | null> {
    const c = this.d.config.helper.image;
    if (c) return c;
    if (this.imageCache && Date.now() - this.imageCache.at < 60_000) return this.imageCache.value;
    const v = await this.d.selfImage().catch(() => null);
    this.imageCache = { at: Date.now(), value: v };
    return v;
  }

  /**
   * Reads `rel` (validated relative names) plus the compose/.env files found directly in `dir`.
   * `dir` is re-checked with `helperDirAllowed` here (defence in depth: callers check it too).
   */
  async read(dir: string, rel: readonly string[]): Promise<HelperResult> {
    const st = await this.status();
    if (!st.usable || !st.image)
      return { ok: false, code: 'unavailable', reason: st.reason ?? 'unavailable' };
    const ro = this.d.guard.readOnlyReason;
    if (ro) return { ok: false, code: 'unavailable', reason: `read-only mode (${ro})` };
    const allowed = helperDirAllowed(dir, this.deniedDirs());
    if (!allowed.ok) return { ok: false, code: 'unavailable', reason: allowed.reason };
    const names = rel.filter((r) => COMPOSE_FILE_RE.test(r.split('/').pop() ?? ''));
    await this.acquire();
    try {
      return await this.run(st.image, dir, names);
    } finally {
      this.release();
    }
  }

  private async run(image: string, dir: string, rel: readonly string[]): Promise<HelperResult> {
    const name = this.helperName();
    if (!name) return { ok: false, code: 'unavailable', reason: 'no permitted helper name' };
    let id: string | null = null;
    try {
      let created: Dockerode.Container;
      try {
        created = await withPermit({ kind: 'container_create', name }, () =>
          this.d.docker.createContainer({
            name,
            Image: image,
            User: helperUser(),
            Entrypoint: ['node', '-e', HELPER_SCRIPT, '--'],
            Cmd: [...rel],
            Tty: false,
            NetworkDisabled: true,
            Labels: { ...this.d.config.helper.labels, [HELPER_LABEL]: 'true' },
            HostConfig: {
              NetworkMode: 'none',
              // RT4-02: the output (compose files) must not be shipped to a remote/journald log driver; json-file
              // logs are deleted together with the container in the `finally` below
              LogConfig: { Type: 'json-file', Config: { 'max-size': '8m', 'max-file': '1' } },
              Mounts: [
                {
                  Type: 'bind',
                  Source: dir,
                  Target: '/project',
                  ReadOnly: true,
                  BindOptions: { CreateMountpoint: false },
                },
              ],
              ReadonlyRootfs: true,
              CapDrop: ['ALL'],
              SecurityOpt: ['no-new-privileges:true'],
              Privileged: false,
              PidsLimit: 64,
              Memory: 128 * 1024 * 1024,
              MemorySwap: 128 * 1024 * 1024,
              AutoRemove: false,
            },
          } as unknown as Dockerode.ContainerCreateOptions),
        );
      } catch (e) {
        const msg = (e as Error).message ?? '';
        if (/bind source path does not exist|no such file or directory|invalid mount config/i.test(msg)) {
          return {
            ok: false,
            code: 'dir_missing',
            reason: `${dir} does not exist on the Docker host`,
          };
        }
        const m = mapDockerError(e);
        return { ok: false, code: 'failed', reason: `cannot create the helper: ${m.message}` };
      }
      id = created.id;
      const fullId = id;
      await withPermit({ containerId: fullId, action: 'start' }, () => created.start());
      const deadline = Date.now() + RUN_TIMEOUT_MS;
      let exit: number | null = null;
      while (Date.now() < deadline) {
        const info = await created.inspect();
        if (info.State.Status === 'exited' || info.State.Status === 'dead') {
          exit = info.State.ExitCode;
          break;
        }
        await new Promise((r) => setTimeout(r, 120));
      }
      if (exit === null) return { ok: false, code: 'failed', reason: 'the helper timed out' };
      const logs = (await created.logs({ stdout: true, stderr: false, follow: false })) as unknown;
      if (!Buffer.isBuffer(logs))
        return { ok: false, code: 'failed', reason: 'the helper output could not be read' };
      const text = stdoutOf(logs);
      if (exit !== 0) return { ok: false, code: 'failed', reason: `the helper exited with code ${exit}` };
      return parseHelperOutput(text.replace(/\r/g, ''), rel);
    } catch (e) {
      return { ok: false, code: 'failed', reason: mapDockerError(e).message };
    } finally {
      if (id) {
        const cid = id;
        await withPermit({ containerId: cid, action: 'remove' }, () =>
          this.d.docker.getContainer(cid).remove({ force: true, v: true }),
        ).catch((e: unknown) => this.d.log.warn({ err: e }, 'could not remove helper container'));
      }
    }
  }

  /** Removes helper containers left behind by a crash (only ours: label AND name prefix). */
  async sweep(): Promise<number> {
    if (this.d.guard.readOnlyReason) return 0;
    let n = 0;
    try {
      const list = await this.d.docker.listContainers({
        all: true,
        filters: JSON.stringify({ label: [`${HELPER_LABEL}=true`] }),
      });
      for (const c of list) {
        const nm = (c.Names?.[0] ?? '').replace(/^\//, '');
        if (!/quaymaster-helper-[0-9a-f]{10}$/.test(nm) || !this.d.guard.inScope(nm)) continue;
        if (Date.now() / 1000 - c.Created < 60) continue;
        await withPermit({ containerId: c.Id, action: 'remove' }, () =>
          this.d.docker.getContainer(c.Id).remove({ force: true, v: true }),
        ).then(
          () => n++,
          () => undefined,
        );
      }
    } catch {
      /* best effort */
    }
    return n;
  }
}
