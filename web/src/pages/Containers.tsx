import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { q } from '@/api/hooks';
import type { ContainerSummary } from '@/api/types';
import { ContainerStatus, HealthBadge } from '@/components/domain/badges';
import { ScopeNotice } from '@/components/layout/AppShell';
import {
  Badge,
  Button,
  Card,
  DataTable,
  ErrorState,
  LoadingState,
  PageHeader,
  SearchInput,
  Segmented,
  Select,
  Tag,
  type Column,
} from '@/components/ui';
import { needsAttention } from '@/lib/attention';
import { bytes, duration, percent, uptimeFromStatus } from '@/lib/format';
import { useLive } from '@/state/live';

type StateFilter = 'all' | 'running' | 'stopped' | 'problems';

function startedSeconds(c: ContainerSummary): number | null {
  if (c.state !== 'running' || !c.startedAt) return null;
  const t = Date.parse(c.startedAt);
  return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 1000) : null;
}

export default function Containers() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const state = (params.get('state') as StateFilter | null) ?? 'all';
  const project = params.get('project') ?? '';
  const { latest } = useLive();
  const list = useQuery(q.containers());

  const set = (k: string, v: string) =>
    setParams(
      (p) => {
        if (v) p.set(k, v);
        else p.delete(k);
        return p;
      },
      { replace: true },
    );

  const all = useMemo(() => list.data ?? [], [list.data]);
  const problems = useMemo(() => new Set(needsAttention(all).map((a) => a.container.id)), [all]);
  const projects = useMemo(
    () => [...new Set(all.map((c) => c.composeProject).filter((p): p is string => !!p))].sort(),
    [all],
  );

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all.filter((c) => {
      if (state === 'running' && c.state !== 'running') return false;
      if (state === 'stopped' && (c.state === 'running' || c.state === 'restarting' || c.state === 'paused'))
        return false;
      if (state === 'problems' && !problems.has(c.id)) return false;
      if (project === '__none' ? c.composeProject !== null : project && c.composeProject !== project)
        return false;
      if (!needle) return true;
      return [c.name, c.image, c.composeProject ?? '', c.composeService ?? '', c.shortId].some((s) =>
        s.toLowerCase().includes(needle),
      );
    });
  }, [all, query, state, project, problems]);

  const columns: Column<ContainerSummary>[] = [
    {
      key: 'name',
      header: 'Name',
      sort: (a, b) => a.name.localeCompare(b.name),
      cell: (c) => (
        <div className="min-w-0">
          <div className="font-medium">{c.name}</div>
          {c.composeProject ? (
            <div className="text-xs text-muted">
              {c.composeProject}
              {c.composeService ? ` / ${c.composeService}` : ''}
            </div>
          ) : (
            <div className="text-xs text-muted">standalone</div>
          )}
        </div>
      ),
    },
    {
      key: 'state',
      header: 'State',
      sort: (a, b) => a.state.localeCompare(b.state),
      cell: (c) => <ContainerStatus c={c} />,
    },
    {
      key: 'health',
      header: 'Health',
      hideOnSmall: true,
      sort: (a, b) => a.health.localeCompare(b.health),
      cell: (c) => <HealthBadge health={c.health} />,
    },
    {
      key: 'uptime',
      header: 'Uptime',
      hideOnSmall: true,
      sort: (a, b) => (startedSeconds(a) ?? -1) - (startedSeconds(b) ?? -1),
      cell: (c) => {
        const s = startedSeconds(c);
        return <span className="text-muted">{s !== null ? duration(s) : uptimeFromStatus(c.status)}</span>;
      },
    },
    {
      key: 'restarts',
      header: 'Restarts',
      align: 'right',
      hideOnSmall: true,
      sort: (a, b) => (a.restartCount ?? 0) - (b.restartCount ?? 0),
      cell: (c) =>
        (c.restartCount ?? 0) > 0 ? (
          <Badge tone={c.restartCount! >= 5 ? 'warning' : 'inactive'} dot={false}>
            {c.restartCount}
          </Badge>
        ) : (
          <span className="text-muted">0</span>
        ),
    },
    {
      key: 'image',
      header: 'Image',
      hideOnSmall: true,
      sort: (a, b) => a.image.localeCompare(b.image),
      cell: (c) => (
        <span className="block max-w-56 truncate font-mono text-xs text-muted" title={c.image}>
          {c.image}
        </span>
      ),
    },
    {
      key: 'cpu',
      header: 'CPU',
      align: 'right',
      sort: (a, b) => (latest[a.id]?.cpu ?? -1) - (latest[b.id]?.cpu ?? -1),
      cell: (c) => (latest[c.id] ? percent(latest[c.id]!.cpu, 1) : <span className="text-muted">–</span>),
    },
    {
      key: 'mem',
      header: 'Memory',
      align: 'right',
      sort: (a, b) => (latest[a.id]?.memUsage ?? -1) - (latest[b.id]?.memUsage ?? -1),
      cell: (c) => (latest[c.id] ? bytes(latest[c.id]!.memUsage) : <span className="text-muted">–</span>),
    },
  ];

  return (
    <>
      <PageHeader
        title="Containers"
        description="Every container on this Docker host. Select one to see logs, resources and configuration."
        actions={
          <Button
            icon="refresh"
            onClick={() => void list.refetch()}
            loading={list.isFetching && !list.isLoading}
          >
            Refresh
          </Button>
        }
      />
      <ScopeNotice />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
          <SearchInput
            value={query}
            onChange={(v) => set('q', v)}
            placeholder="Search name, image, project…"
            label="Search containers"
          />
          <Segmented<StateFilter>
            label="Filter by state"
            value={state}
            onChange={(v) => set('state', v === 'all' ? '' : v)}
            options={[
              { key: 'all', label: 'All', count: all.length },
              { key: 'running', label: 'Running', count: all.filter((c) => c.state === 'running').length },
              {
                key: 'stopped',
                label: 'Stopped',
                count: all.filter((c) => !['running', 'restarting', 'paused'].includes(c.state)).length,
              },
              { key: 'problems', label: 'Problems', count: problems.size },
            ]}
          />
          <Select
            aria-label="Filter by project"
            value={project}
            onChange={(e) => set('project', e.target.value)}
            className="w-44"
          >
            <option value="">All projects</option>
            <option value="__none">Standalone only</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
          {(query || state !== 'all' || project) && (
            <Button variant="ghost" size="sm" onClick={() => setParams({}, { replace: true })}>
              Clear filters
            </Button>
          )}
          <span className="ml-auto text-xs text-muted">
            {rows.length} of {all.length}
          </span>
        </div>
        {list.isLoading ? (
          <LoadingState rows={6} />
        ) : list.error ? (
          <ErrorState
            error={list.error}
            onRetry={() => void list.refetch()}
            title="Could not load containers"
          />
        ) : (
          <DataTable
            caption="Containers"
            rows={rows}
            rowKey={(c) => c.id}
            columns={columns}
            initialSort={{ key: 'name', dir: 'asc' }}
            onRowClick={(c) => navigate(`/containers/${encodeURIComponent(c.name)}`)}
            empty={{
              icon: 'box',
              title: all.length === 0 ? 'No containers' : 'No container matches the filters',
              text:
                all.length === 0
                  ? 'There are no containers on this Docker host.'
                  : 'Try a different search or clear the filters.',
            }}
          />
        )}
      </Card>
      <p className="mt-3 text-xs text-muted">
        <Tag>Tip</Tag> CPU and memory update live. Restart counts come from Docker and can lag by a few
        seconds.
      </p>
    </>
  );
}
