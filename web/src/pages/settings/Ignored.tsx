import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { q, useAction, useInvalidateDocker } from '@/api/hooks';
import type { IgnoredEntry } from '@/api/types';
import { Button, Card, CardHeader, DataTable, ErrorState, LoadingState, type Column } from '@/components/ui';
import { dateTime } from '@/lib/format';
import { useAuth } from '@/state/auth';

/** Projects and containers hidden with "Stop monitoring", each with a Restore button (admin only). */
export function IgnoredPanel() {
  const { isAdmin } = useAuth();
  const list = useQuery(q.ignored());
  const invalidateDocker = useInvalidateDocker();
  const restore = useAction((id: number) => api.del(`/ignored/${id}`), {
    success: 'Monitoring restored',
    invalidate: ['ignored'],
  });

  const columns: Column<IgnoredEntry>[] = [
    { key: 'name', header: 'Name', cell: (e) => <span className="font-medium">{e.name}</span> },
    { key: 'kind', header: 'Type', cell: (e) => (e.kind === 'project' ? 'Compose project' : 'Container') },
    {
      key: 'dir',
      header: 'Folder',
      hideOnSmall: true,
      cell: (e) => <span className="font-mono text-xs text-muted">{e.workingDir || '–'}</span>,
    },
    {
      key: 'when',
      header: 'Ignored',
      hideOnSmall: true,
      cell: (e) => (
        <span className="text-muted">
          {dateTime(e.ignoredAt)} by {e.ignoredBy}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (e) => (
        <Button
          size="sm"
          icon="undo"
          disabledReason={
            isAdmin ? null : 'Your account has the viewer role: it can look but not change anything.'
          }
          loading={restore.isPending && restore.variables === e.id}
          onClick={() => restore.mutate(e.id, { onSuccess: invalidateDocker })}
        >
          Restore
        </Button>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader
        title="Ignored projects"
        description="Hidden from Quaymaster with “Stop monitoring”. Nothing was stopped, removed or modified; restoring makes them visible and manageable again."
      />
      {list.isLoading ? (
        <LoadingState rows={2} />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} title="Could not load the list" />
      ) : (
        <DataTable
          caption="Ignored projects and containers"
          rows={list.data?.entries ?? []}
          rowKey={(e) => String(e.id)}
          columns={columns}
          empty={{
            icon: 'eye',
            title: 'Nothing is ignored',
            text: 'Every project and container is monitored.',
          }}
        />
      )}
    </Card>
  );
}
