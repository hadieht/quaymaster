import type Dockerode from 'dockerode';
import type { ActionRequest, ContainerAction, ContainerSummary } from '@quaymaster/shared';
import type { AuditService } from '../audit/audit.js';
import { audited } from '../audit/audit.js';
import type { Config } from '../config/env.js';
import { redactDeep } from '../redaction/redact.js';
import { type Guard, withPermit } from '../security/guard.js';
import { AppError, badRequest, conflict, notFound } from '../util/errors.js';
import { cleanLogLine, demuxBuffer, LogDemuxer, type LogLine, RateLimitedPump } from './logs.js';
import { LABEL, learnSecrets, SAFE_REF_RE, toSummary } from './model.js';

export interface Actor {
  name: string;
  ip: string | null;
}

export const SYSTEM_ACTOR: Actor = { name: 'system', ip: null };

export interface ResolvedContainer {
  id: string;
  name: string;
  project: string | null;
  service: string | null;
  raw: Dockerode.ContainerInspectInfo;
}

/** Implemented by the Compose service: recreates one Compose-managed container (never via clone). */
export interface Recreator {
  recreate(c: ResolvedContainer, req: ActionRequest, actor: Actor): Promise<{ operationId: string }>;
}

export const CONTAINER_ACTIONS: readonly ContainerAction[] = [
  'start',
  'stop',
  'restart',
  'kill',
  'pause',
  'unpause',
  'remove',
  'recreate',
];

export function mapDockerError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const err = e as { statusCode?: number; message?: string; code?: string };
  if (err.statusCode === 404) return notFound('Docker resource');
  if (err.statusCode === 409) return conflict('conflict', err.message ?? 'Conflict');
  if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED' || err.code === 'EACCES') {
    return new AppError(503, 'docker_unavailable', `Docker daemon unreachable: ${err.code}`);
  }
  return new AppError(502, 'internal', `Docker error: ${err.message ?? 'unknown'}`);
}

export class ContainerService {
  private cache: { at: number; value: Dockerode.ContainerInfo[] } | null = null;
  private inflight: Promise<Dockerode.ContainerInfo[]> | null = null;
  private recreator: Recreator | null = null;
  static readonly CACHE_MS = 2500;

  constructor(
    private readonly d: {
      docker: Dockerode;
      guard: Guard;
      audit: AuditService;
      config: Pick<Config, 'redactAllEnv' | 'sse'>;
    },
  ) {}

  setRecreator(r: Recreator): void {
    this.recreator = r;
  }

  invalidate(): void {
    this.cache = null;
  }

