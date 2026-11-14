import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/api/client';
import { q, useInvalidateDocker } from '@/api/hooks';
import type { ComposeAction, ComposeServiceInfo } from '@/api/types';
import { CapabilityBadge, ProjectStatus, ServiceStatus } from '@/components/domain/badges';
import { DependencyGraphView } from '@/components/domain/DependencyGraph';
import { OperationModal } from '@/components/domain/OperationModal';
import { ProjectReasons } from '@/components/domain/ProjectReasons';
import { StopMonitoringButton } from '@/components/domain/StopMonitoring';
import { ScopeNotice } from '@/components/layout/AppShell';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  CodeBlock,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  KeyValue,
  LoadingState,
  Notice,
  PageHeader,
  TabPanel,
  Tabs,
  useToast,
  type Column,
} from '@/components/ui';
import { CAPABILITY_TEXT } from '@/lib/status';
import { shortImageId } from '@/lib/format';
import { useGate } from '@/state/auth';

type PendingAction = { action: ComposeAction; service?: string; forceRecreate?: boolean } | null;

const COPY: Record<
  ComposeAction,
  { title: string; label: string; danger: boolean; impact: (t: string) => string }
> = {
  up: {
    title: 'Apply (up)',
    label: 'Run up',
    danger: false,
    impact: (t) =>
      `docker compose up -d runs for ${t}: missing containers are created, changed ones are recreated.`,
  },
  start: {
    title: 'Start',
    label: 'Start',
    danger: false,
    impact: (t) => `Existing stopped containers of ${t} are started.`,
  },
  stop: {
    title: 'Stop',
    label: 'Stop',
    danger: true,
    impact: (t) =>
      `${t} is stopped. Anything that depends on it will stop working until it is started again.`,
  },
  restart: {
    title: 'Restart',
    label: 'Restart',
    danger: true,
    impact: (t) => `${t} is restarted. Expect a short interruption.`,
  },
  down: {
    title: 'Take down',
    label: 'Take down',
    danger: true,
    impact: (t) =>
      `Containers and networks of ${t} are removed. Volumes are kept. The project is unavailable until it is brought up again.`,
  },
  redeploy: {
    title: 'Redeploy',
    label: 'Redeploy',
    danger: true,
    impact: (t) =>
      `${t} is recreated from the current Compose files. Container IDs change; data outside volumes is lost.`,
  },
};

