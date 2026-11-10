import type { SelfInfo } from './guard.js';
import { NO_SELF } from './guard.js';

export interface SelfProbe {
  env: { QM_SELF_CONTAINER?: string | null };
  readFile(path: string): string | null;
  hostname(): string;
  /** Inspect by id/name/prefix; returns null when not found. */
  inspect(idOrName: string): Promise<InspectedSelf | null>;
}

export interface InspectedSelf {
  Id: string;
  Name: string;
  Config?: { Labels?: Record<string, string> };
  Mounts?: { Type?: string; Name?: string }[];
  NetworkSettings?: { Networks?: Record<string, unknown> };
}

/**
 * Extracts a container ID from /proc/self/mountinfo. Works on cgroup v1 and v2: Docker bind-mounts
 * /etc/hostname, /etc/hosts and /etc/resolv.conf from `/var/lib/docker/containers/<id>/…`
 * (RT-05: /proc/self/cgroup is useless on cgroup v2, where it reads `0::/`).
 */
export function containerIdFromMountinfo(mountinfo: string): string | null {
  const m = /\/containers\/([0-9a-f]{64})\/(?:hostname|hosts|resolv\.conf)/.exec(mountinfo);
  return m?.[1] ?? null;
}

/** Legacy cgroup v1 fallback (kept for completeness; mountinfo is tried first). */
export function containerIdFromCgroup(cgroup: string): string | null {
  const m = /(?:docker[-/]|\/docker\/)([0-9a-f]{64})/.exec(cgroup);
  return m?.[1] ?? null;
}

export function looksContainerised(probe: Pick<SelfProbe, 'readFile'>): boolean {
  if (probe.readFile('/.dockerenv') !== null) return true;
  const mi = probe.readFile('/proc/self/mountinfo');
  if (mi && containerIdFromMountinfo(mi)) return true;
  const cg = probe.readFile('/proc/1/cgroup');
  return !!cg && /(docker|containerd|kubepods)/.test(cg);
}

/**
 * Self-detection order (RT-05): QM_SELF_CONTAINER → mountinfo → cgroup → hostname match.
 * Inside a container, failure to identify ourselves is reported (and makes the guard fail closed).
 */
export async function detectSelf(probe: SelfProbe): Promise<SelfInfo> {
  const configured = probe.env.QM_SELF_CONTAINER?.trim();
  const inContainer = !!configured || looksContainerised(probe);
  if (!inContainer) return NO_SELF;

  const candidates: { how: string; ref: string }[] = [];
  if (configured) candidates.push({ how: 'QM_SELF_CONTAINER', ref: configured });
  const mi = probe.readFile('/proc/self/mountinfo');
  const fromMi = mi ? containerIdFromMountinfo(mi) : null;
  if (fromMi) candidates.push({ how: 'mountinfo', ref: fromMi });
  const cg = probe.readFile('/proc/self/cgroup');
  const fromCg = cg ? containerIdFromCgroup(cg) : null;
  if (fromCg) candidates.push({ how: 'cgroup', ref: fromCg });
  const host = probe.hostname();
  if (host) candidates.push({ how: 'hostname', ref: host });

  let lastError = 'no identification source succeeded';
  for (const c of candidates) {
    const info = await probe.inspect(c.ref).catch(() => null);
    if (!info) {
      lastError = `${c.how}="${c.ref.slice(0, 12)}" does not match any container`;
      if (c.how === 'QM_SELF_CONTAINER') break; // an explicit setting that does not resolve is an error
      continue;
    }
    return {
      inContainer: true,
      containerId: info.Id,
      containerName: info.Name.replace(/^\//, ''),
      project: info.Config?.Labels?.['com.docker.compose.project'] ?? null,
      networks: Object.keys(info.NetworkSettings?.Networks ?? {}),
      volumes: (info.Mounts ?? []).filter((m) => m.Type === 'volume' && m.Name).map((m) => m.Name as string),
      failure: null,
    };
  }
  return { ...NO_SELF, inContainer: true, failure: lastError };
}