  /** Raw list (all containers incl. stopped) with a short cache and single-flight refresh. */
  async listRaw(fresh = false): Promise<Dockerode.ContainerInfo[]> {
    if (!fresh && this.cache && Date.now() - this.cache.at < ContainerService.CACHE_MS)
      return this.cache.value;
    if (this.inflight) return this.inflight;
    this.inflight = this.d.docker
      .listContainers({ all: true })
      .then((v) => {
        this.cache = { at: Date.now(), value: v };
        return v;
      })
      .catch((e) => {
        throw mapDockerError(e);
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  async list(): Promise<ContainerSummary[]> {
    return (await this.listRaw()).map((c) => toSummary(c, this.d.guard));
  }

  private extrasCache = new Map<string, { at: number; restartCount: number; startedAt: string | null }>();

  /**
   * Restart count and start time are only in `inspect`, so they are fetched with a short cache
   * (the list endpoint is polled by the UI). Failures are skipped: the fields are optional.
   */
  async extras(ids: string[]): Promise<Map<string, { restartCount: number; startedAt: string | null }>> {
    const now = Date.now();
    const out = new Map<string, { restartCount: number; startedAt: string | null }>();
    const todo: string[] = [];
    for (const id of ids) {
      const hit = this.extrasCache.get(id);
      if (hit && now - hit.at < 15_000) out.set(id, hit);
      else todo.push(id);
    }
    for (let i = 0; i < todo.length; i += 8) {
      await Promise.all(
        todo.slice(i, i + 8).map(async (id) => {
          try {
            const r = await this.d.docker.getContainer(id).inspect();
            const e = {
              at: now,
              restartCount: r.RestartCount ?? 0,
              startedAt: r.State?.StartedAt && !r.State.StartedAt.startsWith('0001') ? r.State.StartedAt : null,
            };
            this.extrasCache.set(id, e);
            out.set(id, e);
          } catch {
            this.extrasCache.delete(id);
          }
        }),
      );
    }
    for (const id of this.extrasCache.keys()) if (!ids.includes(id)) this.extrasCache.delete(id);
    return out;
  }

  /** Resolves any user-supplied reference to the full ID via inspect (RT-03: resolve → check → act). */
  async resolve(ref: string): Promise<ResolvedContainer> {
    if (!SAFE_REF_RE.test(ref) || ref.startsWith('-')) throw badRequest('Invalid container reference');
    let raw: Dockerode.ContainerInspectInfo;
    try {
      raw = await this.d.docker.getContainer(ref).inspect();
    } catch (e) {
      const m = mapDockerError(e);
      throw m.code === 'not_found' ? notFound('Container') : m;
    }
    learnSecrets(raw.Config, this.d.config.redactAllEnv);
    const labels = raw.Config?.Labels ?? {};
    return {
      id: raw.Id,
      name: raw.Name.replace(/^\//, ''),
      project: labels[LABEL.project] ?? null,
      service: labels[LABEL.service] ?? null,
      raw,
    };
  }

  /** Inspect output with every secret redacted at every depth (RT-04). */
  async inspect(ref: string): Promise<{ summary: ContainerSummary | null; inspect: unknown }> {
    const r = await this.resolve(ref);
    const summary = (await this.listRaw()).find((c) => c.Id === r.id);
    return {
      summary: summary ? toSummary(summary, this.d.guard) : null,
      inspect: redactDeep(r.raw, { redactAllEnv: this.d.config.redactAllEnv }),
    };
  }

  // ---- logs -------------------------------------------------------------------------------

  async logsTail(
    ref: string,
    opts: { tail?: number; since?: number; timestamps?: boolean } = {},
  ): Promise<LogLine[]> {
    const r = await this.resolve(ref);
    const tail = Math.min(Math.max(opts.tail ?? 200, 1), 5000);
    const buf = await this.d.docker
      .getContainer(r.id)
      .logs({
        follow: false,
        stdout: true,
        stderr: true,
        tail,
        since: opts.since,
        timestamps: opts.timestamps ?? true,
      })
      .catch((e: unknown) => {
        throw mapDockerError(e);
      });
    const lines = demuxBuffer(buf as Buffer, r.raw.Config.Tty === true, opts.timestamps ?? true).map(
      cleanLogLine,
    );
    // cap the response at ~2 MiB
    let size = 0;
    const out: LogLine[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      size += (lines[i]?.text.length ?? 0) + 40;
      if (size > 2 * 1024 * 1024) break;
      out.unshift(lines[i] as LogLine);
    }
    return out;
  }

  /** Follows logs; calls `onLine` for each cleaned line. Rate-limited with back-pressure. */
  async logsFollow(
    ref: string,
    opts: { tail?: number; timestamps?: boolean },
    onLine: (l: LogLine) => void,
    onEnd: () => void,
  ): Promise<{ close(): void }> {
    const r = await this.resolve(ref);
    const stream = (await this.d.docker
      .getContainer(r.id)
      .logs({
        follow: true,
        stdout: true,
        stderr: true,
        tail: Math.min(Math.max(opts.tail ?? 100, 0), 2000),
        timestamps: opts.timestamps ?? true,
      })
      .catch((e: unknown) => {
        throw mapDockerError(e);
      })) as NodeJS.ReadableStream & { destroy?: () => void };
    const demux = new LogDemuxer(r.raw.Config.Tty === true, opts.timestamps ?? true, (l) =>
      onLine(cleanLogLine(l)),
    );
    const pump = new RateLimitedPump(stream as never, this.d.config.sse.logBytesPerSec);
    stream.on('data', (chunk: Buffer) => {
      pump.account(chunk.length);
      demux.push(chunk);
    });
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      demux.flush();
      pump.stop();
      onEnd();
    };
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', finish);
    return {
      close: () => {
        pump.stop();
        ended = true;
        stream.destroy?.();
      },
    };
  }

  // ---- actions ----------------------------------------------------------------------------

  async act(
    ref: string,
    action: ContainerAction,
    req: ActionRequest,
    actor: Actor,
  ): Promise<{ ok: true; operationId?: string; note?: string }> {
    if (!CONTAINER_ACTIONS.includes(action)) throw badRequest(`Unknown action "${action}"`);
    const base = {
      actor: actor.name,
      ip: actor.ip,
      action: `container.${action}`,
      target: ref,
      params: { ...req },
    };
    return audited(this.d.audit, base, async () => {
      const c = await this.resolve(ref);
      // identity is now known: record the real target, not what the caller typed
      base.target = `${c.name} (${c.id.slice(0, 12)})`;
      this.d.guard.assertContainer({ id: c.id, name: c.name, project: c.project }, action);

      if ((action === 'remove' || action === 'recreate') && req.confirm !== c.name) {
        throw new AppError(409, 'confirmation_required', `Confirm by sending {"confirm":"${c.name}"}`, {
          expected: c.name,
        });
      }
      if (action === 'kill' && req.signal !== undefined && !/^(SIG)?[A-Z0-9]{1,10}$/.test(req.signal)) {
        throw badRequest('Invalid signal');
      }

      if (action === 'recreate') {
        if (!c.project) {
          throw new AppError(
            409,
            'unsupported',
            'Recreating a standalone container (config clone) is not available yet; it arrives with the update workflow (RT-12). Compose-managed containers can be recreated.',
          );
        }
        if (!this.recreator) throw new AppError(500, 'internal', 'Compose service is not available');
        const res = await this.recreator.recreate(c, req, actor);
        this.invalidate();
        return { ok: true as const, operationId: res.operationId };
      }

      // destructive: make sure the ID still carries the name we checked (another tool may have renamed it)
      if (action === 'remove' || action === 'kill') {
        const again = await this.resolve(c.id);
        if (again.name !== c.name)
          throw conflict('conflict', 'Container was renamed while the action was pending');
      }

      const handle = this.d.docker.getContainer(c.id);
      const timeout =
        req.timeoutSeconds !== undefined ? Math.min(Math.max(req.timeoutSeconds, 0), 600) : undefined;
      let note: string | undefined;
      try {
        await withPermit({ containerId: c.id, action }, async () => {
          switch (action) {
            case 'start':
              return handle.start();
            case 'stop':
              return handle.stop(timeout !== undefined ? { t: timeout } : {});
            case 'restart':
              return handle.restart(timeout !== undefined ? { t: timeout } : {});
            case 'kill':
              return handle.kill(req.signal ? { signal: req.signal } : {});
            case 'pause':
              return handle.pause();
            case 'unpause':
              return handle.unpause();
            case 'remove':
              // never force, never remove volumes
              return handle.remove({ force: false, v: false });
          }
        });
      } catch (e) {
        if ((e as { statusCode?: number }).statusCode === 304) note = 'already in requested state';
        else throw mapDockerError(e);
      }
      this.invalidate();
      return { ok: true as const, ...(note ? { note } : {}) };
    }).catch((e) => {
      throw mapDockerError(e);
    });
  }
}
