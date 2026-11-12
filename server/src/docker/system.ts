import { readFileSync, statfsSync } from 'node:fs';
import os from 'node:os';
import type Dockerode from 'dockerode';
import type { HostMetrics, ReclaimReport } from '@quaymaster/shared';
import type { Config } from '../config/env.js';
import { redactDeep } from '../redaction/redact.js';
import { mapDockerError } from './containers.js';

type DfType = 'image' | 'container' | 'volume';

interface DfImages {
  Images?: { Id: string; Size: number; SharedSize: number; Containers: number }[];
  LayersSize?: number;
}
interface DfContainers {
  Containers?: { Id: string; SizeRw?: number; SizeRootFs?: number }[];
}
interface DfVolumes {
  Volumes?: { Name: string; UsageData?: { Size: number; RefCount: number } }[];
}

export interface DfMeasure {
  volumes: Record<string, number>;
  /** Per image: reported size and the part shared with other images (null = unknown). */
  images: Record<string, { size: number; shared: number | null }>;
  layersSize: number;
  volumesSize: number;
}

/**
 * Takes a `/system/df` + free-space snapshot around a removal and builds the report. Failure to
 * measure never fails the removal: the report then says it fell back to the estimate.
 */
export async function measureReclaim<T>(
  usage: Pick<DiskUsageService, 'measure'>,
  freeBytes: () => Promise<number | null>,
  run: (before: DfMeasure | null) => Promise<{
    value: T;
    estimatedBytes: number;
    /** Most this run can have freed (red-team RT3-06); omitted when unknown. */
    maxBytes?: number;
  }>,
): Promise<{ value: T; reclaim: ReclaimReport }> {
  const snap = async (): Promise<{ df: number | null; free: number | null; m: DfMeasure | null }> => {
    const [m, free] = await Promise.all([usage.measure().catch(() => null), freeBytes().catch(() => null)]);
    return { df: m ? m.layersSize + m.volumesSize : null, free, m };
  };
  const before = await snap();
  const { value, estimatedBytes, maxBytes } = await run(before.m);
  const after = await snap();
  const dfDelta = before.df !== null && after.df !== null ? Math.max(before.df - after.df, 0) : null;
  const freeDelta = before.free !== null && after.free !== null ? after.free - before.free : null;
  const basis: ReclaimReport['basis'] =
    dfDelta !== null ? 'df' : freeDelta !== null && freeDelta > 0 ? 'statfs' : 'estimate';
  const measured = basis === 'df' ? (dfDelta ?? 0) : basis === 'statfs' ? (freeDelta ?? 0) : estimatedBytes;
  // RT3-06: the before/after deltas are host-wide. Another prune, a volume deleted elsewhere or a pull that
  // finished during the run used to be reported as "reclaimed" by this run (3 GB shown for 0 removals). The
  // headline can never exceed what the removed items occupied; a low figure is flagged instead of hidden.
  const capped = maxBytes !== undefined && measured > maxBytes;
  const low = basis !== 'estimate' && !capped && measured < estimatedBytes;
  return {
    value,
    reclaim: {
      estimatedBytes,
      freeSpaceDeltaBytes: freeDelta,
      dfDeltaBytes: dfDelta,
      reclaimedBytes: capped ? (maxBytes ?? 0) : measured,
      basis,
      note:
        'Reclaimed = what Docker accounts for (image layers + volumes) before minus after, capped at the size of ' +
        'what was actually removed. Free-space change on the Docker root is shown too, but other processes writing ' +
        'to the disk make it noisy. Layers shared with other images are freed only when the last image using them ' +
        'is removed.',
      caveat: capped
        ? 'Docker usage dropped by more than the removed items occupied: other activity ran meanwhile, so the figure is capped.'
        : low
          ? 'Docker usage grew meanwhile (for example a pull), so the measured figure is lower than the estimate.'
          : null,
    },
  };
}

export interface DiskUsage {
  refreshedAt: string;
  images: { count: number; layersSize: number; totalSize: number; unusedCount: number };
  containers: Record<string, { sizeRw: number; sizeRootFs: number }>;
  volumes: Record<string, number>;
}

/**
 * `system df` data (RT-26): `/system/df` walks every volume, which can take minutes on big hosts, so
 * it is queried per type (never in parallel), single-flight, and refreshed at most every
 * QM_DF_MIN_INTERVAL_SECONDS unless an admin forces it (which is itself rate-limited to 60 s).
 */
export class DiskUsageService {
  private value: DiskUsage | null = null;
  private inflight: Promise<DiskUsage> | null = null;
  private lastStart = 0;

  constructor(
    private readonly d: { docker: Dockerode; config: Pick<Config, 'dfMinIntervalMs'>; busy?: () => boolean },
  ) {}

  cached(): DiskUsage | null {
    return this.value;
  }

