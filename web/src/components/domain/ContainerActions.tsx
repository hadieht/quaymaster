import { useState } from 'react';
import { api, ApiError } from '@/api/client';
import { useInvalidateDocker } from '@/api/hooks';
import type { ActionRequest, ContainerAction, ContainerSummary } from '@/api/types';
import { Button, Checkbox, ConfirmDialog, Notice, useToast } from '@/components/ui';
import { useGate } from '@/state/auth';

type Pending = Extract<ContainerAction, 'stop' | 'restart' | 'recreate' | 'remove'> | null;

const COPY: Record<NonNullable<Pending>, { title: string; confirm: string; variant: 'danger' | 'primary' | 'secondary' }> = {
  stop: { title: 'Stop container', confirm: 'Stop container', variant: 'danger' },
  restart: { title: 'Restart container', confirm: 'Restart container', variant: 'primary' },
  recreate: { title: 'Recreate container', confirm: 'Recreate container', variant: 'danger' },
  remove: { title: 'Remove container', confirm: 'Remove container', variant: 'danger' },
};

export function useContainerAction() {
  const invalidate = useInvalidateDocker();
  return async (c: Pick<ContainerSummary, 'id' | 'name'>, action: ContainerAction, body: ActionRequest = {}) => {
    const r = await api.post<unknown>(`/containers/${c.id}/actions/${action}`, body);
    invalidate();
    return r;
  };
}

/**
 * start / stop / restart / recreate / remove for one container. Disruptive actions open a
 * confirmation that names the container and states the impact; unavailable actions are disabled
 * with the reason (viewer role, read-only mode, outside managed scope, limited capability).
 */
export function ContainerActions({ c, size = 'sm' }: { c: ContainerSummary; size?: 'sm' | 'md' }) {
  const gate = useGate();
  const toast = useToast();
  const act = useContainerAction();
  const [pending, setPending] = useState<Pending>(null);
  const [applyDrift, setApplyDrift] = useState(false);
  const [confirmNs, setConfirmNs] = useState(false);
  const [needs, setNeeds] = useState<{ drift: boolean; ns: boolean }>({ drift: false, ns: false });

  const base = gate({ mutable: c.mutable, protectedReason: c.protectedReason });
  const running = c.state === 'running' || c.state === 'restarting' || c.state === 'paused';
  const compose = c.composeProject !== null;
  const recreateReason =
    base ??
    (!compose
      ? 'Only Compose-managed containers can be recreated here. Standalone containers are updated from the Maintenance page.'
      : c.capability && c.capability !== 'full'
        ? 'Limited control: the Compose files are not readable or trusted, so this container cannot be recreated.'
        : null);
  const removeReason = base ?? (running ? 'Stop the container first: Quaymaster never force-removes a running container.' : null);

  const quick = async (action: 'start') => {
    try {
      await act(c, action);
      toast.success(`Started ${c.name}`);
    } catch (e) {
      toast.error(`Could not start ${c.name}`, e instanceof Error ? e.message : undefined);
    }
  };

  const close = () => {
    setPending(null);
    setApplyDrift(false);
    setConfirmNs(false);
    setNeeds({ drift: false, ns: false });
  };

  const run = async () => {
    if (!pending) return;
    const body: ActionRequest = {};
    if (pending === 'remove' || pending === 'recreate') body.confirm = c.name;
    if (applyDrift) body.applyDrift = true;
    if (confirmNs) body.confirmNamespaceProvider = true;
    try {
      await act(c, pending, body);
      toast.success(`${COPY[pending].title.split(' ')[0]}: ${c.name}`, pending === 'recreate' ? 'The container was recreated.' : undefined);
    } catch (e) {
      const field = (e instanceof ApiError ? (e.details as { field?: string } | undefined)?.field : undefined) ?? '';
      if (e instanceof ApiError && (e.code === 'blocked_drift' || field === 'confirmNamespaceProvider')) {
        setNeeds({ drift: e.code === 'blocked_drift', ns: e.code !== 'blocked_drift' });
      }
      throw e;
    }
  };

  const impact = (a: NonNullable<Pending>) => {
    switch (a) {
      case 'stop':
        return (
          <>
            <b>{c.name}</b> will be stopped (SIGTERM, then SIGKILL after the grace period). Services that depend on it will lose
            it until it is started again.
          </>
        );
      case 'restart':
        return (
          <>
            <b>{c.name}</b> is stopped and started again. Expect a short interruption; open connections are dropped.
          </>
        );
      case 'recreate':
        return (
          <>
            Compose removes <b>{c.name}</b> and creates a new container from the current Compose configuration. The container ID
            changes and anything stored only inside the container (not in a volume) is lost. Volumes are kept.
          </>
        );
      case 'remove':
        return (
          <>
            The stopped container <b>{c.name}</b> is deleted. Volumes are <b>not</b> removed. This cannot be undone.
          </>
        );
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {!running ? (
          <Button size={size} icon="play" disabledReason={base} onClick={() => void quick('start')}>
            Start
          </Button>
        ) : (
          <Button size={size} icon="stop" disabledReason={base} onClick={() => setPending('stop')}>
            Stop
          </Button>
        )}
        <Button size={size} icon="refresh" disabledReason={base} onClick={() => setPending('restart')}>
          Restart
        </Button>
        <Button size={size} icon="undo" disabledReason={recreateReason} onClick={() => setPending('recreate')}>
          Recreate
        </Button>
        <Button size={size} icon="trash" variant="danger" disabledReason={removeReason} onClick={() => setPending('remove')}>
          Remove
        </Button>
      </div>
      {pending ? (
        <ConfirmDialog
          open
          onClose={close}
          title={COPY[pending].title}
          target={c.name}
          impact={impact(pending)}
          confirmLabel={COPY[pending].confirm}
          variant={COPY[pending].variant === 'primary' ? 'primary' : 'danger'}
          requireText={pending === 'remove' || pending === 'recreate' ? c.name : undefined}
          onConfirm={run}
        >
          {needs.drift ? (
            <Notice tone="warning" title="Configuration drift">
              <div className="mb-2">
                The running container no longer matches its Compose file. Recreating applies those changes, not just an image
                update. Tick the box below to apply them anyway, then confirm again.
              </div>
              <Checkbox checked={applyDrift} onChange={setApplyDrift} label="Apply the drifted configuration" />
            </Notice>
          ) : null}
          {needs.ns ? (
            <Notice tone="warning" title="Other services share this container">
              <div className="mb-2">
                Other services use this container’s network or volumes; recreating it recreates them too.
              </div>
              <Checkbox checked={confirmNs} onChange={setConfirmNs} label="I understand, recreate the dependents too" />
            </Notice>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </>
  );
}
