import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { q } from '@/api/hooks';
import { openStream, type StreamStatus } from '@/api/stream';
import type { AuditEntry, DockerEventRecord, OperationInfo } from '@/api/types';
import { OperationModal } from '@/components/domain/OperationModal';
import {
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  SearchInput,
  Segmented,
  TabPanel,
  Tabs,
  Tag,
  type Column,
} from '@/components/ui';
import { dateTime, relativeTime } from '@/lib/format';
import { outcomeTone, type Tone } from '@/lib/status';
import { useAuth } from '@/state/auth';

const EVENT_TONE: Record<string, Tone> = {
  die: 'critical',
  oom: 'critical',
  kill: 'warning',
  stop: 'inactive',
  start: 'healthy',
  restart: 'info',
  health_status: 'warning',
  destroy: 'inactive',
  create: 'info',
};
const toneOf = (a: string): Tone => EVENT_TONE[a.split(':')[0] ?? a] ?? 'info';

function EventRow({ e }: { e: DockerEventRecord }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
      <time className="w-40 shrink-0 text-xs text-muted" dateTime={e.time}>
        {dateTime(e.time)}
      </time>
      <Badge tone={toneOf(e.action)}>{e.action}</Badge>
      <span className="font-medium">{e.name ?? e.actorId.slice(0, 12)}</span>
      <Tag>{e.type}</Tag>
      {e.project ? (
        <span className="text-xs text-muted">
          {e.project}
          {e.service ? ` / ${e.service}` : ''}
        </span>
      ) : null}
      {e.synthetic ? <span className="text-xs text-muted">(derived)</span> : null}
    </li>
  );
}

