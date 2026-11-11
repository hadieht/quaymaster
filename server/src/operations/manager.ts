import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { OperationInfo } from '@quaymaster/shared';
import type { OperationsRepo } from '../db/operations.js';
import { globalScrubber, redactText } from '../redaction/redact.js';
import { conflict } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

export type OperationEvent =
  | { type: 'output'; text: string }
  | { type: 'status'; status: 'running' | 'succeeded' | 'failed'; error: string | null };

export interface OperationContext {
  id: string;
  /** Appends scrubbed output to the operation record and its live stream. */
  log(text: string): void;
  setComposeVersion(v: string): void;
  /** True once a graceful shutdown started: long runs must not begin new steps (RT-14). */
  readonly shuttingDown: boolean;
}

interface Live {
  emitter: EventEmitter;
  buffer: string;
  done: boolean;
}

const BUFFER_CAP = 256 * 1024;

/**
 * Tracks long-running operations (Compose runs): persisted record, live output for SSE, and a
 * per-key lock so two operations on the same project never overlap.
 */
export class OperationManager {
  private readonly live = new Map<string, Live>();
  private readonly locks = new Map<string, string>();
  private shuttingDown = false;

  constructor(
    private readonly repo: OperationsRepo,
    private readonly log: Logger,
  ) {}

  /** Unfinished operations at startup are marked interrupted, never resumed (spec 7.4). */
  recover(): number {
    return this.repo.markInterrupted();
  }

  busy(): boolean {
    return this.locks.size > 0;
  }

  /**
   * Starts `fn` in the background and returns the operation id immediately. `lockKey` serialises
   * operations on the same target; a second one is rejected with 409.
   */
  start(op: {
    /** Use a pre-allocated id (maintenance runs share their id with the operation record). */
    id?: string;
    kind: string;
    target: string;
    actor: string;
    params: unknown;
    lockKey: string;
    composeVersion?: string | null;
    run: (ctx: OperationContext) => Promise<void>;
  }): string {
    if (this.shuttingDown) throw conflict('conflict', 'Quaymaster is shutting down');
    const holder = this.locks.get(op.lockKey);
    if (holder)
      throw conflict('conflict', `Another operation (${holder}) is already running on ${op.lockKey}`);
    const id = op.id ?? randomUUID();
    this.locks.set(op.lockKey, id);
    this.repo.create({
      id,
      kind: op.kind,
      target: op.target,
      actor: op.actor,
      params: op.params,
      composeVersion: op.composeVersion ?? null,
    });
    const live: Live = { emitter: new EventEmitter(), buffer: '', done: false };
    live.emitter.setMaxListeners(50);
    this.live.set(id, live);

    const isShuttingDown = (): boolean => this.shuttingDown;
    const ctx: OperationContext = {
      id,
      get shuttingDown(): boolean {
        return isShuttingDown();
      },
      log: (text) => {
        const clean = redactText(globalScrubber.scrub(text));
        if (!clean) return;
        try {
          this.repo.appendOutput(id, clean);
        } catch (e) {
          this.log.error({ err: e }, 'could not persist operation output');
        }
        live.buffer = (live.buffer + clean).slice(-BUFFER_CAP);
        live.emitter.emit('event', { type: 'output', text: clean } satisfies OperationEvent);
      },
      setComposeVersion: () => undefined,
    };

    void (async () => {
      let error: string | null = null;
      try {
        await op.run(ctx);
      } catch (e) {
        error = redactText(globalScrubber.scrub((e as Error).message));
        ctx.log(`\nERROR: ${error}\n`);
      }
      this.repo.finish(id, error ? 'failed' : 'succeeded', error);
      live.done = true;
      live.emitter.emit('event', {
        type: 'status',
        status: error ? 'failed' : 'succeeded',
        error,
      } satisfies OperationEvent);
      this.locks.delete(op.lockKey);
      setTimeout(() => this.live.delete(id), 60_000).unref();
    })();
    return id;
  }

  get(id: string): OperationInfo | undefined {
    return this.repo.get(id);
  }

  list(limit = 50): OperationInfo[] {
    return this.repo.list(limit);
  }

  /** Subscribes to live events; replays buffered output first. Returns an unsubscribe function. */
  subscribe(id: string, cb: (e: OperationEvent) => void): (() => void) | null {
    const info = this.repo.get(id);
    if (!info) return null;
    const live = this.live.get(id);
    if (!live) {
      // finished earlier (or before a restart): replay from the database
      if (info.output) cb({ type: 'output', text: info.output });
      cb({ type: 'status', status: info.status, error: info.error });
      return () => undefined;
    }
    if (live.buffer) cb({ type: 'output', text: live.buffer });
    if (live.done) {
      cb({ type: 'status', status: info.status, error: info.error });
      return () => undefined;
    }
    live.emitter.on('event', cb);
    return () => live.emitter.off('event', cb);
  }

  /** Graceful shutdown: refuse new operations and wait for running ones (up to `timeoutMs`). */
  async drain(timeoutMs: number): Promise<void> {
    this.shuttingDown = true;
    const t0 = Date.now();
    while (this.locks.size > 0 && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 200));
  }
}
