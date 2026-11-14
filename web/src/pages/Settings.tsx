import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { q, useAction } from '@/api/hooks';
import type { MonitorSettings, RegistryCredentialInfo } from '@/api/types';
import { ScopeNotice } from '@/components/layout/AppShell';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  KeyValue,
  LoadingState,
  Modal,
  Notice,
  PageHeader,
  Switch,
  TabPanel,
  Tabs,
} from '@/components/ui';
import { bytes, dateTime, duration } from '@/lib/format';
import { useAuth, useGate, useMode } from '@/state/auth';
import { PolicyForm } from './maintenance/Policies';
import { IgnoredPanel } from './settings/Ignored';
import { NotificationsPanel } from './settings/Notifications';
import { PasswordCard, SessionsCard, UsersCard } from './settings/Security';

type Tab = 'general' | 'security' | 'notifications' | 'registries' | 'ignored' | 'updates' | 'thresholds';

function General() {
  const settings = useQuery(q.settings());
  const health = useQuery(q.health());
  const info = useQuery(q.info());
  const { mode } = useMode();
  if (settings.isLoading) return <LoadingState rows={4} />;
  if (settings.error || !settings.data)
    return <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />;
  const s = settings.data;
  const h = health.data;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title="This installation" />
        <CardBody>
          <KeyValue
            items={[
              ['Quaymaster', s.version],
              [
                'Mode',
                mode?.readOnly ? (
                  <Badge key="m" tone="warning">
                    read-only
                  </Badge>
                ) : (
                  <Badge key="m" tone="healthy">
                    read/write
                  </Badge>
                ),
              ],
              ['Managed scope', mode?.managedScope.join(', ') || 'everything'],
              ['Stack folders', mode?.stackPaths.join(', ') || '–'],
              [
                'Docker engine',
                h ? `${h.engineVersion} (API ${h.daemonApiVersion})` : (info.data?.ServerVersion ?? '–'),
              ],
              ['Compose', h?.composeVersion ?? 'not found'],
              [
                'Docker events',
                h ? (
                  <Badge key="e" tone={h.eventStream === 'connected' ? 'healthy' : 'critical'}>
                    {h.eventStream}
                  </Badge>
                ) : (
                  '–'
                ),
              ],
              ['Uptime', h ? duration(h.uptimeSeconds) : '–'],
            ]}
          />
          {mode?.readOnly ? (
            <Notice tone="warning" className="mt-3">
              {mode.readOnlyReason ?? 'Read-only mode is on.'}
            </Notice>
          ) : null}
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Security configuration"
          description="Set at startup through environment variables."
        />
        <CardBody>
          <KeyValue
            items={[
              ['Secure cookies', s.security.cookieSecure ? 'yes' : 'no (plain HTTP)'],
              ['Allowed origins', s.security.publicOrigins.join(', ') || '–'],
              ['Redact all env values', s.security.redactAllEnv ? 'yes' : 'only secret-looking values'],
              ['Session idle timeout', `${s.session.idleMinutes} min`],
              ['Session max age', `${s.session.absoluteHours} h`],
              ['Protected names', s.security.protectedNames.join(', ') || '–'],
            ]}
          />
        </CardBody>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader
          title="Retention"
          description="How long Quaymaster keeps its own records. Configured at startup."
        />
        <CardBody>
          <KeyValue
            items={[
              ['Docker events', `${s.retention.eventDays} days`],
              ['Audit log', `${s.retention.auditDays} days`],
              ['Resource history', `${s.retention.statsHours} hours`],
              ['Recovery images after an update', `${s.retention.rollbackDays} days`],
              ['Cleanup keeps items newer than', `${s.retention.cleanupMinAgeHours} hours`],
              ['Approval expires after', `${s.retention.approvalExpiryHours} hours`],
              ['Refuse updates below free disk', bytes(s.limits.diskFloorBytes)],
            ]}
          />
        </CardBody>
      </Card>
    </div>
  );
}

