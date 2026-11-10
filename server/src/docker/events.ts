import { EventEmitter } from 'node:events';
import type Dockerode from 'dockerode';
import type { DockerEventRecord } from '@quaymaster/shared';
import type { EventsRepo, NewEvent } from '../db/events.js';
import { globalScrubber, redactText } from '../redaction/redact.js';
import type { Logger } from '../util/logger.js';
import type { ContainerService } from './containers.js';
import { LABEL } from './model.js';

/** Actions persisted and streamed (RT-25). Everything else — notably exec_* healthcheck spam — is dropped. */
export const PERSISTED_ACTIONS = new Set([
  'create',
  'start',
  'die',
  'oom',
  'kill',
  'stop',
  'restart',
  'pause',
  'unpause',
  'destroy',
  'health_status',
  'rename',
  'pull',
  'delete',
  'tag',
  'untag',
]);
const EVENT_TYPES = ['container', 'image', 'volume', 'network'];

/** Raw `/events` message shape. */
export interface RawDockerEvent {
  Type?: string;
  Action?: string;
  status?: string;
  Actor?: { ID?: string; Attributes?: Record<string, string> };
  time?: number;
  timeNano?: number;
}

/**
 * Reduces a raw Engine event to the allow-listed shape (RT-04/RT-25). Raw events carry the full
 * exec command line in `Action` and every container label in `Actor.Attributes`; neither leaves
 * this function. Returns null for events that must not be stored or shown.
 */
export function sanitizeEvent(ev: RawDockerEvent): NewEvent | null {
  const type = ev.Type ?? '';
  if (!EVENT_TYPES.includes(type)) return null;
  const rawAction = ev.Action ?? ev.status ?? '';
  const action = rawAction.split(':')[0]?.trim() ?? '';
  if (action.startsWith('exec_') || !PERSISTED_ACTIONS.has(action)) return null;
  const a = ev.Actor?.Attributes ?? {};
  const attributes: Record<string, string> = {};
  if (action === 'health_status') {
    const m = /health_status:\s*(\w+)/.exec(rawAction);
    if (m?.[1]) attributes['health'] = m[1];
  }
  for (const k of ['exitCode', 'signal', 'oldName']) {
    if (a[k] !== undefined) attributes[k] = clean(a[k]);
  }
  const ts = ev.timeNano ? Math.floor(ev.timeNano / 1e6) : (ev.time ?? Math.floor(Date.now() / 1000)) * 1000;
  return {
    ts,
    type,
    action,
    actorId: ev.Actor?.ID ?? '',
    name: a['name'] !== undefined ? clean(a['name']) : null,
    image: a['image'] !== undefined ? clean(a['image']) : null,
    project: a[LABEL.project] ?? null,
    service: a[LABEL.service] ?? null,
    attributes,
    synthetic: false,
  };
}

const clean = (s: string): string => redactText(globalScrubber.scrub(s));

interface Known {
  state: string;
  name: string;
  project: string | null;
  service: string | null;
  image: string;
}

/** Derives synthetic "missed event" records by diffing two container inventories (RT-25). */
export function diffInventories(
  before: Map<string, Known>,
  after: Map<string, Known>,
  now: number,
): NewEvent[] {
  const out: NewEvent[] = [];
  const mk = (id: string, k: Known, action: string, extra: Record<string, string> = {}): NewEvent => ({
    ts: now,
    type: 'container',
    action,
    actorId: id,
    name: k.name,
    image: k.image,
    project: k.project,
    service: k.service,
    attributes: { missed: 'true', ...extra },
    synthetic: true,
  });
  for (const [id, k] of before) {
    const n = after.get(id);
    if (!n) out.push(mk(id, k, 'destroy'));
    else if (k.state !== n.state) {
      if (n.state === 'running') out.push(mk(id, n, 'start'));
      else if (n.state === 'exited' || n.state === 'dead') out.push(mk(id, n, 'die', { state: n.state }));
      else if (n.state === 'paused') out.push(mk(id, n, 'pause'));
    }
  }
  for (const [id, k] of after) if (!before.has(id)) out.push(mk(id, k, 'create'));
  return out;
}

export interface EventWatcherDeps {
  docker: Dockerode;
  repo: EventsRepo;
  containers: ContainerService;
  log: Logger;
  /** Optional hook for tests: backoff schedule in ms. */
  backoffMs?: number[];
}