function LiveEvents() {
  const history = useQuery(q.events(100));
  const [live, setLive] = useState<DockerEventRecord[]>([]);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  useEffect(
    () =>
      openStream('/events', {
        events: {
          'docker-event': (d) => {
            if (pausedRef.current) return;
            setLive((prev) => [d as DockerEventRecord, ...prev].slice(0, 300));
          },
        },
        onStatus: setStatus,
      }),
    [],
  );

  const rows = useMemo(() => {
    const seen = new Set<number>();
    const all: DockerEventRecord[] = [];
    for (const e of [...live, ...(history.data?.events ?? [])]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      all.push(e);
    }
    const n = filter.trim().toLowerCase();
    return all
      .filter(
        (e) =>
          !n ||
          `${e.action} ${e.name ?? ''} ${e.project ?? ''} ${e.service ?? ''} ${e.type}`
            .toLowerCase()
            .includes(n),
      )
      .sort((a, b) => b.id - a.id);
  }, [live, history.data, filter]);

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter events…" label="Filter events" />
        <Badge tone={status === 'live' ? 'healthy' : status === 'closed' ? 'critical' : 'warning'} dot>
          {status === 'live'
            ? 'Live'
            : status === 'reconnecting'
              ? 'Reconnecting…'
              : status === 'connecting'
                ? 'Connecting…'
                : 'Disconnected'}
        </Badge>
        <Button size="sm" icon={paused ? 'play' : 'pause'} onClick={() => setPaused(!paused)}>
          {paused ? 'Resume' : 'Pause'}
        </Button>
      </div>
      {history.isLoading ? (
        <LoadingState rows={4} />
      ) : history.error ? (
        <ErrorState error={history.error} onRetry={() => void history.refetch()} />
      ) : rows.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted">
          No events yet. Start or stop a container and it appears here.
        </p>
      ) : (
        <ul
          aria-label="Docker events"
          aria-live="off"
          className="qm-scroll max-h-[60vh] divide-y divide-border overflow-auto"
        >
          {rows.map((e) => (
            <EventRow key={e.id} e={e} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function Operations() {
  const ops = useQuery(q.operations());
  const [open, setOpen] = useState<OperationInfo | null>(null);
  const columns: Column<OperationInfo>[] = [
    {
      key: 'started',
      header: 'Started',
      sort: (a, b) => a.startedAt.localeCompare(b.startedAt),
      cell: (o) => <span title={dateTime(o.startedAt)}>{relativeTime(o.startedAt)}</span>,
    },
    {
      key: 'kind',
      header: 'Operation',
      sort: (a, b) => a.kind.localeCompare(b.kind),
      cell: (o) => <span className="font-medium">{o.kind}</span>,
    },
    { key: 'target', header: 'Target', cell: (o) => <span className="font-mono text-xs">{o.target}</span> },
    { key: 'actor', header: 'By', hideOnSmall: true, cell: (o) => o.actor },
    {
      key: 'status',
      header: 'Result',
      cell: (o) => (
        <Badge tone={o.status === 'succeeded' ? 'healthy' : o.status === 'failed' ? 'critical' : 'info'}>
          {o.status}
        </Badge>
      ),
    },
  ];
  if (ops.isLoading) return <LoadingState rows={4} />;
  if (ops.error) return <ErrorState error={ops.error} onRetry={() => void ops.refetch()} />;
  return (
    <Card>
      <DataTable
        caption="Operation history"
        rows={ops.data?.operations ?? []}
        rowKey={(o) => o.id}
        columns={columns}
        initialSort={{ key: 'started', dir: 'desc' }}
        onRowClick={setOpen}
        empty={{
          icon: 'scroll',
          title: 'No operations yet',
          text: 'Compose actions and image pulls are listed here with their output.',
        }}
      />
      <OperationModal
        operationId={open?.id ?? null}
        title={open ? `${open.kind}: ${open.target}` : ''}
        onClose={() => setOpen(null)}
      />
    </Card>
  );
}

function Audit() {
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [outcome, setOutcome] = useState<'all' | AuditEntry['outcome']>('all');
  const filters = {
    ...(action.trim() ? { action: action.trim() } : {}),
    ...(actor.trim() ? { actor: actor.trim() } : {}),
  };
  const audit = useQuery(q.audit(filters));
  const rows = (audit.data?.entries ?? []).filter((e) => outcome === 'all' || e.outcome === outcome);
  const columns: Column<AuditEntry>[] = [
    {
      key: 'time',
      header: 'Time',
      sort: (a, b) => a.id - b.id,
      cell: (e) => <span title={dateTime(e.time)}>{dateTime(e.time)}</span>,
    },
    { key: 'actor', header: 'Actor', cell: (e) => <span className="font-medium">{e.actor}</span> },
    { key: 'action', header: 'Action', cell: (e) => <span className="font-mono text-xs">{e.action}</span> },
    {
      key: 'target',
      header: 'Target',
      hideOnSmall: true,
      cell: (e) => (
        <span className="block max-w-64 truncate" title={e.target ?? ''}>
          {e.target ?? '–'}
        </span>
      ),
    },
    {
      key: 'outcome',
      header: 'Outcome',
      cell: (e) => <Badge tone={outcomeTone(e.outcome)}>{e.outcome}</Badge>,
    },
    {
      key: 'ip',
      header: 'IP',
      hideOnSmall: true,
      cell: (e) => <span className="text-xs text-muted">{e.ip ?? '–'}</span>,
    },
  ];
  return (
    <Card>
      <CardBody className="flex flex-wrap items-end gap-3">
        <Field label="Action contains">
          <Input value={action} onChange={(e) => setAction(e.target.value)} placeholder="e.g. container." />
        </Field>
        <Field label="Actor">
          <Input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="username" />
        </Field>
        <Segmented
          label="Outcome"
          value={outcome}
          onChange={setOutcome}
          options={[
            { key: 'all', label: 'All' },
            { key: 'success', label: 'Success' },
            { key: 'failure', label: 'Failure' },
            { key: 'denied', label: 'Denied' },
          ]}
        />
      </CardBody>
      {audit.isLoading ? (
        <LoadingState rows={4} />
      ) : audit.error ? (
        <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
      ) : (
        <DataTable
          caption="Audit log"
          rows={rows}
          rowKey={(e) => String(e.id)}
          columns={columns}
          initialSort={{ key: 'time', dir: 'desc' }}
          pageSize={25}
          empty={{ icon: 'shield', title: 'No audit entries match' }}
        />
      )}
    </Card>
  );
}

export default function LogsEventsPage() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<'events' | 'operations' | 'audit'>('events');
  return (
    <>
      <PageHeader
        title="Logs & Events"
        description="What Docker reports, what Quaymaster ran, and who changed what."
      />
      <Tabs
        label="Log sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'events', label: 'Live events' },
          { key: 'operations', label: 'Operations' },
          ...(isAdmin ? [{ key: 'audit' as const, label: 'Audit log' }] : []),
        ]}
      />
      <TabPanel id="events" tab={tab}>
        <LiveEvents />
      </TabPanel>
      <TabPanel id="operations" tab={tab}>
        <Operations />
      </TabPanel>
      <TabPanel id="audit" tab={tab}>
        <Audit />
      </TabPanel>
    </>
  );
}
