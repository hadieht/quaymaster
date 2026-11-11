import { useEffect } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { q } from '@/api/hooks';
import { openStream } from '@/api/stream';
import { RunBadge } from '@/components/domain/badges';
import { ScopeNotice } from '@/components/layout/AppShell';
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, Tabs } from '@/components/ui';
import { describeCron } from '@/lib/cron';
import { dateTime, relativeTime } from '@/lib/format';
import { PlanPanel } from './maintenance/Plan';
import { PoliciesPanel } from './maintenance/Policies';
import { RunDetailPage, RunsList, runDuration } from './maintenance/Runs';
import { SchedulesPanel, WindowsPanel } from './maintenance/Schedules';

type Tab = 'overview' | 'schedules' | 'plan' | 'approvals' | 'runs' | 'policies';

function Overview() {
  const schedules = useQuery(q.schedules());
  const windows = useQuery(q.windows());
  const runs = useQuery(q.runs(10));
  const updates = useQuery(q.updates());
  const staged = useQuery(q.staged());

  const upcoming = (schedules.data?.schedules ?? [])
    .filter((s) => s.enabled && s.nextRuns[0])
    .map((s) => ({ s, at: s.nextRuns[0] as string }))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, 6);
  const running = (runs.data?.runs ?? []).filter((r) => r.status === 'running' || r.status === 'approved');
  const waiting = (runs.data?.runs ?? []).filter((r) => r.status === 'awaiting_approval');
  const available = (updates.data?.images ?? []).filter((u) => u.state === 'update_available').length;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {running.length ? (
        <Card className="lg:col-span-2">
          <CardHeader title="Running now" />
          <ul className="divide-y divide-border">
            {running.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                <RunBadge status={r.status} />
                <Link to={`/maintenance/runs/${r.id}`} className="font-medium hover:text-accent">
                  {r.target}
                </Link>
                <span className="text-muted">{runDuration(r)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card>
        <CardHeader title="Upcoming" description="Next scheduled tasks" />
        {upcoming.length === 0 ? (
          <EmptyState icon="calendar" title="Nothing scheduled">
            Create a schedule to check for updates regularly.
          </EmptyState>
        ) : (
          <ol className="relative ml-6 space-y-4 border-l border-border py-4 pr-4">
            {upcoming.map(({ s, at }) => (
              <li key={s.id} className="relative pl-4">
                <span
                  className="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full bg-accent"
                  aria-hidden
                />
                <div className="text-sm font-medium">{s.name}</div>
                <div className="text-xs text-muted">
                  {dateTime(at)} ({relativeTime(at)}) · {describeCron(s.cron) ?? s.cron}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
      <Card>
        <CardHeader title="Status" />
        <CardBody className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted">Updates available</span>
            <span className="font-medium">{available}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Staged (downloaded)</span>
            <span className="font-medium">{staged.data?.staged.length ?? 0}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Waiting for approval</span>
            <span className="font-medium">{waiting.length}</span>
          </div>
          <div>
            <div className="mb-1 text-muted">Maintenance windows</div>
            {(windows.data?.windows ?? []).length === 0 ? (
              <span className="text-muted">None defined</span>
            ) : (
              (windows.data?.windows ?? []).map((w) => (
                <div key={w.id} className="flex items-center gap-2">
                  <span>{w.name}</span>
                  {w.openNow ? (
                    <Badge tone="healthy">open now</Badge>
                  ) : (
                    <Badge tone="inactive">
                      {w.nextStart ? `next ${relativeTime(w.nextStart)}` : 'closed'}
                    </Badge>
                  )}
                </div>
              ))
            )}
          </div>
        </CardBody>
      </Card>
      <div className="lg:col-span-2">
        <WindowsPanel />
      </div>
    </div>
  );
}

export default function MaintenancePage() {
  const loc = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const runs = useQuery(q.runs(100));
  const sub = loc.pathname.replace(/^\/maintenance\/?/, '').split('/')[0] || 'overview';
  const tab = (['overview', 'schedules', 'plan', 'approvals', 'runs', 'policies'] as Tab[]).includes(
    sub as Tab,
  )
    ? (sub as Tab)
    : 'overview';
  const detail = sub === 'runs' && loc.pathname.split('/').length > 3;

  useEffect(
    () =>
      openStream('/maintenance', {
        events: {
          run: () => {
            void qc.invalidateQueries({ queryKey: ['runs'] });
            void qc.invalidateQueries({ queryKey: ['run'] });
          },
        },
      }),
    [qc],
  );

  const waiting = (runs.data?.runs ?? []).filter((r) => r.status === 'awaiting_approval').length;
  return (
    <>
      <PageHeader
        title="Maintenance"
        description="Plan, approve and review updates. Nothing changes without a plan you can read first."
      />
      <ScopeNotice />
      {!detail ? (
        <Tabs<Tab>
          label="Maintenance sections"
          value={tab}
          onChange={(k) => navigate(k === 'overview' ? '/maintenance' : `/maintenance/${k}`)}
          tabs={[
            { key: 'overview', label: 'Overview' },
            { key: 'schedules', label: 'Schedules' },
            { key: 'plan', label: 'Plan an update' },
            { key: 'approvals', label: 'Approvals', count: waiting },
            { key: 'runs', label: 'History' },
            { key: 'policies', label: 'Policies' },
          ]}
        />
      ) : null}
      <div className={detail ? '' : 'pt-4'}>
        <Routes>
          <Route index element={<Overview />} />
          <Route path="schedules" element={<SchedulesPanel />} />
          <Route path="plan" element={<PlanPanel />} />
          <Route path="approvals" element={<RunsList onlyApprovals />} />
          <Route path="runs" element={<RunsList />} />
          <Route path="runs/:id" element={<RunDetailPage />} />
          <Route path="policies" element={<PoliciesPanel />} />
          <Route path="*" element={<Navigate to="/maintenance" replace />} />
        </Routes>
      </div>
    </>
  );
}
