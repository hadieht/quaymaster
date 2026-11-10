import { EventEmitter } from 'node:events';
import type Dockerode from 'dockerode';
import type { StatsPoint } from '@quaymaster/shared';
import type { RollupRow, StatsRepo } from '../db/stats.js';
import type { Logger } from '../util/logger.js';
import type { ContainerService } from './containers.js';

/** Subset of the Engine `stats` payload we read. */
export interface RawStats {
  read: string;
  cpu_stats?: { cpu_usage?: { total_usage?: number }; online_cpus?: number; system_cpu_usage?: number };
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> };
  networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
  blkio_stats?: { io_service_bytes_recursive?: { op: string; value: number }[] | null };
}

export interface Sample extends StatsPoint {
  cpuTotalNs: number;
}

/** Memory excluding reclaimable page cache (inactive file), as `docker stats` reports it. */
export function memoryUsage(s: RawStats): number {
  const usage = s.memory_stats?.usage ?? 0;
  const st = s.memory_stats?.stats ?? {};
  const cache = st['inactive_file'] ?? st['total_inactive_file'] ?? st['cache'] ?? 0;
  return Math.max(0, usage - cache);
}

/**
 * One-shot stats carry no `precpu`, so CPU % comes from our own previous sample of the same
 * container (RT-26): delta(container CPU ns) / delta(wall ns) × 100 — percent of one core.
 */
export function toSample(s: RawStats, prev: Sample | undefined): Sample {
  const t = Date.parse(s.read);
  const cpuTotalNs = s.cpu_stats?.cpu_usage?.total_usage ?? 0;
  let cpu = 0;
  if (prev && t > prev.t && cpuTotalNs >= prev.cpuTotalNs) {
    cpu = ((cpuTotalNs - prev.cpuTotalNs) / ((t - prev.t) * 1e6)) * 100;
  }
  let rx = 0;
  let tx = 0;
  for (const n of Object.values(s.networks ?? {})) {
    rx += n.rx_bytes;
    tx += n.tx_bytes;
  }
  let br = 0;
  let bw = 0;
  for (const e of s.blkio_stats?.io_service_bytes_recursive ?? []) {
    const op = e.op.toLowerCase();
    if (op === 'read') br += e.value;
    else if (op === 'write') bw += e.value;
  }
  return {
    t,
    cpu: Math.round(cpu * 100) / 100,
    memUsage: memoryUsage(s),
    memLimit: s.memory_stats?.limit ?? 0,
    netRx: rx,
    netTx: tx,
    blkRead: br,
    blkWrite: bw,
    cpuTotalNs,
  };
}

interface Acc {
  minute: number;
  name: string;
  n: number;
  cpuSum: number;
  cpuMax: number;
  memSum: number;
  memMax: number;
  last: Sample;
}

export function accToRow(id: string, a: Acc): RollupRow {
  return {
    container_id: id,
    minute: a.minute,
    name: a.name,
    samples: a.n,
    cpu_avg: a.cpuSum / a.n,
    cpu_max: a.cpuMax,
    mem_avg: a.memSum / a.n,
    mem_max: a.memMax,
    net_rx: a.last.netRx,
    net_tx: a.last.netTx,
    blk_read: a.last.blkRead,
    blk_write: a.last.blkWrite,
  };
}

export const RING_SIZE = 360;

export class StatsSampler extends EventEmitter {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly prev = new Map<string, Sample>();
  private readonly ring = new Map<string, StatsPoint[]>();
  private readonly acc = new Map<string, Acc>();

  constructor(
    private readonly d: {
      docker: Dockerode;
      containers: ContainerService;
      repo: StatsRepo;
      intervalMs: number;
      log: Logger;
      concurrency?: number;
      paused?: () => boolean;
    },
  ) {
    super();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.d.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.flushRollups(true);
  }

  history(id: string): StatsPoint[] {
    return this.ring.get(id) ?? [];
  }

  latest(): Record<string, StatsPoint> {
    const out: Record<string, StatsPoint> = {};
    for (const [id, pts] of this.ring) {
      const last = pts[pts.length - 1];
      if (last) out[id] = last;
    }
    return out;
  }

  /** Samples all running containers once. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.running || this.d.paused?.()) return;
    this.running = true;
    try {
      const list = (await this.d.containers.listRaw(true)).filter((c) => c.State === 'running');
      const alive = new Set(list.map((c) => c.Id));
      for (const id of [...this.prev.keys()]) if (!alive.has(id)) this.prev.delete(id);
      for (const id of [...this.ring.keys()]) if (!alive.has(id)) this.ring.delete(id);
      const queue = [...list];
      const worker = async (): Promise<void> => {
        for (let c = queue.shift(); c; c = queue.shift()) {
          try {
            const raw = (await this.d.docker
              .getContainer(c.Id)
              .stats({ stream: false, 'one-shot': true } as never)) as unknown as RawStats;
            this.record(c.Id, (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''), raw);
          } catch (e) {
            this.d.log.debug({ err: e, id: c.Id.slice(0, 12) }, 'stats sample failed');
          }
        }
      };
      await Promise.all(Array.from({ length: this.d.concurrency ?? 2 }, worker));
      this.flushRollups(false);
    } catch (e) {
      this.d.log.warn({ err: e }, 'stats tick failed');
    } finally {
      this.running = false;
    }
  }

  record(id: string, name: string, raw: RawStats): void {
    const sample = toSample(raw, this.prev.get(id));
    const first = !this.prev.has(id);
    this.prev.set(id, sample);
    if (first) return; // CPU needs two samples; skip the first point
    const { cpuTotalNs: _c, ...point } = sample;
    const pts = this.ring.get(id) ?? [];
    pts.push(point);
    if (pts.length > RING_SIZE) pts.shift();
    this.ring.set(id, pts);
    const minute = Math.floor(sample.t / 60_000);
    let a = this.acc.get(id);
    if (a && a.minute !== minute) {
      this.d.repo.upsertMany([accToRow(id, a)]);
      a = undefined;
    }
    if (!a) a = { minute, name, n: 0, cpuSum: 0, cpuMax: 0, memSum: 0, memMax: 0, last: sample };
    a.n++;
    a.cpuSum += sample.cpu;
    a.cpuMax = Math.max(a.cpuMax, sample.cpu);
    a.memSum += sample.memUsage;
    a.memMax = Math.max(a.memMax, sample.memUsage);
    a.last = sample;
    this.acc.set(id, a);
    this.emit('sample', { id, name, point });
  }

  /** Persists accumulators of finished minutes (or all of them when `all`). */
  flushRollups(all: boolean): void {
    const nowMin = Math.floor(Date.now() / 60_000);
    const rows: RollupRow[] = [];
    for (const [id, a] of this.acc) {
      if (all || a.minute < nowMin) {
        rows.push(accToRow(id, a));
        if (a.minute < nowMin || all) this.acc.delete(id);
      }
    }
    if (rows.length) {
      try {
        this.d.repo.upsertMany(rows);
      } catch (e) {
        this.d.log.error({ err: e }, 'failed to persist stats roll-ups');
      }
    }
  }
}