export default function ComposeDetailPage() {
  const { name = '' } = useParams();
  const gate = useGate();
  const toast = useToast();
  const invalidate = useInvalidateDocker();
  const [tab, setTab] = useState<'services' | 'graph' | 'config' | 'validate'>('services');
  const [pending, setPending] = useState<PendingAction>(null);
  const [applyDrift, setApplyDrift] = useState(false);
  const [confirmNs, setConfirmNs] = useState(false);
  const [needs, setNeeds] = useState({ drift: false, ns: false });
  const [op, setOp] = useState<{ id: string; title: string } | null>(null);
  const [validateOn, setValidateOn] = useState(false);

  const detail = useQuery(q.project(name));
  const config = useQuery(q.projectConfig(name, tab === 'config'));
  const validate = useQuery(q.projectValidate(name, validateOn));

  if (detail.isLoading) return <LoadingState rows={5} />;
  if (detail.error || !detail.data)
    return (
      <ErrorState
        error={detail.error ?? new Error('Project not found')}
        onRetry={() => void detail.refetch()}
        title="Could not load this project"
      />
    );

  const { summary, services, graph } = detail.data;
  const level = summary.level;
  const base = gate({ mutable: summary.mutable, protectedReason: summary.protectedReason, level });
  const full = gate({
    mutable: summary.mutable,
    protectedReason: summary.protectedReason,
    level,
    needsFull: true,
  });
  const reasonFor = (a: ComposeAction) => (a === 'start' || a === 'stop' || a === 'restart' ? base : full);
  const target = (p: NonNullable<PendingAction>) => (p.service ? `${name} / ${p.service}` : name);
  const needsName = (p: NonNullable<PendingAction>) =>
    !p.service && (p.action === 'down' || (p.action === 'redeploy' && p.forceRecreate));

  const close = () => {
    setPending(null);
    setApplyDrift(false);
    setConfirmNs(false);
    setNeeds({ drift: false, ns: false });
  };

  const run = async () => {
    if (!pending) return;
    const body: Record<string, unknown> = {};
    if (pending.service) body.service = pending.service;
    if (pending.forceRecreate) body.forceRecreate = true;
    if (needsName(pending)) body.confirm = name;
    if (applyDrift) body.applyDrift = true;
    if (confirmNs) body.confirmNamespaceProvider = true;
    try {
      const r = await api.post<{ operationId: string }>(
        `/compose/projects/${encodeURIComponent(name)}/actions/${pending.action}`,
        body,
      );
      invalidate();
      toast.info(`${COPY[pending.action].title} started`, target(pending));
      setOp({ id: r.operationId, title: `${COPY[pending.action].title}: ${target(pending)}` });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'blocked_drift') setNeeds((n) => ({ ...n, drift: true }));
      if (
        e instanceof ApiError &&
        (e.details as { field?: string } | undefined)?.field === 'confirmNamespaceProvider'
      )
        setNeeds((n) => ({ ...n, ns: true }));
      throw e;
    }
  };

  const serviceColumns: Column<ComposeServiceInfo>[] = [
    {
      key: 'name',
      header: 'Service',
      sort: (a, b) => a.name.localeCompare(b.name),
      cell: (s) => <span className="font-medium">{s.name}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      sort: (a, b) => a.status.localeCompare(b.status),
      cell: (s) => <ServiceStatus status={s.status} />,
    },
    {
      key: 'image',
      header: 'Image',
      hideOnSmall: true,
      cell: (s) => (
        <span className="block max-w-80 truncate font-mono text-xs text-muted">{s.image ?? '–'}</span>
      ),
    },
    {
      key: 'containers',
      header: 'Containers',
      hideOnSmall: true,
      cell: (s) =>
        s.containers.length ? (
          <span className="flex flex-wrap gap-x-2 text-xs">
            {s.containers.map((c) => (
              <Link key={c.id} to={`/containers/${c.id}`} className="text-accent hover:underline">
                {c.name} <span className="font-mono text-muted">{shortImageId(c.imageId)}</span>
              </Link>
            ))}
          </span>
        ) : (
          <span className="text-muted">none</span>
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      cell: (s) => (
        <span className="inline-flex gap-1">
          {(['restart', 'stop', 'start'] as const).map((a) => (
            <Button
              key={a}
              size="sm"
              variant="ghost"
              disabledReason={base}
              onClick={() => setPending({ action: a, service: s.name })}
            >
              {COPY[a].label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            disabledReason={full}
            onClick={() => setPending({ action: 'up', service: s.name })}
          >
            Recreate
          </Button>
        </span>
      ),
    },
  ];

  const projectActions: {
    a: ComposeAction;
    icon: 'play' | 'stop' | 'refresh' | 'trash' | 'upload' | 'undo';
  }[] = [
    { a: 'start', icon: 'play' },
    { a: 'stop', icon: 'stop' },
    { a: 'restart', icon: 'refresh' },
    { a: 'up', icon: 'upload' },
    { a: 'redeploy', icon: 'undo' },
    { a: 'down', icon: 'trash' },
  ];

  return (
    <>
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-3">
            {name}
            <ProjectStatus status={summary.status} />
            <CapabilityBadge level={level} />
          </span>
        }
        description={
          <Link to="/compose" className="text-accent hover:underline">
            ← All projects
          </Link>
        }
        actions={
          <div className="flex flex-wrap gap-1.5">
            <StopMonitoringButton kind="project" name={name} redirectTo="/compose" />
            {projectActions.map(({ a, icon }) => (
              <Button
                key={a}
                size="sm"
                icon={icon}
                variant={a === 'down' ? 'danger' : 'secondary'}
                disabledReason={reasonFor(a)}
                onClick={() => setPending({ action: a })}
              >
                {a === 'up' ? 'Apply (up)' : COPY[a].label}
              </Button>
            ))}
          </div>
        }
      />
      <ScopeNotice />
      {level === 'full' || !summary.reasonDetails?.length ? (
        <Notice
          tone={level === 'full' ? 'info' : 'warning'}
          title={CAPABILITY_TEXT[level].label}
          className="mb-4"
        >
          {CAPABILITY_TEXT[level].text}
        </Notice>
      ) : (
        <ProjectReasons
          reasons={summary.reasonDetails}
          mountHint={summary.mountHint}
          fileAccess={summary.fileAccess}
        />
      )}
      <Tabs
        label="Project sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'services', label: 'Services', count: services.length },
          { key: 'graph', label: 'Dependencies' },
          { key: 'config', label: 'Configuration' },
          { key: 'validate', label: 'Validation' },
        ]}
      />
      <TabPanel id="services" tab={tab}>
        <Card>
          <DataTable
            caption="Services"
            rows={services}
            rowKey={(s) => s.name}
            columns={serviceColumns}
            initialSort={{ key: 'name', dir: 'asc' }}
            empty={{ title: 'No services', icon: 'layers' }}
          />
        </Card>
        <Card className="mt-4">
          <CardHeader title="Details" />
          <CardBody>
            <KeyValue
              items={[
                ['Compose versions', summary.composeVersions.join(', ') || '–'],
                ['Services', String(services.length)],
                [
                  'Start order',
                  graph.order.join(' → ') || (graph.cycle ? `cycle: ${graph.cycle.join(' → ')}` : '–'),
                ],
              ]}
            />
          </CardBody>
        </Card>
      </TabPanel>
      <TabPanel id="graph" tab={tab}>
        <Card>
          <CardHeader
            title="Dependencies"
            description="Arrows point from a service to what it needs. Dependencies start first."
          />
          <CardBody>
            {graph.nodes.length ? (
              <DependencyGraphView
                graph={graph}
                statusOf={(s) => services.find((x) => x.name === s)?.status}
              />
            ) : (
              <EmptyState icon="link" title="No dependencies">
                None of the services declare depends_on or a shared network or volumes.
              </EmptyState>
            )}
          </CardBody>
        </Card>
      </TabPanel>
      <TabPanel id="config" tab={tab}>
        <Card>
          <CardHeader
            title="Resolved configuration"
            description="Secrets are replaced by redaction markers by the server."
          />
          <CardBody>
            {level !== 'full' && summary.fileAccess !== 'helper' ? (
              <EmptyState icon="lock" title="Not available">
                The configuration is only shown for projects with full control, or when Quaymaster can read
                the project files through the read-only helper.
              </EmptyState>
            ) : config.isLoading ? (
              <LoadingState />
            ) : config.error ? (
              <ErrorState
                error={config.error}
                onRetry={() => void config.refetch()}
                title="Could not read the configuration"
              />
            ) : (
              <>
                {config.data?.source === 'files' ? (
                  <Notice tone="info" title="Read from the project files" className="mb-2">
                    Shown read-only and not resolved by Compose.
                    {config.data.files?.length ? ` Files: ${config.data.files.join(', ')}.` : ''}
                    {config.data.envKeys?.length
                      ? ` Variables defined in .env (values are never shown): ${config.data.envKeys.join(', ')}.`
                      : ''}
                  </Notice>
                ) : null}
                {config.data?.warnings.map((w) => (
                  <Notice key={w} tone="warning" className="mb-2">
                    {w}
                  </Notice>
                ))}
                <CodeBlock maxHeight="32rem">{JSON.stringify(config.data?.config, null, 2)}</CodeBlock>
              </>
            )}
          </CardBody>
        </Card>
      </TabPanel>
      <TabPanel id="validate" tab={tab}>
        <Card>
          <CardHeader
            title="Validation"
            description="Runs docker compose config --quiet. Unset variables count as errors."
            actions={
              <Button
                size="sm"
                icon="check"
                disabledReason={level !== 'full' ? 'Only available with full control.' : null}
                loading={validate.isFetching}
                onClick={() => (validateOn ? void validate.refetch() : setValidateOn(true))}
              >
                Validate now
              </Button>
            }
          />
          <CardBody>
            {!validateOn ? (
              <p className="text-sm text-muted">Press “Validate now” to check the project files.</p>
            ) : validate.error ? (
              <ErrorState error={validate.error} title="Validation could not run" />
            ) : validate.data ? (
              <div className="space-y-2">
                <Notice
                  tone={validate.data.valid ? 'healthy' : 'critical'}
                  title={validate.data.valid ? 'The project is valid' : 'The project has errors'}
                >
                  {validate.data.valid ? 'Compose accepts the configuration.' : 'Fix these before deploying.'}
                </Notice>
                {validate.data.errors.map((e) => (
                  <CodeBlock key={e}>{e}</CodeBlock>
                ))}
                {validate.data.warnings.map((w) => (
                  <Notice key={w} tone="warning">
                    {w}
                  </Notice>
                ))}
              </div>
            ) : (
              <LoadingState />
            )}
          </CardBody>
        </Card>
      </TabPanel>

      {pending ? (
        <ConfirmDialog
          open
          onClose={close}
          title={COPY[pending.action].title}
          target={target(pending)}
          impact={COPY[pending.action].impact(target(pending))}
          confirmLabel={COPY[pending.action].label}
          variant={COPY[pending.action].danger ? 'danger' : 'primary'}
          requireText={needsName(pending) ? name : undefined}
          onConfirm={run}
        >
          {pending.action === 'redeploy' ? (
            <div className="mt-3">
              <Checkbox
                checked={!!pending.forceRecreate}
                onChange={(v) => setPending({ ...pending, forceRecreate: v })}
                label="Force recreate all containers (needs the project name typed)"
              />
            </div>
          ) : null}
          {needs.drift ? (
            <Notice tone="warning" title="Configuration drift" className="mt-3">
              <div className="mb-2">
                The running containers no longer match the Compose files. Applying changes more than the
                image. Tick to apply anyway, then confirm again.
              </div>
              <Checkbox
                checked={applyDrift}
                onChange={setApplyDrift}
                label="Apply the drifted configuration"
              />
            </Notice>
          ) : null}
          {needs.ns ? (
            <Notice tone="warning" title="Other services share this one" className="mt-3">
              <Checkbox
                checked={confirmNs}
                onChange={setConfirmNs}
                label="I understand, recreate the dependents too"
              />
            </Notice>
          ) : null}
        </ConfirmDialog>
      ) : null}
      <OperationModal operationId={op?.id ?? null} title={op?.title ?? ''} onClose={() => setOp(null)} />
    </>
  );
}
