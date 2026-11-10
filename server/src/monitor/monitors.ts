import type { DockerEventRecord, MonitorSettings, NotificationEvent, StatsPoint } from '@quaymaster/shared';
import type { KvRepo } from '../db/stats.js';
import type { SchedulesRepo } from '../db/maintenance.js';
import type { SystemService } from '../docker/system.js';
import type { MaintenanceService } from '../maintenance/service.js';
import type { Clock } from '../maintenance/clock.js';
import { nextOccurrences } from '../maintenance/time.js';
import type { UpdateService } from '../updates/detector.js';
import type { Logger } from '../util/logger.js';

export const DEFAULT_MONITOR_SETTINGS: MonitorSettings = {
  enabled: true,
  diskFreePercentBelow: 10,
  diskFreeBytesBelow: 5 * 1024 ** 3,
  cpuPercentAbove: 90,
  memoryPercentAbove: 90,
  sustainSeconds: 300,
  restartLoopCount: 5,
  restartLoopWindowSeconds: 300,
  upcomingMaintenanceMinutes: 60,
};

const SETTINGS_KEY = 'monitor.settings';
const UPDATE_CHECK_KEY = 'monitor.lastUpdateCheck';

/**
 * Background monitors (spec 8): they only EMIT notification events; de-duplication, cool-down and
 * delivery belong to the notification service, and a failing channel never reaches back here.
 */
