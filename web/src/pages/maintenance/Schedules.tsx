import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { q, useAction } from '@/api/hooks';
import type {
  MaintenanceWindow,
  MaintenanceWindowInput,
  Schedule,
  ScheduleInput,
  ScheduleJobType,
} from '@/api/types';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Modal,
  Notice,
  Select,
  Switch,
  type Column,
} from '@/components/ui';
import { CRON_PRESETS, describeCron, WEEKDAYS } from '@/lib/cron';
import { dateTime } from '@/lib/format';
import { useGate } from '@/state/auth';

const JOB_LABEL: Record<ScheduleJobType, string> = {
  image_check: 'Check images for updates',
  image_pull: 'Download newer images (no restart)',
  update: 'Update services',
  cleanup_report: 'Cleanup report (read-only)',
};
const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function CronField({
  cron,
  timezone,
  onChange,
}: {
  cron: string;
  timezone: string;
  onChange: (c: string) => void;
}) {
  const preview = useQuery(q.cronPreview(cron, timezone));
  const human = describeCron(cron);
  return (
    <div>
      <Field label="Schedule (cron)" hint="minute hour day-of-month month day-of-week">
        <Input
          value={cron}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono"
          spellCheck={false}
        />
      </Field>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {CRON_PRESETS.map((p) => (
          <button
            key={p.cron}
            type="button"
            onClick={() => onChange(p.cron)}
            className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="mt-2 text-sm" aria-live="polite">
        {human ? <p className="font-medium">{human}</p> : null}
        {preview.data && !preview.data.valid ? (
          <p className="text-critical">{preview.data.error ?? 'Not a valid cron expression.'}</p>
        ) : null}
        {preview.data?.valid ? (
          <p className="text-muted">
            Next runs: {preview.data.nextRuns.slice(0, 3).map(dateTime).join(' · ')}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ScheduleForm({ initial, onClose }: { initial: Schedule | null; onClose: () => void }) {
  const projects = useQuery(q.projects());
  const windows = useQuery(q.windows());
  const [f, setF] = useState<ScheduleInput>(
    initial
      ? {
          name: initial.name,
          cron: initial.cron,
          timezone: initial.timezone,
          jobType: initial.jobType,
          selector: initial.selector,
          mode: initial.mode,
          windowId: initial.windowId,
          enabled: initial.enabled,
        }
      : {
          name: '',
          cron: '0 3 * * *',
          timezone: localTz(),
          jobType: 'image_check',
          selector: {},
          mode: 'manual',
          windowId: null,
          enabled: true,
        },
  );
  const [error, setError] = useState<string | null>(null);
  const save = useAction(
    (b: ScheduleInput) =>
      initial ? api.put(`/maintenance/schedules/${initial.id}`, b) : api.post('/maintenance/schedules', b),
    { success: 'Schedule saved', invalidate: ['schedules'], quietError: true },
  );
  const submit = async () => {
    setError(null);
    try {
      await save.mutateAsync({ ...f, selector: f.selector?.project ? f.selector : {} });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    }
  };
  const updates = f.jobType === 'update';
  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? 'Edit schedule' : 'New schedule'}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!f.name.trim()}
            onClick={() => void submit()}
          >
            Save
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {error ? <Notice tone="critical">{error}</Notice> : null}
        <Field label="Name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={100} />
        </Field>
        <Field label="What should it do?">
          <Select
            value={f.jobType}
            onChange={(e) =>
              setF({
                ...f,
                jobType: e.target.value as ScheduleJobType,
                mode: e.target.value === 'update' ? f.mode : 'manual',
              })
            }
          >
            {(Object.keys(JOB_LABEL) as ScheduleJobType[]).map((k) => (
              <option key={k} value={k}>
                {JOB_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <CronField cron={f.cron} timezone={f.timezone} onChange={(cron) => setF({ ...f, cron })} />
        <Field label="Time zone">
          <Input value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} />
        </Field>
        <Field label="Project" hint="Leave empty for all projects.">
          <Select
            value={f.selector?.project ?? ''}
            onChange={(e) => setF({ ...f, selector: e.target.value ? { project: e.target.value } : {} })}
          >
            <option value="">All projects</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.name}>{p.name}</option>
            ))}
          </Select>
        </Field>
        {updates ? (
          <>
            <Field
              label="When it finds updates"
              hint="Manual: a plan is prepared and waits for your approval. Automatic: only services allowed by their policy are updated, inside the time window."
            >
              <Select
                value={f.mode}
                onChange={(e) => setF({ ...f, mode: e.target.value as 'manual' | 'auto' })}
              >
                <option value="manual">Prepare a plan and wait for approval</option>
                <option value="auto">Update automatically (policy permitting)</option>
              </Select>
            </Field>
            <Field label="Only inside this maintenance window">
              <Select
                value={f.windowId ?? ''}
                onChange={(e) => setF({ ...f, windowId: e.target.value || null })}
              >
                <option value="">No window restriction</option>
                {(windows.data?.windows ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        ) : null}
        <Switch checked={f.enabled ?? true} onChange={(v) => setF({ ...f, enabled: v })} label="Enabled" />
      </form>
    </Modal>
  );
}

export function SchedulesPanel() {
  const gate = useGate();
  const schedules = useQuery(q.schedules());
  const [edit, setEdit] = useState<Schedule | 'new' | null>(null);
  const [del, setDel] = useState<Schedule | null>(null);
  const block = gate();
  const remove = useAction((id: string) => api.del(`/maintenance/schedules/${id}`), {
    success: 'Schedule deleted',
    invalidate: ['schedules'],
    quietError: true,
  });
  const columns: Column<Schedule>[] = [
    {
      key: 'name',
      header: 'Name',
      sort: (a, b) => a.name.localeCompare(b.name),
      cell: (s) => <span className="font-medium">{s.name}</span>,
    },
    { key: 'job', header: 'Task', cell: (s) => JOB_LABEL[s.jobType] },
    {
      key: 'when',
      header: 'When',
      cell: (s) => (
        <span title={s.cron}>{describeCron(s.cron) ?? <code className="text-xs">{s.cron}</code>}</span>
      ),
    },
    {
      key: 'mode',
      header: 'Mode',
      hideOnSmall: true,
      cell: (s) =>
        s.jobType === 'update' ? (
          <Badge tone={s.mode === 'auto' ? 'warning' : 'info'}>
            {s.mode === 'auto' ? 'automatic' : 'needs approval'}
          </Badge>
        ) : (
          <span className="text-muted">–</span>
        ),
    },
    {
      key: 'next',
      header: 'Next run',
      sort: (a, b) => (a.nextRuns[0] ?? '~').localeCompare(b.nextRuns[0] ?? '~'),
      cell: (s) =>
        s.enabled && s.nextRuns[0] ? dateTime(s.nextRuns[0]) : <Badge tone="inactive">paused</Badge>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (s) => (
        <span className="inline-flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            icon="edit"
            aria-label={`Edit ${s.name}`}
            disabledReason={block}
            onClick={() => setEdit(s)}
          />
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            aria-label={`Delete ${s.name}`}
            disabledReason={block}
            onClick={() => setDel(s)}
          />
        </span>
      ),
    },
  ];
  return (
    <Card>
      <CardHeader
        title="Schedules"
        description="Recurring checks, downloads and updates."
        actions={
          <Button icon="plus" variant="primary" disabledReason={block} onClick={() => setEdit('new')}>
            New schedule
          </Button>
        }
      />
      {schedules.isLoading ? (
        <LoadingState rows={3} />
      ) : schedules.error ? (
        <ErrorState error={schedules.error} onRetry={() => void schedules.refetch()} />
      ) : (
        <DataTable
          caption="Schedules"
          rows={schedules.data?.schedules ?? []}
          rowKey={(s) => s.id}
          columns={columns}
          empty={{
            icon: 'calendar',
            title: 'No schedules',
            text: 'Create one to check for image updates regularly.',
          }}
        />
      )}
      {edit ? <ScheduleForm initial={edit === 'new' ? null : edit} onClose={() => setEdit(null)} /> : null}
      {del ? (
        <ConfirmDialog
          open
          onClose={() => setDel(null)}
          title="Delete schedule"
          target={del.name}
          confirmLabel="Delete"
          impact="The schedule stops running. Past runs stay in the history."
          onConfirm={() => remove.mutateAsync(del.id)}
        />
      ) : null}
    </Card>
  );
}

function WindowForm({ initial, onClose }: { initial: MaintenanceWindow | null; onClose: () => void }) {
  const [f, setF] = useState<MaintenanceWindowInput>(
    initial
      ? {
          name: initial.name,
          days: initial.days,
          start: initial.start,
          end: initial.end,
          timezone: initial.timezone,
          enabled: initial.enabled,
        }
      : { name: '', days: [0], start: '02:00', end: '05:00', timezone: localTz(), enabled: true },
  );
  const [error, setError] = useState<string | null>(null);
  const save = useAction(
    (b: MaintenanceWindowInput) =>
      initial ? api.put(`/maintenance/windows/${initial.id}`, b) : api.post('/maintenance/windows', b),
    { success: 'Window saved', invalidate: ['windows'], quietError: true },
  );
  const submit = async () => {
    setError(null);
    try {
      await save.mutateAsync(f);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? 'Edit window' : 'New maintenance window'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!f.name.trim() || f.days.length === 0}
            onClick={() => void submit()}
          >
            Save
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {error ? <Notice tone="critical">{error}</Notice> : null}
        <Field label="Name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Days</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {WEEKDAYS.map((d) => (
              <Checkbox
                key={d.n}
                label={d.label}
                checked={f.days.includes(d.n)}
                onChange={(v) => setF({ ...f, days: v ? [...f.days, d.n] : f.days.filter((x) => x !== d.n) })}
              />
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From">
            <Input type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
          </Field>
          <Field label="Until">
            <Input type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />
          </Field>
        </div>
        <Field label="Time zone">
          <Input value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} />
        </Field>
        <Switch checked={f.enabled ?? true} onChange={(v) => setF({ ...f, enabled: v })} label="Enabled" />
      </form>
    </Modal>
  );
}

export function WindowsPanel() {
  const gate = useGate();
  const windows = useQuery(q.windows());
  const [edit, setEdit] = useState<MaintenanceWindow | 'new' | null>(null);
  const [del, setDel] = useState<MaintenanceWindow | null>(null);
  const block = gate();
  const remove = useAction((id: string) => api.del(`/maintenance/windows/${id}`), {
    success: 'Window deleted',
    invalidate: ['windows'],
    quietError: true,
  });
  const dayNames = (d: number[]) =>
    WEEKDAYS.filter((w) => d.includes(w.n))
      .map((w) => w.label)
      .join(', ');
  return (
    <Card>
      <CardHeader
        title="Maintenance windows"
        description="Automatic updates only start inside an open window."
        actions={
          <Button icon="plus" variant="primary" disabledReason={block} onClick={() => setEdit('new')}>
            New window
          </Button>
        }
      />
      {windows.isLoading ? (
        <LoadingState rows={2} />
      ) : windows.error ? (
        <ErrorState error={windows.error} />
      ) : (windows.data?.windows.length ?? 0) === 0 ? (
        <EmptyState icon="clock" title="No windows defined">
          Without a window, automatic updates are not allowed to run unattended.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {windows.data?.windows.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <span className="font-medium">{w.name}</span>
              <span className="text-muted">
                {dayNames(w.days)} · {w.start}–{w.end} ({w.timezone})
              </span>
              {!w.enabled ? (
                <Badge tone="inactive">disabled</Badge>
              ) : w.openNow ? (
                <Badge tone="healthy">open now</Badge>
              ) : (
                <Badge tone="info">next {w.nextStart ? dateTime(w.nextStart) : '–'}</Badge>
              )}
              <span className="ml-auto inline-flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  icon="edit"
                  aria-label={`Edit ${w.name}`}
                  disabledReason={block}
                  onClick={() => setEdit(w)}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  aria-label={`Delete ${w.name}`}
                  disabledReason={block}
                  onClick={() => setDel(w)}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      {edit ? <WindowForm initial={edit === 'new' ? null : edit} onClose={() => setEdit(null)} /> : null}
      {del ? (
        <ConfirmDialog
          open
          onClose={() => setDel(null)}
          title="Delete window"
          target={del.name}
          confirmLabel="Delete"
          impact="Schedules that use this window will no longer be restricted to it."
          onConfirm={() => remove.mutateAsync(del.id)}
        />
      ) : null}
    </Card>
  );
}
