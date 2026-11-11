import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { q, useAction } from '@/api/hooks';
import type { PolicyInput, PolicyRecord, PolicyScopeKind, UpdateMode } from '@/api/types';
import {
  Badge,
  Button,
  Card,
  CardHeader,
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
} from '@/components/ui';
import { useGate } from '@/state/auth';

const MODE_TEXT: Record<UpdateMode, string> = {
  ignore: 'Ignore — never report or update',
  notify: 'Notify — tell me when a newer image exists',
  pull_only: 'Download only — stage the image, never restart',
  auto: 'Automatic — update inside a maintenance window',
};
const KIND_LABEL: Record<PolicyScopeKind, string> = {
  global: 'Default for everything',
  project: 'Project',
  service: 'Service',
  container: 'Container',
};
const keyOf = (k: PolicyScopeKind, key: string) =>
  `/maintenance/policies/${k}/${encodeURIComponent(k === 'global' ? '*' : key)}`;

function describe(p: PolicyInput): string {
  const bits: string[] = [];
  if (p.updateMode) bits.push(p.updateMode.replace('_', ' '));
  if (p.critical) bits.push('critical');
  if (p.requireApproval) bits.push('approval required');
  if (p.autoRollback === true) bits.push('auto rollback');
  if (p.autoRollback === false) bits.push('no auto rollback');
  if (p.health?.timeoutSeconds) bits.push(`health ${p.health.timeoutSeconds}s`);
  if (p.health?.probe) bits.push('HTTP probe');
  return bits.join(' · ') || 'inherits everything';
}

