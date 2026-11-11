import type { ContainerSummary } from '@/api/types';

export type AttentionReason = 'restarting' | 'unhealthy' | 'dead' | 'crashed' | 'starting';

export interface AttentionItem {
  container: ContainerSummary;
  reason: AttentionReason;
  detail: string;
}

/** Exit code from Docker's status text ("Exited (137) 2 hours ago"), or null. */
export function exitCodeOf(status: string): number | null {
  const m = /^Exited \((-?\d+)\)/.exec(status);
  return m ? Number(m[1]) : null;
}

/** Containers that need a human: restart loops, failed health checks, dead or crashed (non-zero exit). */
export function needsAttention(containers: ContainerSummary[]): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const c of containers) {
    if (c.state === 'restarting') out.push({ container: c, reason: 'restarting', detail: 'Restart loop: the process keeps exiting.' });
    else if (c.state === 'dead') out.push({ container: c, reason: 'dead', detail: 'The container is dead and cannot be started.' });
    else if (c.state === 'running' && c.health === 'unhealthy')
      out.push({ container: c, reason: 'unhealthy', detail: 'Its health check is failing.' });
    else if (c.state === 'exited') {
      const code = exitCodeOf(c.status);
      if (code !== null && code !== 0 && code !== 143) {
        out.push({ container: c, reason: 'crashed', detail: `Exited with code ${code}${code === 137 ? ' (killed, possibly out of memory)' : ''}.` });
      }
    }
  }
  const rank: Record<AttentionReason, number> = { restarting: 0, dead: 1, unhealthy: 2, crashed: 3, starting: 4 };
  return out.sort((a, b) => rank[a.reason] - rank[b.reason] || a.container.name.localeCompare(b.container.name));
}

export interface ContainerCounts {
  total: number;
  running: number;
  stopped: number;
  restarting: number;
  unhealthy: number;
  paused: number;
}

export function countContainers(list: ContainerSummary[]): ContainerCounts {
  const n: ContainerCounts = { total: list.length, running: 0, stopped: 0, restarting: 0, unhealthy: 0, paused: 0 };
  for (const c of list) {
    if (c.state === 'running') n.running++;
    else if (c.state === 'restarting') n.restarting++;
    else if (c.state === 'paused') n.paused++;
    else n.stopped++;
    if (c.state === 'running' && c.health === 'unhealthy') n.unhealthy++;
  }
  return n;
}
