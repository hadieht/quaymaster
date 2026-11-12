import { AsyncLocalStorage } from 'node:async_hooks';
import type { ContainerAction } from '@quaymaster/shared';
import { AppError } from '../util/errors.js';

/** Information about the Quaymaster process itself (RT-05). */
export interface SelfInfo {
  /** True when we believe we run inside a container. */
  inContainer: boolean;
  /** Full container ID when determined. */
  containerId: string | null;
  containerName: string | null;
  project: string | null;
  networks: string[];
  volumes: string[];
  /** Set when inContainer but the container could not be identified: the guard then fails closed. */
  failure: string | null;
}

export const NO_SELF: SelfInfo = {
  inContainer: false,
  containerId: null,
  containerName: null,
  project: null,
  networks: [],
  volumes: [],
  failure: null,
};

export function globToRegExp(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

export interface ContainerRef {
  id: string;
  name: string;
  project: string | null;
}

export type MutationKind = ContainerAction | 'compose' | 'image' | 'volume' | 'network';

export interface ProjectRefs {
  /** Names of volumes / networks / containers the resolved project config references. */
  volumes: string[];
  networks: string[];
  containers: string[];
}

export interface GuardOptions {
  readOnly: boolean;
  scope: string[];
  visibleScope?: string[];
  protectedNames: string[];
  self?: SelfInfo;
}

/**
 * The safety policy: read-only mode, managed scope and self-protection.
 *
 * Service-layer methods call `assert*` after resolving the target to its full ID and inspecting
 * it; the Docker transport additionally refuses any mutating Engine call that was not authorised
 * through a permit, so a code path that forgets to ask cannot mutate anything (RT-03).
 */
export class Guard {
  private scopeRes: RegExp[];
  private protectedRes: RegExp[];
  private visibleRes: RegExp[];
  private self: SelfInfo;

  constructor(private readonly opts: GuardOptions) {
    this.scopeRes = opts.scope.map(globToRegExp);
    this.protectedRes = opts.protectedNames.map(globToRegExp);
    this.visibleRes = (opts.visibleScope ?? []).map(globToRegExp);
    this.self = opts.self ?? NO_SELF;
  }

  private maintenanceGate: ((project: string | null, name: string | null) => string | null) | null = null;

  /** Wires the check that refuses manual actions on a project while a maintenance run owns it (audit H-03). */
  setMaintenanceGate(fn: (project: string | null, name: string | null) => string | null): void {
    this.maintenanceGate = fn;
  }

  assertNotUnderMaintenance(project: string | null, name: string | null): void {
    const why = this.maintenanceGate?.(project, name);
    if (why) throw new AppError(409, 'conflict', why);
  }

  setSelf(self: SelfInfo): void {
    this.self = self;
  }
  getSelf(): SelfInfo {
    return this.self;
  }

  get scope(): string[] {
    return this.opts.scope;
  }

  /** Read-only because configured, or because we run in a container and cannot identify it. */
  get readOnlyReason(): string | null {
    if (this.opts.readOnly) return 'QM_READ_ONLY is set';
    if (this.self.failure) return `self-protection could not identify this container (${this.self.failure})`;
    return null;
  }
  get readOnly(): boolean {
    return this.readOnlyReason !== null;
  }

  /** QM_VISIBLE_SCOPE: resources outside it do not exist as far as the UI and API are concerned. */
  get visibilityRestricted(): boolean {
    return this.visibleRes.length > 0;
  }
  visible(name: string): boolean {
    return this.visibleRes.length === 0 || this.visibleRes.some((r) => r.test(name.replace(/^\//, '')));
  }
  containerVisible(name: string, project: string | null): boolean {
    return this.visible(name) && (project === null || this.visible(project));
  }

  inScope(name: string): boolean {
    return this.scopeRes.length === 0 || this.scopeRes.some((r) => r.test(name));
  }

  /** Containers: name AND compose project (when present) must both match a non-empty scope. */
  containerInScope(name: string, project: string | null): boolean {
    return this.inScope(name.replace(/^\//, '')) && (project === null || this.inScope(project));
  }

  /** Why this container must never be mutated by us (null = not protected). */
  containerProtectedReason(c: ContainerRef): string | null {
    const s = this.self;
    if (s.containerId && c.id === s.containerId) return 'this is the Quaymaster container itself';
    if (this.protectedRes.some((r) => r.test(c.name.replace(/^\//, '')))) return 'listed in QM_PROTECTED';
    return null;
  }

  /** Project-level mutations are refused for Quaymaster's own Compose project (RT-05). */
  projectProtectedReason(project: string): string | null {
    if (this.self.project && project === this.self.project) {
      return "this is Quaymaster's own Compose project (per-service actions on other services are allowed)";
    }
    if (this.protectedRes.some((r) => r.test(project))) return 'listed in QM_PROTECTED';
    return null;
  }

  volumeProtectedReason(name: string): string | null {
    return this.self.volumes.includes(name) ? "used by Quaymaster's own container" : null;
  }
  networkProtectedReason(name: string): string | null {
    return this.self.networks.includes(name) ? "used by Quaymaster's own container" : null;
  }

  /** Why mutating this container is refused right now, in priority order. Null = allowed. */
  containerRefusal(
    c: ContainerRef,
  ): { code: 'read_only' | 'out_of_scope' | 'self_protected'; message: string } | null {
    const ro = this.readOnlyReason;
    if (ro) return { code: 'read_only', message: `Read-only mode: ${ro}` };
    const prot = this.containerProtectedReason(c);
    if (prot) return { code: 'self_protected', message: `Refused: ${prot}` };
    if (!this.containerInScope(c.name, c.project)) {
      return {
        code: 'out_of_scope',
        message: `Refused: "${c.name.replace(/^\//, '')}"${c.project ? ` (project "${c.project}")` : ''} is outside QM_MANAGED_SCOPE`,
      };
    }
    return null;
  }

  assertContainer(c: ContainerRef, _action: MutationKind): void {
    const r = this.containerRefusal(c);
    if (r) throw new AppError(409, r.code, r.message);
  }

  projectRefusal(
    project: string,
    refs?: ProjectRefs,
    opts: { perService?: boolean } = {},
  ): { code: 'read_only' | 'out_of_scope' | 'self_protected'; message: string } | null {
    const ro = this.readOnlyReason;
    if (ro) return { code: 'read_only', message: `Read-only mode: ${ro}` };
    const prot = opts.perService ? null : this.projectProtectedReason(project);
    if (prot) return { code: 'self_protected', message: `Refused: ${prot}` };
    if (!this.inScope(project)) {
      return { code: 'out_of_scope', message: `Refused: project "${project}" is outside QM_MANAGED_SCOPE` };
    }
    if (refs && this.scopeRes.length > 0) {
      const bad: string[] = [];
      for (const v of refs.volumes) if (!this.inScope(v)) bad.push(`volume ${v}`);
      for (const n of refs.networks) if (!this.inScope(n)) bad.push(`network ${n}`);
      for (const c of refs.containers) if (!this.inScope(c)) bad.push(`container ${c}`);
      if (bad.length > 0) {
        return {
          code: 'out_of_scope',
          message: `Refused: project "${project}" references resources outside QM_MANAGED_SCOPE: ${bad.join(', ')}`,
        };
      }
    }
    for (const v of refs?.volumes ?? []) {
      const p = this.volumeProtectedReason(v);
      if (p) return { code: 'self_protected', message: `Refused: volume ${v} is ${p}` };
    }
    return null;
  }

  assertProject(project: string, refs?: ProjectRefs, opts: { perService?: boolean } = {}): void {
    const r = this.projectRefusal(project, refs, opts);
    if (r) throw new AppError(409, r.code, r.message);
  }

  /** Compose subcommand authorisation (RT-03): read-only mode allows only these. */
  static readonly COMPOSE_READ_ONLY = new Set(['config', 'ls', 'ps', 'images', 'version']);
  static readonly COMPOSE_MUTATING = new Set(['up', 'stop', 'start', 'restart', 'down']);

  assertComposeSubcommand(sub: string): void {
    if (Guard.COMPOSE_READ_ONLY.has(sub)) return;
    if (!Guard.COMPOSE_MUTATING.has(sub)) {
      throw new AppError(400, 'unsupported', `Compose subcommand "${sub}" is not permitted`);
    }
    const ro = this.readOnlyReason;
    if (ro) throw new AppError(409, 'read_only', `Read-only mode: ${ro}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Mutation permits (transport-level enforcement)
// ---------------------------------------------------------------------------------------------

export interface ContainerPermit {
  /** Full 64-hex container ID the Engine call may touch. */
  containerId: string;
  action: ContainerAction;
}

/** Narrow authority for the non-lifecycle Engine mutations the update workflow needs (RT-03). */
export type EnginePermit =
  | { kind: 'image_pull'; repo: string; tag: string }
  | { kind: 'image_tag'; imageId: string; repo: string; tag: string }
  | { kind: 'image_remove'; name: string }
  | { kind: 'container_create'; name: string }
  | { kind: 'container_rename'; containerId: string; newName: string }
  | { kind: 'container_restart_policy'; containerId: string }
  | { kind: 'network_connect' | 'network_disconnect'; network: string; containerId: string };

export type MutationPermit = ContainerPermit | EnginePermit;

export const permitStore = new AsyncLocalStorage<MutationPermit>();

export const FULL_ID_RE = /^[0-9a-f]{64}$/;

/** Runs `fn` with the authority to perform exactly the mutation described by `permit`. */
export function withPermit<T>(permit: MutationPermit, fn: () => Promise<T>): Promise<T> {
  if ('containerId' in permit && !FULL_ID_RE.test(permit.containerId)) {
    return Promise.reject(new AppError(500, 'internal', 'Permit requires a full container ID'));
  }
  return permitStore.run(permit, fn);
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

const CONTAINER_POST = /^\/containers\/([0-9a-f]{64})\/(start|stop|restart|kill|pause|unpause)$/;
const CONTAINER_DELETE = /^\/containers\/([0-9a-f]{64})$/;
const CONTAINER_RENAME = /^\/containers\/([0-9a-f]{64})\/rename$/;
const CONTAINER_UPDATE = /^\/containers\/([0-9a-f]{64})\/update$/;
const NETWORK_ATTACH = /^\/networks\/([^/]+)\/(connect|disconnect)$/;
const IMAGE_TAG = /^\/images\/(.+)\/tag$/;
const IMAGE_DELETE = /^\/images\/(.+)$/;

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function denyPermit(m: string, pathOnly: string): never {
  throw new AppError(
    403,
    'internal',
    `Engine mutation ${m} ${pathOnly} was not authorised by the service layer`,
  );
}

function notAllowListed(m: string, pathOnly: string): never {
  throw new AppError(403, 'unsupported', `Engine call ${m} ${pathOnly} is not on the allow-list`);
}

/**
 * Decides whether an Engine API request may leave the process. Pure function: easy to test.
 * Reads (GET/HEAD) always pass; mutations need read-write mode, a matching permit and an
 * allow-listed (method, path) pair. Allowed: container lifecycle by full ID; image pull, tag and
 * untag/remove by name; container create + rename and network attach (standalone clone). Each needs a
 * permit naming exactly that target. Image removal is never forced.
 */
export function checkEngineRequest(
  method: string,
  rawPath: string,
  guard: Pick<Guard, 'readOnlyReason'>,
  permit: MutationPermit | undefined,
): void {
  const m = method.toUpperCase();
  if (!MUTATING_METHODS.has(m)) return;
  const ro = guard.readOnlyReason;
  if (ro) throw new AppError(409, 'read_only', `Read-only mode: ${ro}`);
  const pathOnly = (rawPath.split('?')[0] ?? '').replace(/^\/v\d+(\.\d+)?(?=\/)/, '');
  const q = new URLSearchParams(rawPath.split('?')[1] ?? '');
  const kind = permit && 'kind' in permit ? permit.kind : undefined;
  let mm: RegExpExecArray | null;

  // ---- images
  if (m === 'POST' && pathOnly === '/images/create') {
    if (!permit || kind !== 'image_pull') return denyPermit(m, pathOnly);
    const p = permit as Extract<EnginePermit, { kind: 'image_pull' }>;
    if (q.get('fromImage') !== p.repo || q.get('tag') !== p.tag) return denyPermit(m, pathOnly);
    return;
  }
  if (m === 'POST' && (mm = IMAGE_TAG.exec(pathOnly))) {
    if (!permit || kind !== 'image_tag') return denyPermit(m, pathOnly);
    const p = permit as Extract<EnginePermit, { kind: 'image_tag' }>;
    if (decode(mm[1] ?? '') !== p.imageId || q.get('repo') !== p.repo || q.get('tag') !== p.tag)
      return denyPermit(m, pathOnly);
    return;
  }
  if (m === 'DELETE' && !CONTAINER_DELETE.test(pathOnly) && (mm = IMAGE_DELETE.exec(pathOnly))) {
    if (!permit || kind !== 'image_remove') return notAllowListed(m, pathOnly);
    const p = permit as Extract<EnginePermit, { kind: 'image_remove' }>;
    if (decode(mm[1] ?? '') !== p.name || q.get('force') === 'true' || q.get('force') === '1')
      return denyPermit(m, pathOnly);
    return;
  }

  // ---- containers: create / rename (standalone clone, RT-12)
  if (m === 'POST' && pathOnly === '/containers/create') {
    if (!permit || kind !== 'container_create') return denyPermit(m, pathOnly);
    if (q.get('name') !== (permit as Extract<EnginePermit, { kind: 'container_create' }>).name)
      return denyPermit(m, pathOnly);
    return;
  }
  if (m === 'POST' && (mm = CONTAINER_RENAME.exec(pathOnly))) {
    if (!permit || kind !== 'container_rename') return denyPermit(m, pathOnly);
    const p = permit as Extract<EnginePermit, { kind: 'container_rename' }>;
    if (mm[1] !== p.containerId || q.get('name') !== p.newName) return denyPermit(m, pathOnly);
    return;
  }
  if (m === 'POST' && (mm = CONTAINER_UPDATE.exec(pathOnly))) {
    // only the restart policy of a kept `-qm-old-` container is ever changed this way (RT-12)
    if (!permit || kind !== 'container_restart_policy') return denyPermit(m, pathOnly);
    if (mm[1] !== (permit as Extract<EnginePermit, { kind: 'container_restart_policy' }>).containerId)
      return denyPermit(m, pathOnly);
    return;
  }
  if (m === 'POST' && (mm = NETWORK_ATTACH.exec(pathOnly))) {
    if (!permit || (kind !== 'network_connect' && kind !== 'network_disconnect'))
      return denyPermit(m, pathOnly);
    const p = permit as Extract<EnginePermit, { kind: 'network_connect' | 'network_disconnect' }>;
    if (kind !== `network_${mm[2]}` || decode(mm[1] ?? '') !== p.network) return denyPermit(m, pathOnly);
    return;
  }

  // ---- containers: lifecycle by full ID
  let id: string | undefined;
  let action: ContainerAction | undefined;
  mm = CONTAINER_POST.exec(pathOnly);
  if (m === 'POST' && mm) {
    id = mm[1];
    action = mm[2] as ContainerAction;
  } else if (m === 'DELETE' && (mm = CONTAINER_DELETE.exec(pathOnly))) {
    id = mm[1];
    action = 'remove';
  }
  if (!id || !action) return notAllowListed(m, pathOnly);
  const cp = permit && !kind ? (permit as ContainerPermit) : undefined;
  if (!cp || cp.containerId !== id || cp.action !== action) return denyPermit(m, pathOnly);
}

interface ModemLike {
  dial: (
    options: { method?: string; path?: string; options?: Record<string, unknown> },
    callback: (err: unknown, data?: unknown) => void,
  ) => void;
}

/** Wraps a dockerode modem so every request passes `checkEngineRequest` before any network I/O. */
export function enforceOnModem(modem: ModemLike, guard: Pick<Guard, 'readOnlyReason'>): void {
  const original = modem.dial.bind(modem);
  modem.dial = (options, callback) => {
    try {
      checkEngineRequest(
        options.method ?? 'GET',
        withQuery(options.path ?? '', options.options),
        guard,
        permitStore.getStore(),
      );
    } catch (e) {
      callback(e);
      return;
    }
    original(options, callback);
  };
}

/** docker-modem keeps query parameters in `options.options`; the allow-list must see them too. */
export function withQuery(path: string, query: Record<string, unknown> | undefined): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || typeof v === 'object') continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  if (!s) return path;
  return path.includes('?') ? `${path}${path.endsWith('?') ? '' : '&'}${s}` : `${path}?${s}`;
}
