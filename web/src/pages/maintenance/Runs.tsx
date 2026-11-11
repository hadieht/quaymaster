import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { q, useAction } from '@/api/hooks';
import type { RunInfo, RunStep } from '@/api/types';
import { RunBadge } from '@/components/domain/badges';
import { OperationModal } from '@/components/domain/OperationModal';
import { PlanView } from '@/components/domain/PlanView';
import { Badge, Button, Card, CardBody, CardHeader, ConfirmDialog, DataTable, EmptyState, ErrorState, KeyValue, LoadingState, Notice, Segmented, TabPanel, Tabs, type Column } from '@/components/ui';
import { dateTime, duration, relativeTime } from '@/lib/format';
import { stepTone } from '@/lib/status';
import { useGate } from '@/state/auth';

export function runDuration(r: RunInfo): string {
  if (!r.startedAt) return '–';
  const end = r.finishedAt ? Date.parse(r.finishedAt) : Date.now();
  return duration(Math.max(0, (end - Date.parse(r.startedAt)) / 1000));
}

const KIND_LABEL: Record<string, string> = { dry_run: 'Dry run', update: 'Update', image_check: 'Image check', image_pull: 'Image pull', cleanup_report: 'Cleanup report' };

export function RunsList({ onlyApprovals = false }: { onlyApprovals?: boolean }) {
  const navigate = useNavigate();
  const runs = useQuery(q.runs(100));
  const [filter, setFilter] = useState<'all' | 'problems'>('all');
  const rows = (runs.data?.runs ?? []).filter((r) => {
    if (onlyApprovals) return r.status === 'awaiting_approval';
    if (filter === 'problems') return ['failed', 'partial', 'rolled_back', 'interrupted', 'blocked', 'approval_stale'].includes(r.status);
    return true;
  });
  const columns: Column<RunInfo>[] = [
    { key: 'created', header: 'When', sort: (a, b) => a.createdAt.localeCompare(b.createdAt), cell: (r) => <span title={dateTime(r.createdAt)}>{relativeTime(r.createdAt)}</span> },
    { key: 'kind', header: 'Kind', hideOnSmall: true, cell: (r) => KIND_LABEL[r.kind] ?? r.kind },
    { key: 'target', header: 'Target', sort: (a, b) => a.target.localeCompare(b.target), cell: (r) => <span className="font-medium">{r.target}</span> },
    { key: 'trigger', header: 'Trigger', hideOnSmall: true, cell: (r) => (r.trigger === 'schedule' ? 'schedule' : r.requestedBy) },
    { key: 'status', header: 'Status', sort: (a, b) => a.status.localeCompare(b.status), cell: (r) => <RunBadge status={r.status} /> },
    { key: 'dur', header: 'Duration', hideOnSmall: true, align: 'right', cell: (r) => runDuration(r) },
  ];
  if (runs.isLoading) return <LoadingState rows={4} />;
  if (runs.error) return <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />;
  return (
    <Card>
      {!onlyApprovals ? (
        <div className="border-b border-border p-3">
          <Segmented
            label="Filter runs"
            value={filter}
            onChange={setFilter}
            options={[
              { key: 'all', label: 'All runs' },
              { key: 'problems', label: 'Needs a look' },
            ]}
          />
        </div>
      ) : null}
      <DataTable
        caption={onlyApprovals ? 'Runs awaiting approval' : 'Run history'}
        rows={rows}
        rowKey={(r) => r.id}
        columns={columns}
        initialSort={{ key: 'created', dir: 'desc' }}
        onRowClick={(r) => navigate(`/maintenance/runs/${r.id}`)}
        empty={{ icon: 'wrench', title: onlyApprovals ? 'Nothing waits for approval' : 'No runs yet', text: onlyApprovals ? 'Planned updates that need a human decision appear here.' : 'Runs from schedules and manual updates are listed here.' }}
      />
    </Card>
  );
}

function stepSummary(s: RunStep): string {
  const d = s.detail;
  if (!d) return '';
  const msg = (d.message ?? d.error ?? d.reason ?? d.detail) as unknown;
  return typeof msg === 'string' ? msg : JSON.stringify(d);
}