  private dial<T>(type: DfType): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      (
        this.d.docker.modem as unknown as {
          dial(o: object, cb: (e: unknown, data: T) => void): void;
        }
      ).dial(
        {
          path: '/system/df?',
          method: 'GET',
          options: { type },
          statusCodes: { 200: true, 400: 'bad parameter', 500: 'server error' },
        },
        (e, data) => (e ? reject(mapDockerError(e)) : resolve(data)),
      );
    });
  }

  /**
   * Uncached `/system/df` for images and volumes (one request per type, sequential). Used by cleanup
   * previews (per-item sizes) and to measure what a removal actually freed. Slow on big hosts: only
   * call it for an explicit preview/removal, never from a poll.
   */
  async measure(): Promise<DfMeasure> {
    const images = await this.dial<DfImages>('image');
    const volumes = await this.dial<DfVolumes>('volume');
    const vol: Record<string, number> = {};
    for (const v of volumes.Volumes ?? [])
      if (v.UsageData && v.UsageData.Size >= 0) vol[v.Name] = v.UsageData.Size;
    const img: Record<string, { size: number; shared: number | null }> = {};
    for (const i of images.Images ?? [])
      img[i.Id] = { size: i.Size, shared: i.SharedSize >= 0 ? i.SharedSize : null };
    return {
      volumes: vol,
      images: img,
      layersSize: images.LayersSize ?? 0,
      volumesSize: Object.values(vol).reduce((s, n) => s + n, 0),
    };
  }

  async get(opts: { force?: boolean } = {}): Promise<DiskUsage | null> {
    const age = Date.now() - this.lastStart;
    const stale = !this.value || age > this.d.config.dfMinIntervalMs;
    const forced = opts.force === true && age > 60_000;
    if (!stale && !forced) return this.value;
    if (this.d.busy?.()) return this.value; // never during a maintenance run
    if (this.inflight) return this.inflight;
    this.lastStart = Date.now();
    this.inflight = (async () => {
      const images = await this.dial<DfImages>('image');
      const containers = await this.dial<DfContainers>('container');
      const volumes = await this.dial<DfVolumes>('volume');
      const v: DiskUsage = {
        refreshedAt: new Date().toISOString(),
        images: {
          count: images.Images?.length ?? 0,
          layersSize: images.LayersSize ?? 0,
          totalSize: (images.Images ?? []).reduce((s, i) => s + i.Size, 0),
          unusedCount: (images.Images ?? []).filter((i) => i.Containers === 0).length,
        },
        containers: Object.fromEntries(
          (containers.Containers ?? []).map((c) => [
            c.Id,
            { sizeRw: c.SizeRw ?? 0, sizeRootFs: c.SizeRootFs ?? 0 },
          ]),
        ),
        volumes: Object.fromEntries(
          (volumes.Volumes ?? [])
            .filter((x) => x.UsageData && x.UsageData.Size >= 0)
            .map((x) => [x.Name, x.UsageData?.Size ?? 0]),
        ),
      };
      this.value = v;
      return v;
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }
}

export class SystemService {
  private prevCpu: { idle: number; total: number; at: number } | null = null;

  constructor(
    private readonly d: {
      docker: Dockerode;
      config: Pick<Config, 'dockerRootMount' | 'redactAllEnv'>;
      meminfoPath?: string;
    },
  ) {}

  async info(): Promise<unknown> {
    try {
      return redactDeep(await this.d.docker.info(), { redactAllEnv: this.d.config.redactAllEnv });
    } catch (e) {
      throw mapDockerError(e);
    }
  }

  async dockerRootDir(): Promise<string | null> {
    try {
      return ((await this.d.docker.info()) as { DockerRootDir?: string }).DockerRootDir ?? null;
    } catch {
      return null;
    }
  }

  private cpuSnapshot(): { idle: number; total: number } {
    let idle = 0;
    let total = 0;
    for (const c of os.cpus()) {
      idle += c.times.idle;
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    }
    return { idle, total };
  }

  async host(): Promise<HostMetrics> {
    // CPU: delta between two snapshots
    const now = this.cpuSnapshot();
    let prev = this.prevCpu;
    if (!prev || Date.now() - prev.at < 500) {
      prev = prev ?? { ...now, at: Date.now() };
      await new Promise((r) => setTimeout(r, 300));
    }
    const cur = this.cpuSnapshot();
    const dTotal = cur.total - prev.total;
    const cpuPercent = dTotal > 0 ? Math.round((1 - (cur.idle - prev.idle) / dTotal) * 1000) / 10 : null;
    this.prevCpu = { ...cur, at: Date.now() };

    let memAvailable = os.freemem();
    try {
      const mi = readFileSync(this.d.meminfoPath ?? '/proc/meminfo', 'utf8');
      const m = /MemAvailable:\s+(\d+) kB/.exec(mi);
      if (m?.[1]) memAvailable = Number(m[1]) * 1024;
    } catch {
      /* non-Linux or restricted */
    }

    let dockerRoot: HostMetrics['dockerRoot'] = null;
    let dockerRootError: string | null = null;
    const root = this.d.config.dockerRootMount ?? (await this.dockerRootDir());
    if (!root) dockerRootError = 'Docker root directory unknown';
    else {
      try {
        const s = statfsSync(root);
        dockerRoot = { path: root, total: s.blocks * s.bsize, free: s.bavail * s.bsize };
      } catch (e) {
        dockerRootError = `cannot statfs ${root}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}${
          this.d.config.dockerRootMount
            ? ''
            : ' (in container mode mount the Docker root read-only and set QM_DOCKER_ROOT_MOUNT)'
        }`;
      }
    }
    const la = os.loadavg();
    return {
      cpuPercent,
      load: [la[0] ?? 0, la[1] ?? 0, la[2] ?? 0],
      memTotal: os.totalmem(),
      memAvailable,
      uptimeSeconds: os.uptime(),
      dockerRoot,
      dockerRootError,
    };
  }
}
