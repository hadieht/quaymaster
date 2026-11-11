import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { openStream, type StreamStatus } from '@/api/stream';
import type { StatsPoint } from '@/api/types';

/** Live container stats (SSE `/stream/stats`), shared by every page so there is one connection. */
interface LiveState {
  status: StreamStatus;
  /** latest sample per container id */
  latest: Record<string, StatsPoint>;
  /** Monotonic counter bumped on each sample (cheap re-render trigger for charts). */
  tick: number;
  /** Rolling per-container series (last ~30 min) for live charts. */
  series: (id: string) => StatsPoint[];
}

const Ctx = createContext<LiveState | null>(null);
const MAX_POINTS = 180;

export function LiveProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [latest, setLatest] = useState<Record<string, StatsPoint>>({});
  const [tick, setTick] = useState(0);
  const hist = useRef(new Map<string, StatsPoint[]>());

  useEffect(() => {
    const push = (id: string, p: StatsPoint) => {
      const arr = hist.current.get(id) ?? [];
      if (arr.length && arr[arr.length - 1]?.t === p.t) return;
      arr.push(p);
      if (arr.length > MAX_POINTS) arr.shift();
      hist.current.set(id, arr);
    };
    return openStream('/stats', {
      onStatus: setStatus,
      events: {
        snapshot: (d) => {
          const snap = d as Record<string, StatsPoint>;
          for (const [id, p] of Object.entries(snap)) push(id, p);
          setLatest(snap);
          setTick((t) => t + 1);
        },
        stats: (d) => {
          const s = d as { id: string; point: StatsPoint };
          push(s.id, s.point);
          setLatest((l) => ({ ...l, [s.id]: s.point }));
          setTick((t) => t + 1);
        },
      },
    });
  }, []);

  const value = useMemo<LiveState>(
    () => ({ status, latest, tick, series: (id) => hist.current.get(id) ?? [] }),
    [status, latest, tick],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLive(): LiveState {
  const c = useContext(Ctx);
  if (!c) throw new Error('useLive must be used inside <LiveProvider>');
  return c;
}