export function PolicyForm({ initial, onClose }: { initial: PolicyRecord | null; onClose: () => void }) {
  const projects = useQuery(q.projects());
  const [kind, setKind] = useState<PolicyScopeKind>(initial?.scopeKind ?? 'project');
  const [key, setKey] = useState(initial?.scopeKey ?? '');
  const [p, setP] = useState<PolicyInput>(initial?.policy ?? {});
  const [probeUrl, setProbeUrl] = useState(initial?.policy.health?.probe?.url ?? '');
  const [probeStatus, setProbeStatus] = useState(String(initial?.policy.health?.probe?.expectStatus ?? 200));
  const [error, setError] = useState<string | null>(null);
  const global = kind === 'global';
  const save = useAction((body: PolicyInput) => api.put(keyOf(kind, key), body), {
    success: 'Policy saved',
    invalidate: ['policies'],
    quietError: true,
  });
  const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));
  const submit = async () => {
    setError(null);
    const body: PolicyInput = { ...p };
    const health = { ...(p.health ?? {}) };
    if (probeUrl.trim()) health.probe = { url: probeUrl.trim(), expectStatus: Number(probeStatus) || 200 };
    else delete health.probe;
    if (Object.keys(health).length) body.health = health;
    else delete body.health;
    try {
      await save.mutateAsync(body);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? 'Edit update policy' : 'New update policy'}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!global && !key.trim()}
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
        {!initial ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Applies to">
              <Select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as PolicyScopeKind);
                  setKey('');
                }}
              >
                {(Object.keys(KIND_LABEL) as PolicyScopeKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            </Field>
            {!global ? (
              <Field
                label={
                  kind === 'service'
                    ? 'Name (project/service)'
                    : kind === 'container'
                      ? 'Container name'
                      : 'Project'
                }
              >
                {kind === 'project' ? (
                  <Select value={key} onChange={(e) => setKey(e.target.value)}>
                    <option value="">Choose…</option>
                    {(projects.data ?? []).map((x) => (
                      <option key={x.name}>{x.name}</option>
                    ))}
                  </Select>
                ) : (
                  <Input value={key} onChange={(e) => setKey(e.target.value)} />
                )}
              </Field>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted">
            {KIND_LABEL[kind]}
            {!global ? `: ${key}` : ''}
          </p>
        )}
        <Field label="Update mode">
          <Select
            value={p.updateMode ?? ''}
            onChange={(e) =>
              setP({ ...p, updateMode: (e.target.value || undefined) as UpdateMode | undefined })
            }
          >
            {!global ? <option value="">Inherit</option> : null}
            {(Object.keys(MODE_TEXT) as UpdateMode[]).map((m) => (
              <option key={m} value={m}>
                {MODE_TEXT[m]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Switch
            checked={!!p.critical}
            onChange={(v) => setP({ ...p, critical: v })}
            label="Critical"
            description="Never updated unattended."
          />
          <Switch
            checked={!!p.requireApproval}
            onChange={(v) => setP({ ...p, requireApproval: v })}
            label="Approval"
            description="A human approves every plan."
          />
          <Switch
            checked={p.autoRollback !== false}
            onChange={(v) => setP({ ...p, autoRollback: v })}
            label="Auto rollback"
            description="Restore the old image if health fails."
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Health timeout (s)">
            <Input
              type="number"
              min={5}
              value={p.health?.timeoutSeconds ?? ''}
              onChange={(e) =>
                setP({
                  ...p,
                  health: {
                    ...p.health,
                    ...(num(e.target.value) !== undefined
                      ? { timeoutSeconds: num(e.target.value) as number }
                      : {}),
                  },
                })
              }
            />
          </Field>
          <Field label="Stable for (s)" hint="For containers without a healthcheck.">
            <Input
              type="number"
              min={0}
              value={p.health?.stabilizationSeconds ?? ''}
              onChange={(e) =>
                setP({
                  ...p,
                  health: {
                    ...p.health,
                    ...(num(e.target.value) !== undefined
                      ? { stabilizationSeconds: num(e.target.value) as number }
                      : {}),
                  },
                })
              }
            />
          </Field>
          <Field label="Parallel updates">
            <Input
              type="number"
              min={1}
              value={p.maxParallel ?? ''}
              onChange={(e) =>
                setP({
                  ...p,
                  ...(num(e.target.value) !== undefined
                    ? { maxParallel: num(e.target.value) as number }
                    : {}),
                })
              }
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
          <Field
            label="HTTP probe URL (optional)"
            hint="Checked once now; it is saved only if it passes against the running version."
          >
            <Input
              type="url"
              value={probeUrl}
              onChange={(e) => setProbeUrl(e.target.value)}
              placeholder="http://…"
            />
          </Field>
          <Field label="Expected status">
            <Input type="number" value={probeStatus} onChange={(e) => setProbeStatus(e.target.value)} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}

export function PoliciesPanel() {
  const gate = useGate();
  const policies = useQuery(q.policies());
  const [edit, setEdit] = useState<PolicyRecord | 'new' | null>(null);
  const [del, setDel] = useState<PolicyRecord | null>(null);
  const block = gate();
  const remove = useAction((r: PolicyRecord) => api.del(keyOf(r.scopeKind, r.scopeKey)), {
    success: 'Policy removed',
    invalidate: ['policies'],
    quietError: true,
  });
  if (policies.isLoading) return <LoadingState rows={3} />;
  if (policies.error) return <ErrorState error={policies.error} onRetry={() => void policies.refetch()} />;
  const list = policies.data?.policies ?? [];
  return (
    <Card>
      <CardHeader
        title="Update policies"
        description="The most specific policy wins: container, then service, project, and the default."
        actions={
          <Button icon="plus" variant="primary" disabledReason={block} onClick={() => setEdit('new')}>
            New policy
          </Button>
        }
      />
      {list.length === 0 ? (
        <EmptyState icon="shield" title="Using built-in defaults">
          New images are reported but never installed unattended, and every update needs approval.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {list.map((r) => (
            <li
              key={r.scopeKind + r.scopeKey}
              className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm"
            >
              <Badge tone={r.scopeKind === 'global' ? 'info' : 'inactive'}>
                {r.scopeKind === 'global' ? 'default' : r.scopeKind}
              </Badge>
              {r.scopeKind !== 'global' ? <span className="font-medium">{r.scopeKey}</span> : null}
              <span className="text-muted">{describe(r.policy)}</span>
              <span className="ml-auto inline-flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  icon="edit"
                  aria-label={`Edit policy ${r.scopeKey}`}
                  disabledReason={block}
                  onClick={() => setEdit(r)}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  aria-label={`Remove policy ${r.scopeKey}`}
                  disabledReason={block}
                  onClick={() => setDel(r)}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      {edit ? <PolicyForm initial={edit === 'new' ? null : edit} onClose={() => setEdit(null)} /> : null}
      {del ? (
        <ConfirmDialog
          open
          onClose={() => setDel(null)}
          title="Remove policy"
          target={del.scopeKind === 'global' ? 'default policy' : del.scopeKey}
          confirmLabel="Remove"
          impact="The scope falls back to the next broader policy."
          onConfirm={() => remove.mutateAsync(del)}
        />
      ) : null}
    </Card>
  );
}