/**
 * One long-lived `/events` stream with reconnect + backoff. After every reconnect a full inventory
 * re-sync synthesises state-change records for events the daemon's small replay buffer lost.
 * Persistence is batched; fan-out happens through the `event` EventEmitter signal.
 */
export class EventWatcher extends EventEmitter {
  private stopped = true;
  private stream: NodeJS.ReadableStream | null = null;
  private known = new Map<string, Known>();
  private lastSeenSec = Math.floor(Date.now() / 1000);
  private pending: NewEvent[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private recent = new Set<string>();
  connected = false;

  constructor(private readonly d: EventWatcherDeps) {
    super();
  }

  async start(): Promise<void> {
    this.stopped = false;
    const last = this.d.repo.lastTimestamp();
    if (last) this.lastSeenSec = Math.floor(last / 1000);
    await this.snapshot(false).catch((e: unknown) => this.d.log.warn({ err: e }, 'initial inventory snapshot failed'));
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.connected = false;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.flushTimer);
    const s = this.stream as (NodeJS.ReadableStream & { destroy?: () => void }) | null;
    s?.destroy?.();
    this.stream = null;
    this.flush();
  }

  private async snapshot(emitDiff: boolean): Promise<void> {
    const list = await this.d.containers.listRaw(true);
    const after = new Map<string, Known>();
    for (const c of list) {
      after.set(c.Id, {
        state: c.State,
        name: (c.Names?.[0] ?? '').replace(/^\//, ''),
        project: c.Labels?.[LABEL.project] ?? null,
        service: c.Labels?.[LABEL.service] ?? null,
        image: c.Image,
      });
    }
    if (emitDiff) {
      for (const e of diffInventories(this.known, after, Date.now())) this.enqueue(e);
    }
    this.known = after;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const stream = (await this.d.docker.getEvents({
        since: this.lastSeenSec - 1,
        filters: JSON.stringify({ type: EVENT_TYPES }),
      } as never)) as unknown as NodeJS.ReadableStream;
      this.stream = stream;
      this.connected = true;
      this.attempt = 0;
      let buf = '';
      stream.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) this.onLine(line);
        }
        if (buf.length > 1_000_000) buf = '';
      });
      const lost = (why: string) => () => {
        if (this.stream !== stream) return;
        this.stream = null;
        this.connected = false;
        this.d.log.warn({ why }, 'docker event stream lost');
        this.scheduleReconnect();
      };
      stream.on('end', lost('end'));
      stream.on('close', lost('close'));
      stream.on('error', lost('error'));
    } catch (e) {
      this.connected = false;
      this.d.log.warn({ err: e }, 'cannot open docker event stream');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const schedule = this.d.backoffMs ?? [1000, 2000, 5000, 10000, 30000];
    const wait = schedule[Math.min(this.attempt++, schedule.length - 1)] ?? 30000;
    this.reconnectTimer = setTimeout(() => {
      void (async () => {
        await this.snapshot(true).catch((e: unknown) => this.d.log.warn({ err: e }, 'resync after reconnect failed'));
        await this.connect();
      })();
    }, wait);
    this.reconnectTimer.unref();
  }

  private onLine(line: string): void {
    let raw: RawDockerEvent;
    try {
      raw = JSON.parse(line) as RawDockerEvent;
    } catch {
      return;
    }
    if (raw.time) this.lastSeenSec = Math.max(this.lastSeenSec, raw.time);
    if (raw.Type === 'container') this.d.containers.invalidate();
    const key = `${raw.timeNano ?? raw.time}|${raw.Actor?.ID}|${raw.Action ?? raw.status}`;
    if (this.recent.has(key)) return; // overlap from `since` on reconnect
    this.recent.add(key);
    if (this.recent.size > 2000) this.recent.delete(this.recent.values().next().value as string);
    const ev = sanitizeEvent(raw);
    if (ev) this.enqueue(ev);
  }

  private enqueue(e: NewEvent): void {
    this.pending.push(e);
    if (this.pending.length >= 100) this.flush();
    else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 1000);
      this.flushTimer.unref();
    }
  }

  flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    try {
      const ids = this.d.repo.insertMany(batch);
      batch.forEach((b, i) => {
        const rec: DockerEventRecord = { ...b, id: ids[i] ?? 0, time: new Date(b.ts).toISOString() };
        this.emit('event', rec);
      });
    } catch (e) {
      this.d.log.error({ err: e }, 'failed to persist events');
    }
  }
}
