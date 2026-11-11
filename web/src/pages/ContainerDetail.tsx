import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { q } from '@/api/hooks';
import { ApiError } from '@/api/client';
import type { ContainerSummary, InspectData, StatsPoint } from '@/api/types';
import { ContainerActions } from '@/components/domain/ContainerActions';
import { CapabilityBadge, ContainerStatus, HealthBadge } from '@/components/domain/badges';
import { LogViewer } from '@/components/domain/LogViewer';
import { ChartEmpty, TimeChart } from '@/components/domain/TimeChart';
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  KeyValue,
  LoadingState,
  Notice,
  PageHeader,
  Segmented,
  Tabs,
  TabPanel,
  Tag,
} from '@/components/ui';
import { CAPABILITY_TEXT } from '@/lib/status';
import { bytes, dateTime, duration, relativeTime, shortImageId } from '@/lib/format';
import { useLive } from '@/state/live';

type Tab = 'overview' | 'resources' | 'logs' | 'config';

function Table({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <div className="qm-scroll overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
            {head.map((h) => (
              <th key={h} className="px-2 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/60 last:border-0">
              {r.map((c, j) => (
                <td key={j} className="px-2 py-1.5 align-top font-mono text-xs">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Overview({ i, s }: { i: InspectData; s: ContainerSummary | null }) {
  const st = i.State;
  const started = st.StartedAt && !st.StartedAt.startsWith('0001') ? st.StartedAt : null;
  const lastProbe = st.Health?.Log?.[st.Health.Log.length - 1];
  const cmd = [...(Array.isArray(i.Config.Entrypoint) ? i.Config.Entrypoint : i.Config.Entrypoint ? [i.Config.Entrypoint] : []), ...(i.Config.Cmd ?? [])].join(' ');
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="Status" />
        <CardBody>
          <KeyValue
            items={[
              ['State', s ? <ContainerStatus c={s} /> : st.Status],
              ['Health', s ? <HealthBadge health={s.health} /> : '–'],
              ['Started', started ? `${dateTime(started)} (${st.Running ? duration((Date.now() - Date.parse(started)) / 1000) : relativeTime(started)})` : '–'],
              ['Finished', !st.Running && st.FinishedAt && !st.FinishedAt.startsWith('0001') ? `${dateTime(st.FinishedAt)}, exit code ${st.ExitCode}` : '–'],
              ['Restarts', String(i.RestartCount ?? 0)],
              ['Restart policy', i.HostConfig?.RestartPolicy?.Name || 'no'],
              ['OOM killed', st.OOMKilled ? 'yes' : 'no'],
              ...(st.Error ? ([['Error', st.Error]] as [string, string][]) : []),
            ]}
          />
          {lastProbe ? (
            <div className="mt-4 rounded-md border border-border bg-surface-2 p-3 text-xs">
              <div className="mb-1 font-medium">Last health check (exit {lastProbe.ExitCode}, {relativeTime(lastProbe.End)})</div>
              <pre className="whitespace-pre-wrap break-words font-mono text-muted">{lastProbe.Output.trim().slice(0, 600) || '(no output)'}</pre>
            </div>
          ) : null}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Definition" />
        <CardBody>
          <KeyValue
            items={[
              ['Image', <span key="i" className="font-mono text-xs">{i.Config.Image}</span>],
              ['Image ID', <span key="id" className="font-mono text-xs">{shortImageId(i.Image)}</span>],
              ['Container ID', <span key="c" className="font-mono text-xs">{i.Id.slice(0, 12)}</span>],
              ['Created', dateTime(i.Created)],
              ['Command', cmd ? <code key="cmd" className="break-all text-xs">{cmd}</code> : '–'],
              ['User', i.Config.User || 'image default'],
              ['Working dir', i.Config.WorkingDir || '–'],
              ['Project', s?.composeProject ? <Link key="p" className="text-accent hover:underline" to={`/compose/${encodeURIComponent(s.composeProject)}`}>{s.composeProject}{s.composeService ? ` / ${s.composeService}` : ''}</Link> : 'standalone'],
              ['Privileged', i.HostConfig?.Privileged ? 'yes' : 'no'],
            ]}
          />
        </CardBody>
      </Card>
      {s?.capability ? (
        <Card className="lg:col-span-2">
          <CardHeader title="What Quaymaster can do with this container" actions={<CapabilityBadge level={s.capability} />} />
          <CardBody className="text-sm text-muted">{CAPABILITY_TEXT[s.capability].text}</CardBody>
        </Card>
      ) : null}
    </div>
  );
}

function rate(points: StatsPoint[], key: 'netRx' | 'netTx' | 'blkRead' | 'blkWrite') {
  return points.map((p, idx) => {
    const prev = points[idx - 1];
    const dt = prev ? (p.t - prev.t) / 1000 : 0;
    const d = prev && dt > 0 ? Math.max(0, (p[key] - prev[key]) / dt) : 0;
    return d;
  });
}

function Resources({ id, limit }: { id: string; limit: number }) {
  const [range, setRange] = useState<'live' | '60' | '360' | '1440'>('live');
  const live = useLive();
  const seed = useQuery({ ...q.containerStats(id), enabled: range === 'live' });
  const hist = useQuery({ ...q.containerHistory(id, Number(range) || 60), enabled: range !== 'live' });

  const data = useMemo(() => {
    if (range === 'live') {
      const merged = new Map<number, StatsPoint>();
      for (const p of seed.data?.points ?? []) merged.set(p.t, p);
      for (const p of live.series(id)) merged.set(p.t, p);
      const pts = [...merged.values()].sort((a, b) => a.t - b.t).slice(-180);
      const rx = rate(pts, 'netRx');
      const tx = rate(pts, 'netTx');
      const br = rate(pts, 'blkRead');
      const bw = rate(pts, 'blkWrite');
      return pts.map((p, k) => ({ t: p.t, cpu: p.cpu, mem: p.memUsage, rx: rx[k] ?? 0, tx: tx[k] ?? 0, br: br[k] ?? 0, bw: bw[k] ?? 0 }));
    }
    const rows = hist.data?.rollups ?? [];
    return rows.map((r, k) => {
      const prev = rows[k - 1];
      const dt = prev ? (r.minute - prev.minute) * 60 : 0;
      const f = (a: number, b: number | undefined) => (prev && dt > 0 && b !== undefined && a >= b ? (a - b) / dt : 0);
      return {
        t: r.minute * 60_000,
        cpu: r.cpu_avg,
        mem: r.mem_avg,
        rx: f(r.net_rx, prev?.net_rx),
        tx: f(r.net_tx, prev?.net_tx),
        br: f(r.blk_read, prev?.blk_read),
        bw: f(r.blk_write, prev?.blk_write),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, seed.data, hist.data, live.tick, id]);

  const loading = range === 'live' ? seed.isLoading : hist.isLoading;
  return (
    <div className="space-y-4">
      <Segmented
        label="Time range"
        value={range}
        onChange={setRange}
        options={[
          { key: 'live', label: 'Live' },
          { key: '60', label: '1 h' },
          { key: '360', label: '6 h' },
          { key: '1440', label: '24 h' },
        ]}
      />
      {loading ? (
        <LoadingState />
      ) : data.length < 2 ? (
        <Card>
          <CardBody>
            <ChartEmpty>{range === 'live' ? 'Waiting for samples (the container must be running).' : 'No history for this period yet.'}</ChartEmpty>
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="CPU" description="Percent of one core" />
            <CardBody><TimeChart data={data} series={[{ key: 'cpu', label: 'CPU', color: 'accent' }]} format={(v) => `${v.toFixed(1)} %`} ariaLabel="CPU usage" /></CardBody>
          </Card>
          <Card>
            <CardHeader title="Memory" description={limit > 0 ? `Limit ${bytes(limit)}` : 'No memory limit set'} />
            <CardBody><TimeChart data={data} series={[{ key: 'mem', label: 'Memory', color: 'info' }]} format={(v) => bytes(v, 0)} ariaLabel="Memory usage" /></CardBody>
          </Card>
          <Card>
            <CardHeader title="Network" description="Bytes per second" />
            <CardBody><TimeChart data={data} series={[{ key: 'rx', label: 'Received', color: 'healthy' }, { key: 'tx', label: 'Sent', color: 'warning' }]} format={(v) => `${bytes(v, 0)}/s`} ariaLabel="Network throughput" /></CardBody>
          </Card>
          <Card>
            <CardHeader title="Disk I/O" description="Bytes per second" />
            <CardBody><TimeChart data={data} series={[{ key: 'br', label: 'Read', color: 'info' }, { key: 'bw', label: 'Write', color: 'critical' }]} format={(v) => `${bytes(v, 0)}/s`} ariaLabel="Disk throughput" /></CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}

function Config({ i }: { i: InspectData }) {
  const env = [...(i.Config.Env ?? [])].sort();
  const labels = Object.entries(i.Config.Labels ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const ports = Object.entries(i.NetworkSettings?.Ports ?? {}).flatMap(([cp, binds]) =>
    binds && binds.length ? binds.map((b) => [`${b.HostIp || '0.0.0.0'}:${b.HostPort}`, cp]) : [['not published', cp]],
  );
  const nets = Object.entries(i.NetworkSettings?.Networks ?? {});
  return (
    <div className="space-y-4">
      <Notice tone="info" title="Secrets are redacted">
        Values that look like passwords, tokens or keys are replaced by the server before they reach your browser. Quaymaster has
        no way to reveal them.
      </Notice>
      <Card>
        <CardHeader title="Environment" description={`${env.length} variables`} />
        <CardBody>
          {env.length === 0 ? (
            <p className="text-sm text-muted">No environment variables.</p>
          ) : (
            <div className="qm-scroll max-h-80 overflow-auto rounded-md border border-border bg-surface-2 p-2 font-mono text-xs leading-5">
              {env.map((e) => {
                const eq = e.indexOf('=');
                return (
                  <div key={e} className="break-all">
                    <span className="text-accent">{eq < 0 ? e : e.slice(0, eq)}</span>
                    {eq < 0 ? null : <span className="text-muted">=</span>}
                    {eq < 0 ? null : e.slice(eq + 1)}
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Mounts" />
          <CardBody><Table head={['Type', 'Source', 'Target', 'Mode']} empty="No mounts." rows={(i.Mounts ?? []).map((m) => [m.Type, m.Name ?? m.Source, m.Destination, m.RW ? 'rw' : 'ro'])} /></CardBody>
        </Card>
        <Card>
          <CardHeader title="Ports" />
          <CardBody><Table head={['Host', 'Container']} empty="No ports." rows={ports} /></CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Networks" />
          <CardBody><Table head={['Network', 'IP address', 'Gateway', 'Aliases']} empty="Not attached to any network." rows={nets.map(([n, v]) => [n, v.IPAddress || '–', v.Gateway || '–', (v.Aliases ?? []).join(', ') || '–'])} /></CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Labels" description={`${labels.length} labels`} />
          <CardBody><Table head={['Key', 'Value']} empty="No labels." rows={labels.map(([k, v]) => [k, v])} /></CardBody>
        </Card>
      </div>
    </div>
  );
}

export default function ContainerDetail() {
  const { ref = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab | null) ?? 'overview';
  const detail = useQuery(q.container(ref));
  const list = useQuery(q.containers());

  if (detail.isLoading) return <LoadingState />;
  if (detail.error) {
    const nf = detail.error instanceof ApiError && detail.error.status === 404;
    return nf ? (
      <EmptyState icon="box" title="Container not found" action={<Link className="text-accent hover:underline" to="/containers">Back to containers</Link>}>
        “{ref}” does not exist (anymore). It may have been removed or recreated.
      </EmptyState>
    ) : (
      <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
    );
  }
  const d = detail.data!;
  // the detail endpoint's summary has no capability / restart fields: take them from the list
  const fromList = list.data?.find((c) => c.id === d.inspect.Id);
  const summary: ContainerSummary | null = d.summary ? { ...d.summary, ...(fromList ? { capability: fromList.capability } : {}) } : null;

  return (
    <>
      <div className="mb-2 text-sm">
        <Link to="/containers" className="text-muted hover:text-fg">
          ← Containers
        </Link>
      </div>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {d.inspect.Name.replace(/^\//, '')}
            {summary ? <ContainerStatus c={summary} /> : null}
          </span>
        }
        description={<span className="font-mono text-xs">{d.inspect.Config.Image}</span>}
        actions={summary ? <ContainerActions c={summary} size="md" /> : undefined}
      />
      {summary?.protectedReason ? (
        <Notice tone="warning" title="Changes are blocked for this container" className="mb-4">
          {summary.protectedReason}
        </Notice>
      ) : null}
      <Tabs<Tab>
        label="Container sections"
        idPrefix="ctab"
        value={tab}
        onChange={(t) => setParams({ tab: t }, { replace: true })}
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'resources', label: 'Resources' },
          { key: 'logs', label: 'Logs' },
          { key: 'config', label: 'Configuration' },
        ]}
      />
      <TabPanel id="overview" tab={tab} idPrefix="ctab"><Overview i={d.inspect} s={summary} /></TabPanel>
      <TabPanel id="resources" tab={tab} idPrefix="ctab"><Resources id={d.inspect.Id} limit={d.inspect.HostConfig?.Memory ?? 0} /></TabPanel>
      <TabPanel id="logs" tab={tab} idPrefix="ctab"><LogViewer containerRef={d.inspect.Id} name={d.inspect.Name.replace(/^\//, '')} /></TabPanel>
      <TabPanel id="config" tab={tab} idPrefix="ctab"><Config i={d.inspect} /></TabPanel>
      <p className="mt-6 text-xs text-muted"><Tag>{d.inspect.Id.slice(0, 12)}</Tag></p>
    </>
  );
}
