import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { q, useAction } from '@/api/hooks';
import type {
  ChannelTestResult,
  ChannelTypeInfo,
  NotificationChannelInfo,
  NotificationChannelInput,
  Severity,
} from '@/api/types';
import { NOTIFICATION_EVENT_TYPES } from '@/api/types';
import { deliveryTone } from '@/lib/status';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Modal,
  Notice,
  Select,
  Switch,
  useToast,
} from '@/components/ui';
import { dateTime } from '@/lib/format';
import { useGate } from '@/state/auth';

function ChannelForm({
  initial,
  types,
  onClose,
}: {
  initial: NotificationChannelInfo | null;
  types: ChannelTypeInfo[];
  onClose: () => void;
}) {
  const [type, setType] = useState(initial?.type ?? types[0]?.type ?? 'webhook');
  const [name, setName] = useState(initial?.name ?? '');
  const [minSeverity, setMin] = useState<Severity>(initial?.minSeverity ?? 'info');
  const [all, setAll] = useState(initial ? initial.events.includes('*') : true);
  const [events, setEvents] = useState<string[]>(initial?.events.filter((e) => e !== '*') ?? []);
  const [config, setConfig] = useState<Record<string, string>>(() => {
    const c: Record<string, string> = {};
    for (const [k, v] of Object.entries(initial?.config ?? {}))
      c[k] = typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : String(v ?? '');
    return c;
  });
  const [error, setError] = useState<string | null>(null);
  const spec = types.find((t) => t.type === type);
  const save = useAction(
    (b: NotificationChannelInput) =>
      initial
        ? api.patch(`/notifications/channels/${initial.id}`, b)
        : api.post('/notifications/channels', b),
    { success: 'Channel saved', invalidate: ['channels'], quietError: true },
  );
  const submit = async () => {
    setError(null);
    const cfg: Record<string, unknown> = {};
    for (const f of spec?.fields ?? []) {
      const v = (config[f.name] ?? '').trim();
      if (v === '') {
        // editing: an empty secret keeps the stored one
        continue;
      }
      cfg[f.name] =
        f.kind === 'number'
          ? Number(v)
          : f.kind === 'boolean'
            ? v === 'true'
            : f.kind === 'string_list'
              ? v
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
              : v;
    }
    try {
      await save.mutateAsync({ type, name, minSeverity, events: all ? ['*'] : events, config: cfg });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={initial ? 'Edit channel' : 'Add notification channel'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!name.trim() || (!all && events.length === 0)}
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
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Type">
            <Select
              value={type}
              disabled={!!initial}
              onChange={(e) => {
                setType(e.target.value as typeof type);
                setConfig({});
              }}
            >
              {types.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </Field>
        </div>
        {(spec?.fields ?? []).map((f) => (
          <Field
            key={f.name}
            label={`${f.label}${f.required && !initial ? '' : ''}`}
            hint={
              f.secret
                ? initial
                  ? 'Write-only. Leave empty to keep the stored value.'
                  : 'Write-only: it is never shown again.'
                : f.help
            }
          >
            <Input
              type={f.secret ? 'password' : f.kind === 'number' ? 'number' : 'text'}
              autoComplete="off"
              value={config[f.name] ?? ''}
              placeholder={f.kind === 'string_list' ? 'comma separated' : undefined}
              onChange={(e) => setConfig({ ...config, [f.name]: e.target.value })}
            />
          </Field>
        ))}
        <Field label="Minimum severity">
          <Select value={minSeverity} onChange={(e) => setMin(e.target.value as Severity)}>
            <option value="info">Everything (info and above)</option>
            <option value="warning">Warnings and critical</option>
            <option value="critical">Critical only</option>
          </Select>
        </Field>
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Subscriptions</legend>
          <Checkbox checked={all} onChange={setAll} label="All events" />
          {!all ? (
            <div className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
              {NOTIFICATION_EVENT_TYPES.filter((e) => e !== 'test').map((e) => (
                <Checkbox
                  key={e}
                  label={e}
                  checked={events.includes(e)}
                  onChange={(v) => setEvents(v ? [...events, e] : events.filter((x) => x !== e))}
                />
              ))}
            </div>
          ) : null}
        </fieldset>
      </form>
    </Modal>
  );
}

export function NotificationsPanel() {
  const gate = useGate();
  const toast = useToast();
  const channels = useQuery(q.channels());
  const types = useQuery(q.channelTypes());
  const deliveries = useQuery(q.deliveries());
  const [edit, setEdit] = useState<NotificationChannelInfo | 'new' | null>(null);
  const [del, setDel] = useState<NotificationChannelInfo | null>(null);
  const block = gate();
  const toggle = useAction(
    (c: NotificationChannelInfo) => api.patch(`/notifications/channels/${c.id}`, { enabled: !c.enabled }),
    { invalidate: ['channels'] },
  );
  const remove = useAction((id: string) => api.del(`/notifications/channels/${id}`), {
    success: 'Channel deleted',
    invalidate: ['channels'],
    quietError: true,
  });
  const test = useAction(
    (id: string) => api.post<ChannelTestResult>(`/notifications/channels/${id}/test`, {}),
    { invalidate: ['deliveries'], quietError: true },
  );
  const runTest = async (c: NotificationChannelInfo) => {
    try {
      const r = await test.mutateAsync(c.id);
      if (r.ok) toast.success(`Test sent to ${c.name}`, r.httpStatus ? `HTTP ${r.httpStatus}` : undefined);
      else toast.error(`Test to ${c.name} failed`, r.error ?? undefined);
    } catch (e) {
      toast.error(`Test to ${c.name} failed`, e instanceof Error ? e.message : undefined);
    }
  };
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Notification channels"
          description="Where Quaymaster sends alerts and maintenance reports."
          actions={
            <Button
              size="sm"
              icon="plus"
              variant="primary"
              disabledReason={block}
              onClick={() => setEdit('new')}
            >
              Add channel
            </Button>
          }
        />
        {channels.isLoading ? (
          <LoadingState rows={2} />
        ) : channels.error ? (
          <ErrorState error={channels.error} onRetry={() => void channels.refetch()} />
        ) : (channels.data?.length ?? 0) === 0 ? (
          <EmptyState icon="bell" title="No channels yet">
            Add one (ntfy, webhook, Discord, e-mail…) to be told when something needs attention.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {channels.data?.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className="font-medium">{c.name}</span>
                <Badge tone="inactive">{c.type}</Badge>
                <span className="text-xs text-muted">
                  {c.events.includes('*') ? 'all events' : `${c.events.length} event types`} · from{' '}
                  {c.minSeverity}
                </span>
                <span className="ml-auto inline-flex flex-wrap items-center gap-1">
                  <Switch
                    checked={c.enabled}
                    disabled={!!block}
                    onChange={() => toggle.mutate(c)}
                    label={`Enable ${c.name}`}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    disabledReason={block}
                    loading={test.isPending && test.variables === c.id}
                    onClick={() => void runTest(c)}
                  >
                    Send test
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="edit"
                    aria-label={`Edit ${c.name}`}
                    disabledReason={block}
                    onClick={() => setEdit(c)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    aria-label={`Delete ${c.name}`}
                    disabledReason={block}
                    onClick={() => setDel(c)}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Recent deliveries" />
        {(deliveries.data?.length ?? 0) === 0 ? (
          <p className="p-4 text-sm text-muted">Nothing has been sent yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {deliveries.data?.slice(0, 15).map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                <Badge tone={deliveryTone(d.status)}>{d.status}</Badge>
                <span className="font-medium">{d.title}</span>
                <span className="text-xs text-muted">
                  {d.channelName ?? d.channelId} · {dateTime(d.time)}
                </span>
                {d.lastError ? <span className="w-full text-xs text-critical">{d.lastError}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {edit && types.data ? (
        <ChannelForm
          initial={edit === 'new' ? null : edit}
          types={types.data}
          onClose={() => setEdit(null)}
        />
      ) : null}
      {del ? (
        <ConfirmDialog
          open
          onClose={() => setDel(null)}
          title="Delete channel"
          target={del.name}
          confirmLabel="Delete"
          impact="Alerts are no longer sent there."
          onConfirm={() => remove.mutateAsync(del.id)}
        />
      ) : null}
    </div>
  );
}
