import { useState } from 'react';
import { api } from '@/api/client';
import { useInvalidateDocker } from '@/api/hooks';
import type { IgnoreRequest } from '@/api/types';
import { Button, ConfirmDialog, useToast } from '@/components/ui';
import { useAuth, useMode } from '@/state/auth';
import { useNavigate } from 'react-router-dom';

/**
 * "Stop monitoring" for a Compose project or a standalone container. It only adds the name to
 * Quaymaster's own ignore list; the dialog says so explicitly. Administrators only.
 */
export function StopMonitoringButton({
  kind,
  name,
  size = 'sm',
  redirectTo,
}: {
  kind: IgnoreRequest['kind'];
  name: string;
  size?: 'sm' | 'md';
  redirectTo?: string;
}) {
  const { isAdmin } = useAuth();
  const { mode } = useMode();
  const toast = useToast();
  const invalidate = useInvalidateDocker();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const noun = kind === 'project' ? 'project' : 'container';

  const reason = !isAdmin
    ? 'Your account has the viewer role: it can look but not change anything.'
    : mode?.readOnly
      ? (mode.readOnlyReason ?? 'Quaymaster is in read-only mode.')
      : null;

  const run = async () => {
    const body: IgnoreRequest = { kind, name, confirm: name };
    await api.post('/ignored', body);
    invalidate();
    toast.success(`Stopped monitoring ${name}`, 'You can restore it under Settings → Ignored.');
    if (redirectTo) navigate(redirectTo);
  };

  return (
    <>
      <Button size={size} icon="eye" disabledReason={reason} onClick={() => setOpen(true)}>
        Stop monitoring
      </Button>
      {open ? (
        <ConfirmDialog
          open
          onClose={() => setOpen(false)}
          title={`Stop monitoring this ${noun}`}
          target={name}
          confirmLabel="Stop monitoring"
          variant="primary"
          requireText={name}
          impact={
            <>
              Quaymaster will hide this {noun} and refuse all actions on it. This does <b>not</b> stop, remove
              or modify anything: containers, volumes, networks and files stay exactly as they are. You can
              restore monitoring at any time under Settings → Ignored.
            </>
          }
          onConfirm={run}
        />
      ) : null}
    </>
  );
}