export function RunDetailPage() {
  const { id = '' } = useParams();
  const gate = useGate();
  const run = useQuery(q.run(id));
  const [tab, setTab] = useState<'overview' | 'plan' | 'steps' | 'output'>('overview');
  const [confirm, setConfirm] = useState<'approve' | 'reject' | 'restore' | null>(null);
  const [restoreOp, setRestoreOp] = useState<string | null>(null);

  const approve = useAction((hash: string) => api.post(`/maintenance/runs/${id}/approve`, { planHash: hash }), { success: 'Run approved and started', invalidate: ['run', 'runs'], quietError: true });
  const reject = useAction(() => api.post(`/maintenance/runs/${id}/reject`, {}), { success: 'Run rejected', invalidate: ['run', 'runs'], quietError: true });

  if (run.isLoading) return <LoadingState rows={5} />;
  if (run.error || !run.data) return <ErrorState error={run.error ?? new Error('Run not found')} onRetry={() => void run.refetch()} />;
  const r = run.data;
  const block = gate();
  const hasRecovery = r.steps.some((s) => s.step === 'recovery_point' && s.status === 'succeeded');
  const bad = ['failed', 'partial', 'rolled_back', 'interrupted', 'blocked', 'approval_stale'].includes(r.status);

  return (
    <>
      <div className="mb-4">
        <Link to="/maintenance/runs" className="text-sm text-accent hover:underline">
          ← History
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{KIND_LABEL[r.kind] ?? r.kind}: {r.target}</h1>
          <RunBadge status={r.status} />
        </div>
        <p className="mt-1 text-sm text-muted">
          {r.trigger === 'schedule' ? 'Scheduled' : `Requested by ${r.requestedBy}`} · {dateTime(r.createdAt)} · {runDuration(r)}
        </p>
      </div>

      {r.status === 'awaiting_approval' ? (
        <Notice tone="warning" title="Waiting for your approval" className="mb-4">
          <p className="mb-2">Review the plan, then approve exactly this plan. If anything changed in the meantime, approval is refused and the plan must be created again.{r.approvalExpiresAt ? ` Approval expires ${relativeTime(r.approvalExpiresAt)}.` : ''}</p>
          <div className="flex gap-2">
            <Button variant="primary" icon="check" disabledReason={block ?? (r.planHash ? null : 'This run has no plan.')} onClick={() => setConfirm('approve')}>
              Approve…
            </Button>
            <Button variant="danger" icon="x" disabledReason={block} onClick={() => setConfirm('reject')}>
              Reject…
            </Button>
          </div>
        </Notice>
      ) : null}

      {bad ? (
        <Notice tone="critical" title={r.status === 'rolled_back' ? 'The update was rolled back' : 'This run needs attention'} className="mb-4">
          {r.reason ? <p className="mb-2">{r.reason}</p> : null}
          {r.guidance?.length ? (
            <ul className="list-disc space-y-1 pl-5">
              {r.guidance.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          ) : (
            <p>Check the steps below for the failing step.</p>
          )}
          {hasRecovery && r.kind === 'update' ? (
            <div className="mt-3">
              <Button icon="undo" disabledReason={block} onClick={() => setConfirm('restore')}>
                Restore previous version…
              </Button>
            </div>
          ) : null}
        </Notice>
      ) : null}

      {r.result ? (
        <Card className="mb-4">
          <CardHeader title="Result" description={r.result.summary} />
          <CardBody>
            <ul className="space-y-1 text-sm">
              {r.result.services.map((s) => (
                <li key={s.service} className="flex flex-wrap items-center gap-2">
                  <b>{s.service}</b>
                  <Badge tone={s.outcome === 'updated' || s.outcome === 'dependent_recreated' ? 'healthy' : s.outcome === 'skipped' ? 'inactive' : s.outcome === 'rolled_back' ? 'warning' : 'critical'}>{s.outcome.replace(/_/g, ' ')}</Badge>
                  <span className="text-muted">{s.detail}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <Tabs
        label="Run sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'plan', label: 'Plan' },
          { key: 'steps', label: 'Steps', count: r.steps.length },
          { key: 'output', label: 'Output' },
        ]}
      />
      <TabPanel id="overview" tab={tab}>
        <Card>
          <CardBody>
            <KeyValue
              items={[
                ['Status', <RunBadge key="s" status={r.status} />],
                ['Started', r.startedAt ? dateTime(r.startedAt) : 'not started'],
                ['Finished', r.finishedAt ? dateTime(r.finishedAt) : '–'],
                ['Approved by', r.approvedBy ? `${r.approvedBy} (${r.approvedAt ? dateTime(r.approvedAt) : ''})` : '–'],
                ['Plan hash', <span key="h" className="break-all font-mono text-xs">{r.planHash ?? '–'}</span>],
              ]}
            />
          </CardBody>
        </Card>
      </TabPanel>
      <TabPanel id="plan" tab={tab}>
        {r.plan ? <PlanView plan={r.plan} /> : <EmptyState icon="wrench" title="No plan stored for this run" />}
      </TabPanel>
      <TabPanel id="steps" tab={tab}>
        <Card>
          <ol aria-label="Run steps" className="divide-y divide-border">
            {r.steps.map((s) => (
              <li key={s.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                <Badge tone={stepTone(s.status)}>{s.status}</Badge>
                <span className="font-medium">{s.step}</span>
                {s.service ? <span className="text-muted">{s.service}</span> : null}
                <span className="ml-auto text-xs text-muted">{dateTime(s.startedAt)}</span>
                {stepSummary(s) ? <p className="w-full break-words font-mono text-xs text-muted">{stepSummary(s)}</p> : null}
              </li>
            ))}
            {r.steps.length === 0 ? <li className="p-4 text-sm text-muted">No steps recorded yet.</li> : null}
          </ol>
        </Card>
      </TabPanel>
      <TabPanel id="output" tab={tab}>
        <RunOutput id={id} live={r.status === 'running' || r.status === 'approved'} />
      </TabPanel>

      {confirm === 'approve' && r.planHash ? (
        <ConfirmDialog open onClose={() => setConfirm(null)} title="Approve this plan" target={r.target} variant="primary" confirmLabel="Approve and run" impact="The services in this plan are updated now, in the planned order, with the safety checks and rollback rules shown there. Expect the downtime listed in the plan." onConfirm={() => approve.mutateAsync(r.planHash as string)} />
      ) : null}
      {confirm === 'reject' ? <ConfirmDialog open onClose={() => setConfirm(null)} title="Reject this plan" target={r.target} confirmLabel="Reject" impact="Nothing is changed. The plan is discarded." onConfirm={() => reject.mutateAsync(undefined)} /> : null}
      {confirm === 'restore' ? (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          title="Restore previous version"
          target={r.target}
          requireText={r.target}
          confirmLabel="Restore"
          impact="The services of this run are recreated from the images saved before the update. Their data is not rolled back; if the new version migrated a database, check compatibility first."
          onConfirm={async () => {
            const res = await api.post<{ operationId: string }>(`/maintenance/runs/${id}/restore`, { confirm: r.target });
            setRestoreOp(res.operationId);
          }}
        />
      ) : null}
      <OperationModal operationId={restoreOp} title={`Restore ${r.target}`} onClose={() => setRestoreOp(null)} />
    </>
  );
}

function RunOutput({ id, live }: { id: string; live: boolean }) {
  const op = useQuery({ queryKey: ['operation', id], queryFn: () => api.get<{ output: string }>(`/operations/${id}`), refetchInterval: live ? 2000 : false, retry: false });
  if (op.isLoading) return <LoadingState />;
  if (op.error) return <EmptyState icon="scroll" title="No output stored for this run" />;
  return (
    <pre aria-label="Run output" className="qm-scroll max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-2 p-3 font-mono text-xs leading-5">
      {op.data?.output || 'No output.'}
    </pre>
  );
}
