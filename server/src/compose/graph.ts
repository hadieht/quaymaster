import type { DependencyEdgeKind, DependencyGraph } from '@quaymaster/shared';

/** Shape of `docker compose config --format json` that we rely on. */
export interface ResolvedConfig {
  name?: string;
  services?: Record<string, ResolvedService>;
  volumes?: Record<string, { name?: string; external?: boolean | { name?: string } } | null>;
  networks?: Record<string, { name?: string; external?: boolean | { name?: string } } | null>;
  secrets?: Record<string, { file?: string; environment?: string; content?: string } | null>;
  configs?: Record<string, { file?: string; content?: string } | null>;
  [key: string]: unknown;
}

export interface ResolvedService {
  image?: string;
  build?: unknown;
  container_name?: string;
  depends_on?: string[] | Record<string, { condition?: string; restart?: boolean; required?: boolean }>;
  network_mode?: string;
  pid?: string;
  ipc?: string;
  volumes_from?: string[];
  volumes?: (string | { type?: string; source?: string; target?: string })[];
  networks?: string[] | Record<string, unknown> | null;
  healthcheck?: unknown;
  profiles?: string[];
  [key: string]: unknown;
}

const SVC_REF_RE = /^(service|container):(.+)$/;

/** Builds the service dependency graph, including namespace-sharing and volumes_from edges (RT-11). */
export function buildGraph(cfg: ResolvedConfig): DependencyGraph {
  const services = cfg.services ?? {};
  const nodes = Object.keys(services).sort();
  const edges: DependencyGraph['edges'] = [];
  const add = (
    from: string,
    to: string,
    kind: DependencyEdgeKind,
    extra: { condition?: string; restart?: boolean; required?: boolean } = {},
  ) => {
    if (from !== to) edges.push({ from, to, kind, ...extra });
  };
  for (const [name, svc] of Object.entries(services)) {
    const dep = svc.depends_on;
    if (Array.isArray(dep)) for (const d of dep) add(name, d, 'depends_on', { condition: 'service_started' });
    else if (dep && typeof dep === 'object') {
      for (const [d, v] of Object.entries(dep)) {
        add(name, d, 'depends_on', {
          condition: v?.condition ?? 'service_started',
          restart: v?.restart ?? false,
          required: v?.required ?? true,
        });
      }
    }
    for (const field of [svc.network_mode, svc.pid, svc.ipc]) {
      const m = typeof field === 'string' ? SVC_REF_RE.exec(field) : null;
      if (m?.[1] === 'service' && m[2]) add(name, m[2], 'shares_namespace');
    }
    for (const vf of svc.volumes_from ?? []) {
      const ref = String(vf).split(':');
      if (ref[0] === 'container') continue; // external container; handled as a scope reference
      if (ref[0]) add(name, ref[0], 'volumes_from');
    }
  }
  const { order, cycle } = topoOrder(nodes, edges);
  return { nodes, edges, order, cycle };
}

/** Dependencies first. Deterministic (alphabetical among equals). Returns the cycle when there is one. */
export function topoOrder(
  nodes: string[],
  edges: DependencyGraph['edges'],
): { order: string[]; cycle: string[] | null } {
  const deps = new Map<string, Set<string>>(nodes.map((n) => [n, new Set()]));
  for (const e of edges) if (deps.has(e.from) && deps.has(e.to)) deps.get(e.from)?.add(e.to);
  const order: string[] = [];
  const state = new Map<string, 0 | 1 | 2>();
  let cycle: string[] | null = null;
  const stack: string[] = [];
  const visit = (n: string): void => {
    if (cycle) return;
    const s = state.get(n) ?? 0;
    if (s === 2) return;
    if (s === 1) {
      cycle = [...stack.slice(stack.indexOf(n)), n];
      return;
    }
    state.set(n, 1);
    stack.push(n);
    for (const d of [...(deps.get(n) ?? [])].sort()) visit(d);
    stack.pop();
    state.set(n, 2);
    order.push(n);
  };
  for (const n of [...nodes].sort()) visit(n);
  return cycle ? { order: [], cycle } : { order, cycle: null };
}

/** Services that (transitively) depend on `target` through any edge kind. */
export function dependentsOf(graph: DependencyGraph, target: string): string[] {
  const out = new Set<string>();
  const queue = [target];
  while (queue.length) {
    const cur = queue.shift() as string;
    for (const e of graph.edges) {
      if (e.to === cur && !out.has(e.from)) {
        out.add(e.from);
        queue.push(e.from);
      }
    }
  }
  return graph.order.length ? graph.order.filter((n) => out.has(n)) : [...out].sort();
}

/** Services that other services share a network/pid/ipc namespace or volumes with (RT-11). */
export function namespaceProviders(graph: DependencyGraph): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.kind === 'depends_on') continue;
    m.set(e.to, [...(m.get(e.to) ?? []), e.from]);
  }
  return m;
}

/** Resources a project's resolved config references by name — all must be in scope for mutations (RT-03). */
export function projectReferences(cfg: ResolvedConfig): {
  volumes: string[];
  networks: string[];
  containers: string[];
} {
  const volumes = new Set<string>();
  const networks = new Set<string>();
  const containers = new Set<string>();
  const isExternal = (v: { external?: boolean | { name?: string } } | null | undefined): boolean =>
    !!v && (v.external === true || typeof v.external === 'object');
  for (const [key, v] of Object.entries(cfg.volumes ?? {})) if (isExternal(v)) volumes.add(v?.name ?? key);
  for (const [key, v] of Object.entries(cfg.networks ?? {})) if (isExternal(v)) networks.add(v?.name ?? key);
  for (const svc of Object.values(cfg.services ?? {})) {
    if (svc.container_name) containers.add(svc.container_name);
    for (const field of [svc.network_mode, svc.pid, svc.ipc]) {
      const m = typeof field === 'string' ? SVC_REF_RE.exec(field) : null;
      if (m?.[1] === 'container' && m[2]) containers.add(m[2]);
    }
    for (const vf of svc.volumes_from ?? []) {
      const ref = String(vf).split(':');
      if (ref[0] === 'container' && ref[1]) containers.add(ref[1]);
    }
  }
  return { volumes: [...volumes], networks: [...networks], containers: [...containers] };
}