function Registries() {
  const gate = useGate();
  const creds = useQuery(q.credentials());
  const [adding, setAdding] = useState(false);
  const [del, setDel] = useState<RegistryCredentialInfo | null>(null);
  const [f, setF] = useState({ host: '', username: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const block = gate();
  const save = useAction((b: typeof f) => api.put('/registries/credentials', b), {
    success: 'Credentials saved (encrypted)',
    invalidate: ['credentials', 'updates'],
    quietError: true,
  });
  const remove = useAction((host: string) => api.del(`/registries/credentials/${encodeURIComponent(host)}`), {
    success: 'Credentials removed',
    invalidate: ['credentials'],
    quietError: true,
  });
  const submit = async () => {
    setError(null);
    try {
      await save.mutateAsync(f);
      setAdding(false);
      setF({ host: '', username: '', password: '' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    }
  };
  return (
    <Card>
      <CardHeader
        title="Registry logins"
        description="Used to check and pull images from private registries. Passwords are stored encrypted and never shown."
        actions={
          <Button
            size="sm"
            icon="plus"
            variant="primary"
            disabledReason={block}
            onClick={() => setAdding(true)}
          >
            Add registry
          </Button>
        }
      />
      {creds.isLoading ? (
        <LoadingState rows={2} />
      ) : creds.error ? (
        <ErrorState error={creds.error} />
      ) : (creds.data?.credentials.length ?? 0) === 0 ? (
        <EmptyState icon="lock" title="No registry logins">
          Public images (Docker Hub, GHCR) work without one.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {creds.data?.credentials.map((c) => (
            <li key={c.host} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <span className="font-medium">{c.host}</span>
              <span className="text-muted">{c.username}</span>
              <span className="text-xs text-muted">updated {dateTime(c.updatedAt)}</span>
              <Button
                className="ml-auto"
                size="sm"
                variant="ghost"
                icon="trash"
                aria-label={`Remove ${c.host}`}
                disabledReason={block}
                onClick={() => setDel(c)}
              />
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <Modal
          open
          onClose={() => setAdding(false)}
          title="Add registry login"
          footer={
            <>
              <Button onClick={() => setAdding(false)}>Cancel</Button>
              <Button
                variant="primary"
                loading={save.isPending}
                disabled={!f.host || !f.username || !f.password}
                onClick={() => void submit()}
              >
                Save
              </Button>
            </>
          }
        >
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {error ? <Notice tone="critical">{error}</Notice> : null}
            <Field label="Registry host" hint="For example ghcr.io or registry.example.com:5000">
              <Input
                value={f.host}
                onChange={(e) => setF({ ...f, host: e.target.value })}
                autoComplete="off"
              />
            </Field>
            <Field label="Username">
              <Input
                value={f.username}
                onChange={(e) => setF({ ...f, username: e.target.value })}
                autoComplete="off"
              />
            </Field>
            <Field label="Password or access token" hint="Write-only.">
              <Input
                type="password"
                value={f.password}
                onChange={(e) => setF({ ...f, password: e.target.value })}
                autoComplete="new-password"
              />
            </Field>
          </form>
        </Modal>
      ) : null}
      {del ? (
        <ConfirmDialog
          open
          onClose={() => setDel(null)}
          title="Remove registry login"
          target={del.host}
          confirmLabel="Remove"
          impact="Images from this registry are checked anonymously again; private images will show as unknown."
          onConfirm={() => remove.mutateAsync(del.host)}
        />
      ) : null}
    </Card>
  );
}

function DefaultPolicy() {
  const policies = useQuery(q.policies());
  const [edit, setEdit] = useState(false);
  const rec = policies.data?.policies.find((p) => p.scopeKind === 'global') ?? null;
  const { isAdmin } = useAuth();
  const gate = useGate();
  return (
    <Card>
      <CardHeader
        title="Default update policy"
        description="Applies to everything without a more specific policy. Per-project and per-service policies live under Maintenance → Policies."
        actions={
          <Button size="sm" icon="edit" disabledReason={gate()} onClick={() => setEdit(true)}>
            {rec ? 'Edit' : 'Set default'}
          </Button>
        }
      />
      <CardBody className="text-sm">
        {rec ? (
          <KeyValue
            items={[
              ['Update mode', rec.policy.updateMode ?? 'built-in'],
              ['Critical', rec.policy.critical ? 'yes' : 'no'],
              ['Approval required', rec.policy.requireApproval === false ? 'no' : 'yes'],
              ['Automatic rollback', rec.policy.autoRollback === false ? 'off' : 'on'],
              [
                'Health timeout',
                rec.policy.health?.timeoutSeconds ? `${rec.policy.health.timeoutSeconds}s` : 'built-in',
              ],
            ]}
          />
        ) : (
          <p className="text-muted">
            Built-in defaults: updates are reported only, and every update needs approval.{isAdmin ? '' : ''}
          </p>
        )}
      </CardBody>
      {edit ? (
        <PolicyForm
          initial={rec ?? { scopeKind: 'global', scopeKey: '*', policy: {}, updatedAt: '' }}
          onClose={() => setEdit(false)}
        />
      ) : null}
    </Card>
  );
}

function Thresholds() {
  const gate = useGate();
  const monitors = useQuery(q.monitors());
  const [f, setF] = useState<MonitorSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const block = gate();
  const save = useAction((b: MonitorSettings) => api.put<MonitorSettings>('/monitors/settings', b), {
    success: 'Thresholds saved',
    invalidate: ['monitors'],
    quietError: true,
  });
  if (monitors.isLoading) return <LoadingState rows={3} />;
  if (monitors.error || !monitors.data) return <ErrorState error={monitors.error} />;
  const cur = f ?? monitors.data;
  const set = (k: keyof MonitorSettings, v: number | boolean) => setF({ ...cur, [k]: v });
  const num = (k: keyof MonitorSettings, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        value={String(cur[k])}
        onChange={(e) => set(k, Number(e.target.value))}
        disabled={!!block}
      />
    </Field>
  );
  return (
    <Card>
      <CardHeader
        title="Alert thresholds"
        description="When Quaymaster raises notifications about the host and containers."
      />
      <CardBody>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            save.mutateAsync(cur).then(
              () => setF(null),
              (err: unknown) => setError(err instanceof Error ? err.message : 'Could not save'),
            );
          }}
        >
          {error ? <Notice tone="critical">{error}</Notice> : null}
          <Switch
            checked={cur.enabled}
            disabled={!!block}
            onChange={(v) => set('enabled', v)}
            label="Monitoring alerts enabled"
          />
          <div className="grid gap-4 sm:grid-cols-2">
            {num('diskFreePercentBelow', 'Disk free below (%)')}
            {num('diskFreeBytesBelow', 'Disk free below (bytes)')}
            {num('cpuPercentAbove', 'CPU above (%)')}
            {num('memoryPercentAbove', 'Memory above (%)')}
            {num(
              'sustainSeconds',
              'Sustained for (seconds)',
              'CPU and memory must stay above the limit this long.',
            )}
            {num('restartLoopCount', 'Restart loop: restarts')}
            {num('restartLoopWindowSeconds', 'Restart loop: within (seconds)')}
            {num('upcomingMaintenanceMinutes', 'Warn about maintenance (minutes ahead)')}
          </div>
          <Button
            type="submit"
            variant="primary"
            loading={save.isPending}
            disabledReason={block}
            disabled={!f}
          >
            Save thresholds
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export default function SettingsPage() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<Tab>('general');
  return (
    <>
      <PageHeader title="Settings" />
      <ScopeNotice />
      <Tabs<Tab>
        label="Settings sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'general', label: 'General' },
          { key: 'security', label: 'Security' },
          { key: 'notifications', label: 'Notifications' },
          ...(isAdmin ? [{ key: 'registries' as const, label: 'Registries' }] : []),
          ...(isAdmin ? [{ key: 'ignored' as const, label: 'Ignored projects' }] : []),
          { key: 'updates', label: 'Update policy' },
          { key: 'thresholds', label: 'Thresholds' },
        ]}
      />
      <TabPanel id="general" tab={tab}>
        <General />
      </TabPanel>
      <TabPanel id="security" tab={tab}>
        <div className="space-y-4">
          <PasswordCard />
          <SessionsCard />
          {isAdmin ? <UsersCard /> : null}
        </div>
      </TabPanel>
      <TabPanel id="notifications" tab={tab}>
        <NotificationsPanel />
      </TabPanel>
      <TabPanel id="registries" tab={tab}>
        <Registries />
      </TabPanel>
      <TabPanel id="ignored" tab={tab}>
        <IgnoredPanel />
      </TabPanel>
      <TabPanel id="updates" tab={tab}>
        <DefaultPolicy />
      </TabPanel>
      <TabPanel id="thresholds" tab={tab}>
        <Thresholds />
      </TabPanel>
    </>
  );
}
