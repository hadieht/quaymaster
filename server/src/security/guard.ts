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
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
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
  private self: SelfInfo;

  constructor(private readonly opts: GuardOptions) {
    this.scopeRes = opts.scope.map(globToRegExp);
    this.protectedRes = opts.protectedNames.map(globToRegExp);
    this.self = opts.self ?? NO_SELF;
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
  containerRefusal(c: ContainerRef): { code: 'read_only' | 'out_of_scope' | 'self_protected'; message: string } | null {
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

  projectRefusal(project: string, refs?: ProjectRefs): { code: 'read_only' | 'out_of_scope' | 'self_protected'; message: string } | null {
    const ro = this.readOnlyReason;
    if (ro) return { code: 'read_only', message: `Read-only mode: ${ro}` };
    const prot = this.projectProtectedReason(project);
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

  assertProject(project: string, refs?: ProjectRefs): void {
    const r = this.projectRefusal(project, refs);
    if (r) throw new AppError(409, r.code, r.message);
  }

  /** Compose subcommand authorisation (RT-03): read-only mode allows only these. */
  static readonly COMPOSE_READ_ONLY = new Set(['config', 'ls', 'ps', 'images', 'version']);
  static readonly COMPOSE_MUTATING = new Set(['up', 'stop', 'start', 'restart', 'down', 'pull']);

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

export interface MutationPermit {
  /** Full 64-hex container ID the Engine call may touch. */
  containerId: string;
  action: ContainerAction;
}

export const permitStore = new AsyncLocalStorage<MutationPermit>();

export const FULL_ID_RE = /^[0-9a-f]{64}$/;

/** Runs `fn` with the authority to perform `permit.action` on exactly `permit.containerId`. */
export function withPermit<T>(permit: MutationPermit, fn: () => Promise<T>): Promise<T> {
  if (!FULL_ID_RE.test(permit.containerId)) {
    return Promise.reject(new AppError(500, 'internal', 'Permit requires a full container ID'));
  }
  return permitStore.run(permit, fn);
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

const CONTAINER_POST = /^\/containers\/([0-9a-f]{64})\/(start|stop|restart|kill|pause|unpause)$/;
const CONTAINER_DELETE = /^\/containers\/([0-9a-f]{64})$/;

/**
 * Decides whether an Engine API request may leave the process. Pure function: easy to test.
 * Reads (GET/HEAD) always pass; mutations need read-write mode, a matching permit and an
 * allow-listed (method, path) pair. Phase 1 permits only container lifecycle calls by full ID.
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
  let id: string | undefined;
  let action: ContainerAction | undefined;
  let mm = CONTAINER_POST.exec(pathOnly);
  if (m === 'POST' && mm) {
    id = mm[1];
    action = mm[2] as ContainerAction;
  } else if (m === 'DELETE' && (mm = CONTAINER_DELETE.exec(pathOnly))) {
    id = mm[1];
    action = 'remove';
  }
  if (!id || !action) {
    throw new AppError(403, 'unsupported', `Engine call ${m} ${pathOnly} is not on the allow-list`);
  }
  if (!permit || permit.containerId !== id || permit.action !== action) {
    throw new AppError(403, 'internal', `Engine mutation ${m} ${pathOnly} was not authorised by the service layer`);
  }
}

interface ModemLike {
  dial: (options: { method?: string; path?: string }, callback: (err: unknown, data?: unknown) => void) => void;
}

/** Wraps a dockerode modem so every request passes `checkEngineRequest` before any network I/O. */
export function enforceOnModem(modem: ModemLike, guard: Pick<Guard, 'readOnlyReason'>): void {
  const original = modem.dial.bind(modem);
  modem.dial = (options, callback) => {
    try {
      checkEngineRequest(options.method ?? 'GET', options.path ?? '', guard, permitStore.getStore());
    } catch (e) {
      callback(e);
      return;
    }
    original(options, callback);
  };
}
