import { readFileSync, statfsSync } from 'node:fs';
import os from 'node:os';
import type Dockerode from 'dockerode';
import type { HostMetrics } from '@quaymaster/shared';
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
