import { useMemo } from 'react';
import type { DependencyGraph as Graph } from '@/api/types';

const BOX_W = 150;
const BOX_H = 34;
const COL_GAP = 70;
const ROW_GAP = 16;

const KIND_LABEL: Record<string, string> = {
  depends_on: 'depends on',
  shares_namespace: 'shares network/pid/ipc namespace with',
  volumes_from: 'takes volumes from',
};

/** Layered dependency diagram (left = started first) plus an accessible text list of the same edges. */
export function DependencyGraphView({
  graph,
  statusOf,
}: {
  graph: Graph;
  statusOf?: (service: string) => string | undefined;
}) {
  const layout = useMemo(() => {
    const deps = new Map<string, string[]>(graph.nodes.map((n) => [n, []]));
    for (const e of graph.edges) deps.get(e.from)?.push(e.to);
    const level = new Map<string, number>();
    const visit = (n: string, stack: Set<string>): number => {
      const known = level.get(n);
      if (known !== undefined) return known;
      if (stack.has(n)) return 0; // cycle: the server reports it separately
      stack.add(n);
      const l = Math.max(-1, ...(deps.get(n) ?? []).map((d) => visit(d, stack))) + 1;
      stack.delete(n);
      level.set(n, l);
      return l;
    };
    for (const n of graph.nodes) visit(n, new Set());
    const cols = new Map<number, string[]>();
    for (const n of graph.nodes) cols.set(level.get(n) ?? 0, [...(cols.get(level.get(n) ?? 0) ?? []), n]);
    const pos = new Map<string, { x: number; y: number }>();
    let maxRows = 1;
    for (const [l, names] of cols) {
      names.sort();
      maxRows = Math.max(maxRows, names.length);
      names.forEach((n, i) => pos.set(n, { x: 8 + l * (BOX_W + COL_GAP), y: 8 + i * (BOX_H + ROW_GAP) }));
    }
    const width = 16 + cols.size * BOX_W + (cols.size - 1) * COL_GAP;
    const height = 16 + maxRows * BOX_H + (maxRows - 1) * ROW_GAP;
    return { pos, width, height };
  }, [graph]);

  if (graph.nodes.length === 0) return <p className="text-sm text-muted">No services.</p>;
  const tone = (s?: string) =>
    s === 'running'
      ? 'rgb(var(--healthy))'
      : s === 'unhealthy'
        ? 'rgb(var(--critical))'
        : s === 'partial'
          ? 'rgb(var(--warning))'
          : 'rgb(var(--inactive))';

  return (
    <div className="space-y-3">
      {graph.cycle ? (
        <p role="alert" className="text-sm text-critical">
          Dependency cycle detected: {graph.cycle.join(' → ')}
        </p>
      ) : null}
      <div className="qm-scroll overflow-x-auto">
        <svg
          width={layout.width}
          height={layout.height}
          role="img"
          aria-label="Service dependency diagram"
          className="min-w-full"
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0 0L8 4L0 8z" className="fill-muted" />
            </marker>
          </defs>
          {graph.edges.map((e, i) => {
            const a = layout.pos.get(e.from);
            const b = layout.pos.get(e.to);
            if (!a || !b) return null;
            // arrow points from the dependency (b) to the dependent (a): data flows in start order
            const x1 = b.x + BOX_W;
            const y1 = b.y + BOX_H / 2;
            const x2 = a.x;
            const y2 = a.y + BOX_H / 2;
            const mx = (x1 + x2) / 2;
            return (
              <path
                key={i}
                d={`M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2 - 2} ${y2}`}
                className="stroke-muted"
                fill="none"
                strokeWidth={1.5}
                strokeDasharray={e.kind === 'depends_on' ? undefined : '5 4'}
                markerEnd="url(#arrow)"
              >
                <title>{`${e.from} ${KIND_LABEL[e.kind] ?? e.kind} ${e.to}`}</title>
              </path>
            );
          })}
          {graph.nodes.map((n) => {
            const p = layout.pos.get(n);
            if (!p) return null;
            return (
              <g key={n} transform={`translate(${p.x} ${p.y})`}>
                <rect
                  width={BOX_W}
                  height={BOX_H}
                  rx={8}
                  className="fill-surface stroke-border"
                  strokeWidth={1}
                />
                <circle cx={14} cy={BOX_H / 2} r={4.5} fill={tone(statusOf?.(n))} />
                <text x={26} y={BOX_H / 2 + 4} className="fill-fg text-[12px]">
                  {n.length > 18 ? `${n.slice(0, 17)}…` : n}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="text-xs text-muted">
        Left to right is start order. Solid lines: depends_on. Dashed lines: shared namespace or volumes.
      </p>
      <ul className="space-y-0.5 text-sm">
        {graph.edges.length === 0 ? <li className="text-muted">No dependencies between services.</li> : null}
        {graph.edges.map((e, i) => (
          <li key={i}>
            <b className="font-medium">{e.from}</b>{' '}
            <span className="text-muted">{KIND_LABEL[e.kind] ?? e.kind}</span>{' '}
            <b className="font-medium">{e.to}</b>
            {e.condition ? <span className="text-muted"> ({e.condition})</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