export class Monitors {
  private readonly diedAt = new Map<string, number[]>();
  private readonly stopped = new Map<string, number>();
  private readonly over = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly d: {
      kv: KvRepo;
      system: SystemService;
      schedules: SchedulesRepo;
      updates: UpdateService;
      maintenance: MaintenanceService;
      notify: (e: NotificationEvent) => void;
      /** True while a maintenance run owns the lock: deliberate stops/recreates must not page anyone. */
      maintenanceBusy: () => boolean;
      clock: Clock;
      log: Logger;
      updateCheckIntervalMs?: number;
    },
  ) {}

  settings(): MonitorSettings {
    const raw = this.d.kv.get(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_MONITOR_SETTINGS };
    try {
      return { ...DEFAULT_MONITOR_SETTINGS, ...(JSON.parse(raw) as Partial<MonitorSettings>) };
    } catch {
      return { ...DEFAULT_MONITOR_SETTINGS };
    }
  }

  saveSettings(s: MonitorSettings): MonitorSettings {
    this.d.kv.set(SETTINGS_KEY, JSON.stringify(s));
    return s;
  }

  // ---- event-driven: died / unhealthy / restart loop -----------------------------------------

  onDockerEvent(ev: DockerEventRecord): void {
    const s = this.settings();
    if (!s.enabled || ev.type !== 'container') return;
    const now = this.d.clock.now();
    const name = ev.name ?? ev.actorId.slice(0, 12);
    const where = ev.project ? `${ev.project}/${ev.service ?? name}` : name;
    if (ev.action === 'stop' || ev.action === 'kill') {
      this.stopped.set(ev.actorId, now);
      return;
    }
    if (ev.action === 'health_status' && ev.attributes['health'] === 'unhealthy') {
      this.d.notify({
        type: 'container.unhealthy',
        severity: 'warning',
        title: `Container unhealthy: ${where}`,
        message: `${name} reports an unhealthy healthcheck.`,
        dedupeKey: `unhealthy:${ev.actorId}`,
        cooldownMs: 30 * 60_000,
        data: { container: name },
      });
      return;
    }
    if (ev.action === 'oom') {
      this.d.notify({
        type: 'container.died',
        severity: 'critical',
        title: `Container killed (out of memory): ${where}`,
        message: `${name} was killed by the OOM killer.`,
        dedupeKey: `oom:${ev.actorId}`,
        data: { container: name },
      });
      return;
    }
    if (ev.action !== 'die' || ev.synthetic) return;
    const code = ev.attributes['exitCode'];
    const lastStop = this.stopped.get(ev.actorId) ?? 0;
    const deliberate = now - lastStop < 15_000;
    // restart loop detection counts every die, deliberate or not
    const list = (this.diedAt.get(ev.actorId) ?? []).filter(
      (t) => now - t < s.restartLoopWindowSeconds * 1000,
    );
    list.push(now);
    this.diedAt.set(ev.actorId, list);
    if (this.d.maintenanceBusy()) return; // a run reports its own failures
    if (list.length >= s.restartLoopCount) {
      this.d.notify({
        type: 'container.restart_loop',
        severity: 'critical',
        title: `Restart loop: ${where}`,
        message: `${name} exited ${list.length} times in ${s.restartLoopWindowSeconds}s (last exit code ${code ?? '?'}).`,
        dedupeKey: `loop:${ev.actorId}`,
        cooldownMs: 30 * 60_000,
        data: { container: name, exits: list.length },
      });
      return;
    }
    if (!deliberate && code !== undefined && code !== '0') {
      this.d.notify({
        type: 'container.died',
        severity: 'warning',
        title: `Container died: ${where}`,
        message: `${name} exited with code ${code}.`,
        dedupeKey: `died:${ev.actorId}`,
        cooldownMs: 10 * 60_000,
        data: { container: name, exitCode: code },
      });
    }
  }

  // ---- sampled: per-container CPU / memory ----------------------------------------------------

  onSample(sample: { id: string; name: string; point: StatsPoint }): void {
    const s = this.settings();
    if (!s.enabled) return;
    const now = this.d.clock.now();
    const memPct = sample.point.memLimit > 0 ? (sample.point.memUsage / sample.point.memLimit) * 100 : 0;
    this.sustained(`cpu:${sample.id}`, sample.point.cpu > s.cpuPercentAbove, now, s, () =>
      this.d.notify({
        type: 'host.cpu_high',
        severity: 'warning',
        title: `High CPU: ${sample.name}`,
        message: `${sample.name} used ${sample.point.cpu.toFixed(0)}% of a core for more than ${s.sustainSeconds}s.`,
        dedupeKey: `cpu:${sample.id}`,
        cooldownMs: 60 * 60_000,
        data: { container: sample.name, cpu: Math.round(sample.point.cpu) },
      }),
    );
    this.sustained(`mem:${sample.id}`, memPct > s.memoryPercentAbove, now, s, () =>
      this.d.notify({
        type: 'host.memory_high',
        severity: 'warning',
        title: `High memory: ${sample.name}`,
        message: `${sample.name} used ${memPct.toFixed(0)}% of its memory limit for more than ${s.sustainSeconds}s.`,
        dedupeKey: `mem:${sample.id}`,
        cooldownMs: 60 * 60_000,
        data: { container: sample.name, memoryPercent: Math.round(memPct) },
      }),
    );
  }

  private sustained(key: string, bad: boolean, now: number, s: MonitorSettings, fire: () => void): void {
    if (!bad) {
      this.over.delete(key);
      return;
    }
    const since = this.over.get(key) ?? now;
    this.over.set(key, since);
    if (now - since >= s.sustainSeconds * 1000) fire();
  }

  // ---- polled: host, updates, upcoming maintenance ------------------------------------------------

  async poll(): Promise<void> {
    const s = this.settings();
    if (!s.enabled) return;
    const now = this.d.clock.now();
    const host = await this.d.system.host().catch(() => null);
    if (host?.dockerRoot) {
      const pct = (host.dockerRoot.free / host.dockerRoot.total) * 100;
      if (pct < s.diskFreePercentBelow || host.dockerRoot.free < s.diskFreeBytesBelow) {
        this.d.notify({
          type: 'host.disk_low',
          severity: pct < s.diskFreePercentBelow / 2 ? 'critical' : 'warning',
          title: 'Low disk space on the Docker root',
          message: `${(host.dockerRoot.free / 1024 ** 3).toFixed(1)} GiB free (${pct.toFixed(1)} %).`,
          dedupeKey: 'disk-low',
          cooldownMs: 6 * 3_600_000,
          data: { freeBytes: host.dockerRoot.free, freePercent: Math.round(pct * 10) / 10 },
        });
      }
    }
    if (host) {
      const memPct = (1 - host.memAvailable / host.memTotal) * 100;
      this.sustained('host-cpu', (host.cpuPercent ?? 0) > s.cpuPercentAbove, now, s, () =>
        this.d.notify({
          type: 'host.cpu_high',
          severity: 'warning',
          title: 'High host CPU',
          message: `Host CPU at ${host.cpuPercent}% for more than ${s.sustainSeconds}s.`,
          dedupeKey: 'host-cpu',
          cooldownMs: 3_600_000,
        }),
      );
      this.sustained('host-mem', memPct > s.memoryPercentAbove, now, s, () =>
        this.d.notify({
          type: 'host.memory_high',
          severity: 'warning',
          title: 'High host memory use',
          message: `Host memory at ${memPct.toFixed(0)}% for more than ${s.sustainSeconds}s.`,
          dedupeKey: 'host-mem',
          cooldownMs: 3_600_000,
        }),
      );
    }
    // upcoming maintenance
    const horizon = now + s.upcomingMaintenanceMinutes * 60_000;
    for (const sc of this.d.schedules.list().filter((x) => x.enabled && x.jobType === 'update')) {
      const next = nextOccurrences(sc.cron, sc.timezone, now, 1, horizon)[0];
      if (next !== undefined) {
        this.d.notify({
          type: 'maintenance.upcoming',
          severity: 'info',
          title: `Maintenance starts soon: ${sc.name}`,
          message: `Scheduled ${sc.jobType} (${sc.mode}) for ${sc.selector.project ?? sc.selector.container ?? 'the host'} at ${new Date(next).toISOString()}.`,
          dedupeKey: `upcoming:${sc.id}:${next}`,
          cooldownMs: 24 * 3_600_000,
        });
      }
    }
    // updates available: built-in daily check (the image_check schedule is the configurable way)
    const interval = this.d.updateCheckIntervalMs ?? 24 * 3_600_000;
    const last = Number(this.d.kv.get(UPDATE_CHECK_KEY) ?? 0);
    if (now - last >= interval) {
      this.d.kv.set(UPDATE_CHECK_KEY, String(now));
      const all = await this.d.updates.statuses().catch(() => []);
      const avail = all.filter((a) => a.state === 'update_available' || a.state === 'update_staged');
      if (avail.length > 0) this.d.maintenance.announceUpdates(avail, avail.length);
    }
  }

  start(intervalMs = 60_000): void {
    this.stop();
    this.timer = setInterval(
      () => void this.poll().catch((e) => this.d.log.error({ err: e }, 'monitor poll failed')),
      intervalMs,
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
