import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { q } from '@/api/hooks';
import { ChartEmpty, TimeChart } from '@/components/domain/TimeChart';
import { ContainerStatus, RunBadge, UpdateBadge } from '@/components/domain/badges';
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  ProgressBar,
  StatCard,
} from '@/components/ui';
import { ScopeNotice } from '@/components/layout/AppShell';
import { countContainers, needsAttention } from '@/lib/attention';
import { bytes, dateTime, duration, percent, relativeTime } from '@/lib/format';

function MiniList({ children }: { children: React.ReactNode }) {
  return <ul className="divide-y divide-border/60">{children}</ul>;
}

function Section({ title, description, to, linkLabel, children }: { title: string; description?: string; to?: string; linkLabel?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        actions={
          to ? (
            <Link to={to} className="text-xs font-medium text-accent hover:underline">
              {linkLabel ?? 'View all'}
            </Link>
          ) : undefined
        }
      />
      {children}
    </Card>
  );
}

export default function Dashboard() {
  const containers = useQuery(q.containers());
  const projects = useQuery(q.projects());
  const images = useQuery(q.images());
  const host = useQuery(q.host());
  const df = useQuery(q.df());
  const info = useQuery(q.info());
  const updates = useQuery(q.updates());
  const overview = useQuery(q.overview(60));
  const schedules = useQuery(q.schedules());
  const runs = useQuery(q.runs(8));
  const events = useQuery(q.events(8));

  const counts = useMemo(() => countContainers(containers.data ?? []), [containers.data]);
  const attention = useMemo(() => needsAttention(containers.data ?? []), [containers.data]);
  const pending = (updates.data?.images ?? []).filter((i) => i.state === 'update_available' || i.state === 'update_staged');

  const upcoming = useMemo(
    () =>
      (schedules.data?.schedules ?? [])
        .filter((s) => s.enabled && s.nextRuns[0])
        .map((s) => ({ s, at: s.nextRuns[0] as string }))
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
        .slice(0, 5),
    [schedules.data],
  );

  const h = host.data;
  const memUsed = h ? h.memTotal - h.memAvailable : 0;
  const memPct = h && h.memTotal ? (memUsed / h.memTotal) * 100 : 0;
  const root = h?.dockerRoot;
  const diskPct = root ? ((root.total - root.free) / root.total) * 100 : 0;
  const points = overview.data?.points ?? [];

  return (
    <>
      <PageHeader title="Dashboard" description="Health of this Docker host at a glance." />
      <ScopeNotice />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <StatCard label="Running" value={containers.isLoading ? '…' : counts.running} sub={`of ${counts.total} containers`} icon="play" tone="healthy" />
        <StatCard label="Stopped" value={containers.isLoading ? '…' : counts.stopped} icon="stop" tone="inactive" />
        <StatCard label="Restarting" value={containers.isLoading ? '…' : counts.restarting} icon="refresh" tone={counts.restarting ? 'critical' : 'inactive'} />
        <StatCard label="Unhealthy" value={containers.isLoading ? '…' : counts.unhealthy} icon="alert" tone={counts.unhealthy ? 'critical' : 'inactive'} />
        <StatCard label="Projects" value={projects.isLoading ? '…' : (projects.data?.length ?? 0)} sub="Compose" icon="layers" tone="info" />
        <StatCard
          label="Images"
          value={images.isLoading ? '…' : (images.data?.length ?? 0)}
          sub={images.data ? `${images.data.filter((i) => !i.inUse).length} unused` : undefined}
          icon="image"
          tone="info"
        />
        <StatCard
          label="Docker disk"
          value={root ? percent(diskPct) : h?.dockerRootError ? 'n/a' : '…'}
          sub={root ? `${bytes(root.free)} free of ${bytes(root.total)}` : (h?.dockerRootError ?? undefined)}
          icon="hdd"
          tone={root ? (diskPct >= 90 ? 'critical' : diskPct >= 75 ? 'warning' : 'healthy') : 'inactive'}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Host" description={info.data ? `${info.data.OperatingSystem ?? ''} · Docker ${info.data.ServerVersion ?? ''}` : undefined} />
          <CardBody className="space-y-4">
            {host.isLoading ? (
              <LoadingState rows={3} />
            ) : host.error ? (
              <ErrorState error={host.error} onRetry={() => void host.refetch()} />
            ) : h ? (
              <>
                <div>
                  <div className="mb-1 flex justify-between text-xs"><span className="text-muted">CPU</span><span className="tabular-nums">{h.cpuPercent === null ? '–' : percent(h.cpuPercent)}</span></div>
                  <ProgressBar value={h.cpuPercent ?? 0} label="Host CPU" />
                </div>
                <div>
                  <div className="mb-1 flex justify-between text-xs"><span className="text-muted">Memory</span><span className="tabular-nums">{bytes(memUsed)} / {bytes(h.memTotal)}</span></div>
                  <ProgressBar value={memPct} label="Host memory" />
                </div>
                {root ? (
                  <div>
                    <div className="mb-1 flex justify-between text-xs"><span className="text-muted">Docker disk</span><span className="tabular-nums">{bytes(root.total - root.free)} / {bytes(root.total)}</span></div>
                    <ProgressBar value={diskPct} label="Docker disk" />
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-2 text-xs text-muted">
                  <div>Load <span className="tabular-nums text-fg">{h.load.map((l) => l.toFixed(2)).join(' · ')}</span></div>
                  <div>Uptime <span className="text-fg">{duration(h.uptimeSeconds)}</span></div>
                  {df.data?.usage ? <div className="col-span-2">Images use <span className="text-fg">{bytes(df.data.usage.images.totalSize)}</span> in total</div> : null}
                </div>
              </>
            ) : null}
          </CardBody>
        </Card>

        <div className="grid gap-4 lg:col-span-2 lg:grid-cols-2">
          <Card className="lg:col-span-2">
            <CardHeader title="Containers: CPU and memory" description="Sum over all containers, last 60 minutes" />
            <CardBody>
              {points.length < 2 ? (
                <ChartEmpty />
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  <TimeChart data={points} series={[{ key: 'cpu', label: 'CPU', color: 'accent' }]} format={(v) => `${v.toFixed(0)} %`} ariaLabel="Total container CPU usage over the last hour" />
                  <TimeChart data={points} series={[{ key: 'mem', label: 'Memory', color: 'info' }]} format={(v) => bytes(v, 0)} ariaLabel="Total container memory usage over the last hour" />
                </div>
              )}
            </CardBody>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader title="Container network" description="Receive and transmit rate, last 60 minutes" />
            <CardBody>
              {points.length < 2 ? (
                <ChartEmpty />
              ) : (
                <TimeChart
                  data={points}
                  series={[
                    { key: 'netRx', label: 'Received', color: 'healthy' },
                    { key: 'netTx', label: 'Sent', color: 'warning' },
                  ]}
                  format={(v) => `${bytes(v, 0)}/s`}
                  height={160}
                  ariaLabel="Total container network throughput over the last hour"
                />
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Section title="Needs attention" description="Restart loops, failing health checks, crashed containers" to="/containers">
          {containers.isLoading ? (
            <LoadingState rows={2} />
          ) : attention.length === 0 ? (
            <EmptyState icon="check" title="All clear">No container is restarting, unhealthy or crashed.</EmptyState>
          ) : (
            <MiniList>
              {attention.slice(0, 6).map((a) => (
                <li key={a.container.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <Link to={`/containers/${encodeURIComponent(a.container.name)}`} className="font-medium hover:text-accent">{a.container.name}</Link>
                    <div className="text-xs text-muted">{a.detail}</div>
                  </div>
                  <ContainerStatus c={a.container} />
                </li>
              ))}
            </MiniList>
          )}
        </Section>

        <Section title="Updates" description="Available and staged image updates" to="/images">
          {updates.isLoading ? (
            <LoadingState rows={2} />
          ) : pending.length === 0 ? (
            <EmptyState icon="check" title="Everything is up to date">No newer images were found at the last check{updates.data?.images.length ? ` (${updates.data.images.length} checked)` : ''}.</EmptyState>
          ) : (
            <MiniList>
              {pending.slice(0, 6).map((u) => (
                <li key={u.ref} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-sm">{u.ref}</div>
                    <div className="text-xs text-muted">Used by {u.usedBy.length ? u.usedBy.map((x) => x.containerName).join(', ') : 'no container'}</div>
                  </div>
                  <UpdateBadge state={u.state} />
                </li>
              ))}
            </MiniList>
          )}
        </Section>

        <Section title="Next maintenance" description="Upcoming scheduled tasks" to="/maintenance" linkLabel="Maintenance">
          {schedules.isLoading ? (
            <LoadingState rows={2} />
          ) : upcoming.length === 0 ? (
            <EmptyState icon="calendar" title="Nothing scheduled">Create a schedule on the Maintenance page to check or update images automatically.</EmptyState>
          ) : (
            <MiniList>
              {upcoming.map(({ s, at }) => (
                <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{s.name}</div>
                    <div className="text-xs text-muted">{s.jobType.replace('_', ' ')} · {s.mode === 'auto' ? 'automatic' : 'needs approval'}</div>
                  </div>
                  <div className="shrink-0 text-right text-xs">
                    <div className="font-medium">{relativeTime(at)}</div>
                    <div className="text-muted">{dateTime(at)}</div>
                  </div>
                </li>
              ))}
            </MiniList>
          )}
        </Section>

        <Section title="Recent maintenance runs" to="/maintenance" linkLabel="History">
          {runs.isLoading ? (
            <LoadingState rows={2} />
          ) : (runs.data?.runs.length ?? 0) === 0 ? (
            <EmptyState icon="wrench" title="No runs yet">Plans and update runs show up here.</EmptyState>
          ) : (
            <MiniList>
              {runs.data?.runs.slice(0, 6).map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <Link to={`/maintenance/runs/${r.id}`} className="font-medium hover:text-accent">{r.target}</Link>
                    <div className="text-xs text-muted">{r.kind.replace('_', ' ')} · {relativeTime(r.createdAt)} · {r.requestedBy}</div>
                  </div>
                  <RunBadge status={r.status} />
                </li>
              ))}
            </MiniList>
          )}
        </Section>

        <Section title="Recent events" description="Docker events (container lifecycle, health)" to="/logs" linkLabel="All events">
          {events.isLoading ? (
            <LoadingState rows={2} />
          ) : (events.data?.events.length ?? 0) === 0 ? (
            <EmptyState icon="scroll" title="No events yet">Container starts, stops and health changes appear here.</EmptyState>
          ) : (
            <MiniList>
              {events.data?.events.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                  <div className="min-w-0 truncate">
                    <span className="font-medium">{e.name ?? e.actorId.slice(0, 12)}</span>{' '}
                    <span className="text-muted">{e.type} {e.action}</span>
                  </div>
                  <span className="shrink-0 text-xs text-muted">{relativeTime(e.time)}</span>
                </li>
              ))}
            </MiniList>
          )}
        </Section>
      </div>
    </>
  );
}

