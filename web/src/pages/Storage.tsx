import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { q } from '@/api/hooks';
import type { NetworkSummary, VolumeSummary } from '@/api/types';
import { ScopeNotice } from '@/components/layout/AppShell';
import {
  Badge,
  Card,
  DataTable,
  ErrorState,
  LoadingState,
  PageHeader,
  SearchInput,
  Segmented,
  Tag,
  type Column,
} from '@/components/ui';
import { bytes, dateTime } from '@/lib/format';

export default function StoragePage() {
  const [tab, setTab] = useState<'volumes' | 'networks'>('volumes');
  const [search, setSearch] = useState('');
  const [onlyUnused, setOnlyUnused] = useState<'all' | 'unused'>('all');
  const volumes = useQuery(q.volumes());
  const networks = useQuery(q.networks());
  const df = useQuery(q.df());
  const n = search.trim().toLowerCase();

  const vrows = useMemo(
    () =>
      (volumes.data ?? []).filter(
        (v) =>
          (!n || v.name.toLowerCase().includes(n) || (v.composeProject ?? '').includes(n)) &&
          (onlyUnused === 'all' || v.usedBy.length === 0),
      ),
    [volumes.data, n, onlyUnused],
  );
  const nrows = useMemo(
    () =>
      (networks.data ?? []).filter(
        (x) =>
          (!n || x.name.toLowerCase().includes(n) || (x.composeProject ?? '').includes(n)) &&
          (onlyUnused === 'all' || x.containers.length === 0),
      ),
    [networks.data, n, onlyUnused],
  );

  const vcols: Column<VolumeSummary>[] = [
    {
      key: 'name',
      header: 'Volume',
      sort: (a, b) => a.name.localeCompare(b.name),
      cell: (v) => (
        <span className="block max-w-72 truncate font-mono text-xs font-medium" title={v.name}>
          {v.name}
        </span>
      ),
    },
    {
      key: 'project',
      header: 'Project',
      hideOnSmall: true,
      cell: (v) =>
        v.composeProject ? (
          <Link
            className="text-accent hover:underline"
            to={`/compose/${encodeURIComponent(v.composeProject)}`}
          >
            {v.composeProject}
          </Link>
        ) : (
          <span className="text-muted">–</span>
        ),
    },
    { key: 'driver', header: 'Driver', hideOnSmall: true, cell: (v) => v.driver },
    {
      key: 'size',
      header: 'Size',
      align: 'right',
      sort: (a, b) => (volSize(a) ?? -1) - (volSize(b) ?? -1),
      cell: (v) => {
        const s = volSize(v);
        return s == null ? (
          <span className="text-muted" title="Size is measured by Docker; it may not be available yet.">
            n/a
          </span>
        ) : (
          bytes(s)
        );
      },
    },
    {
      key: 'created',
      header: 'Created',
      hideOnSmall: true,
      cell: (v) => (v.createdAt ? dateTime(v.createdAt) : '–'),
    },
    {
      key: 'used',
      header: 'Used by',
      sort: (a, b) => a.usedBy.length - b.usedBy.length,
      cell: (v) =>
        v.usedBy.length ? (
          <span className="flex flex-wrap gap-1">
            {v.usedBy.map((c) => (
              <Tag key={c}>{c}</Tag>
            ))}
          </span>
        ) : (
          <Badge tone="inactive">unused</Badge>
        ),
    },
  ];

  const ncols: Column<NetworkSummary>[] = [
    {
      key: 'name',
      header: 'Network',
      sort: (a, b) => a.name.localeCompare(b.name),
      cell: (x) => <span className="font-medium">{x.name}</span>,
    },
    {
      key: 'project',
      header: 'Project',
      hideOnSmall: true,
      cell: (x) =>
        x.composeProject ? (
          <Link
            className="text-accent hover:underline"
            to={`/compose/${encodeURIComponent(x.composeProject)}`}
          >
            {x.composeProject}
          </Link>
        ) : (
          <span className="text-muted">–</span>
        ),
    },
    { key: 'driver', header: 'Driver', hideOnSmall: true, cell: (x) => `${x.driver} / ${x.scope}` },
    {
      key: 'internal',
      header: 'Internal',
      hideOnSmall: true,
      cell: (x) =>
        x.internal ? <Badge tone="info">internal</Badge> : <span className="text-muted">no</span>,
    },
    {
      key: 'containers',
      header: 'Containers',
      sort: (a, b) => a.containers.length - b.containers.length,
      cell: (x) =>
        x.containers.length ? (
          <span className="flex flex-wrap gap-1">
            {x.containers.map((c) => (
              <Tag key={c}>{c}</Tag>
            ))}
          </span>
        ) : (
          <Badge tone="inactive">unused</Badge>
        ),
    },
  ];

  function volSize(v: VolumeSummary): number | null {
    return v.size ?? df.data?.usage?.volumes[v.name] ?? null;
  }

  const active = tab === 'volumes' ? volumes : networks;
  return (
    <>
      <PageHeader
        title="Volumes & Networks"
        description="Read-only inventory. Quaymaster never removes volumes or networks."
      />
      <ScopeNotice />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
          <Segmented
            label="Resource type"
            value={tab}
            onChange={setTab}
            options={[
              { key: 'volumes', label: 'Volumes', count: volumes.data?.length ?? 0 },
              { key: 'networks', label: 'Networks', count: networks.data?.length ?? 0 },
            ]}
          />
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search name or project…"
            label="Search"
          />
          <Segmented
            label="Usage filter"
            value={onlyUnused}
            onChange={setOnlyUnused}
            options={[
              { key: 'all', label: 'All' },
              { key: 'unused', label: 'Unused' },
            ]}
          />
        </div>
        {active.isLoading ? (
          <LoadingState rows={5} />
        ) : active.error ? (
          <ErrorState
            error={active.error}
            onRetry={() => void active.refetch()}
            title="Could not load the list"
          />
        ) : tab === 'volumes' ? (
          <DataTable
            caption="Volumes"
            rows={vrows}
            rowKey={(v) => v.name}
            columns={vcols}
            initialSort={{ key: 'name', dir: 'asc' }}
            empty={{ icon: 'database', title: 'No volumes match' }}
          />
        ) : (
          <DataTable
            caption="Networks"
            rows={nrows}
            rowKey={(x) => x.id}
            columns={ncols}
            initialSort={{ key: 'name', dir: 'asc' }}
            empty={{ icon: 'network', title: 'No networks match' }}
          />
        )}
      </Card>
    </>
  );
}
