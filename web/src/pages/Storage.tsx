import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { q, useInvalidateDocker } from '@/api/hooks';
import type { NetworkSummary, ReclaimReport, VolumeSummary } from '@/api/types';
import {
  ReclaimSummary,
  RemoveNetworkDialog,
  RemoveVolumeDialog,
  StorageCleanupDialog,
} from '@/components/domain/StorageRemoval';
import { ScopeNotice } from '@/components/layout/AppShell';
import {
  Badge,
  Button,
  Card,
  Notice,
  useToast,
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
import { useGate } from '@/state/auth';

const PREDEFINED = new Set(['bridge', 'host', 'none']);

export default function StoragePage() {
  const [tab, setTab] = useState<'volumes' | 'networks'>('volumes');
  const [search, setSearch] = useState('');
  const [onlyUnused, setOnlyUnused] = useState<'all' | 'unused'>('all');
  const volumes = useQuery(q.volumes());
  const networks = useQuery(q.networks());
  const df = useQuery(q.df());
  const gate = useGate();
  const toast = useToast();
  const invalidate = useInvalidateDocker();
  const writeBlock = gate();
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [delVolume, setDelVolume] = useState<VolumeSummary | null>(null);
  const [delNetwork, setDelNetwork] = useState<NetworkSummary | null>(null);
  const [reclaimed, setReclaimed] = useState<{
    title: string;
    reclaim: ReclaimReport;
  } | null>(null);
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
    {
      key: 'remove',
      header: '',
      align: 'right',
      cell: (v) => (
        <Button
          size="sm"
          icon="trash"
          aria-label={`Delete volume ${v.name}`}
          disabledReason={
            writeBlock ??
            (v.usedBy.length ? `In use by ${v.usedBy.join(', ')} (a stopped container counts).` : null)
          }
          onClick={() => setDelVolume(v)}
        >
          Delete
        </Button>
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
    {
      key: 'remove',
      header: '',
      align: 'right',
      cell: (x) => (
        <Button
          size="sm"
          icon="trash"
          aria-label={`Remove network ${x.name}`}
          disabledReason={
            writeBlock ??
            (PREDEFINED.has(x.name)
              ? 'Predefined Docker network.'
              : x.containers.length
                ? `Containers are attached: ${x.containers.join(', ')}.`
                : null)
          }
          onClick={() => setDelNetwork(x)}
        >
          Remove
        </Button>
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
        description="Unused volumes and networks can be removed one by one or in bulk after a preview. Removing a volume permanently deletes its data."
        actions={
          <Button icon="trash" disabledReason={writeBlock} onClick={() => setCleanupOpen(true)}>
            Clean up…
          </Button>
        }
      />
      <ScopeNotice />
      {reclaimed ? (
        <Notice tone="healthy" title={reclaimed.title} className="mb-4">
          <ReclaimSummary reclaim={reclaimed.reclaim} />
        </Notice>
      ) : null}
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
      {cleanupOpen ? (
        <StorageCleanupDialog
          open
          onClose={() => setCleanupOpen(false)}
          onDone={(r) => {
            invalidate();
            setReclaimed({ title: `Cleanup removed ${r.removed.length} item(s)`, reclaim: r.reclaim });
            toast.success(
              'Cleanup finished',
              `${r.removed.length} removed, ${bytes(r.reclaim.reclaimedBytes)} reclaimed`,
            );
          }}
        />
      ) : null}
      {delVolume ? (
        <RemoveVolumeDialog
          open
          volume={delVolume}
          onClose={() => setDelVolume(null)}
          onDone={(r) => {
            invalidate();
            setReclaimed({ title: `Volume ${r.name} deleted`, reclaim: r.reclaim });
          }}
        />
      ) : null}
      {delNetwork ? (
        <RemoveNetworkDialog
          open
          network={delNetwork}
          onClose={() => setDelNetwork(null)}
          onDone={(r) => {
            invalidate();
            toast.success('Network removed', r.name);
          }}
        />
      ) : null}
    </>
  );
}
