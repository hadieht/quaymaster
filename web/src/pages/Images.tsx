import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { q, useAction, useInvalidateDocker } from '@/api/hooks';
import type {
  CleanupCategory,
  CleanupPreview,
  CleanupResult,
  ImageSummary,
  ImageUpdateStatus,
} from '@/api/types';
import { UpdateBadge } from '@/components/domain/badges';
import { OperationModal } from '@/components/domain/OperationModal';
import { ScopeNotice } from '@/components/layout/AppShell';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  DataTable,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Modal,
  Notice,
  PageHeader,
  SearchInput,
  Segmented,
  Tag,
  useToast,
  type Column,
} from '@/components/ui';
import { bytes, dateTime, relativeTime, shortDigest } from '@/lib/format';
import { useGate } from '@/state/auth';

type Filter = 'all' | 'used' | 'unused' | 'dangling' | 'updates';

const CATEGORY_LABEL: Record<CleanupCategory, string> = {
  dangling_images: 'Dangling images (no tag)',
  unused_images: 'Unused tagged images',
  stopped_containers: 'Stopped containers',
  expired_rollback: 'Expired rollback images',
};

export default function ImagesPage() {
  const gate = useGate();
  const toast = useToast();
  const invalidate = useInvalidateDocker();
  const images = useQuery(q.images());
  const updates = useQuery(q.updates());
  const staged = useQuery(q.staged());
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [pullRef, setPullRef] = useState('');
  const [op, setOp] = useState<{ id: string; title: string } | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const writeBlock = gate();

  const statusByRef = useMemo(() => {
    const m = new Map<string, ImageUpdateStatus>();
    for (const u of updates.data?.images ?? []) m.set(u.ref, u);
    return m;
  }, [updates.data]);

  const statusOf = (img: ImageSummary): ImageUpdateStatus | undefined => {
    for (const t of img.tags) {
      const s = statusByRef.get(t);
      if (s) return s;
    }
    return undefined;
  };

  const rows = useMemo(() => {
    const n = search.trim().toLowerCase();
    return (images.data ?? []).filter((i) => {
      if (n && !(i.tags.join(' ') + i.id).toLowerCase().includes(n)) return false;
      switch (filter) {
        case 'used':
          return i.inUse;
        case 'unused':
          return !i.inUse;
        case 'dangling':
          return i.tags.length === 0;
        case 'updates': {
          const s = statusOf(i)?.state;
          return s === 'update_available' || s === 'update_staged';
        }
        default:
          return true;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images.data, filter, search, statusByRef]);

  const check = useAction(() => api.post('/updates/check', {}), {
    success: 'Registry check finished',
    invalidate: ['updates'],
  });
  const pull = useAction((ref: string) => api.post<{ operationId: string }>('/images/pull', { ref }), {
    quietError: false,
  });

  const doPull = async (ref: string) => {
    if (!ref.trim()) return;
    const r = await pull.mutateAsync(ref.trim());
    toast.info('Pull started', `${ref} is downloaded and staged; nothing is restarted.`);
    setOp({ id: r.operationId, title: `Pull ${ref}` });
    setPullRef('');
  };

  const counts = {
    all: images.data?.length ?? 0,
    used: images.data?.filter((i) => i.inUse).length ?? 0,
    unused: images.data?.filter((i) => !i.inUse).length ?? 0,
    dangling: images.data?.filter((i) => i.tags.length === 0).length ?? 0,
    updates: (updates.data?.images ?? []).filter(
      (u) => u.state === 'update_available' || u.state === 'update_staged',
    ).length,
  };

  const columns: Column<ImageSummary>[] = [
    {
      key: 'tags',
      header: 'Image',
      sort: (a, b) => (a.tags[0] ?? '~').localeCompare(b.tags[0] ?? '~'),
      cell: (i) =>
        i.tags.length ? (
          <span className="flex max-w-96 flex-col gap-0.5">
            {i.tags.slice(0, 3).map((t) => (
              <span key={t} className="truncate font-mono text-xs">
                {t}
              </span>
            ))}
            {i.tags.length > 3 ? <span className="text-xs text-muted">+{i.tags.length - 3} more</span> : null}
          </span>
        ) : (
          <Tag>dangling</Tag>
        ),
    },
    {
      key: 'id',
      header: 'ID',
      hideOnSmall: true,
      cell: (i) => <span className="font-mono text-xs text-muted">{i.shortId}</span>,
    },
    {
      key: 'size',
      header: 'Size',
      align: 'right',
      sort: (a, b) => a.size - b.size,
      cell: (i) => bytes(i.size),
    },
    {
      key: 'created',
      header: 'Created',
      hideOnSmall: true,
      sort: (a, b) => a.createdAt.localeCompare(b.createdAt),
      cell: (i) => <span title={dateTime(i.createdAt)}>{relativeTime(i.createdAt)}</span>,
    },
    {
      key: 'used',
      header: 'Used by',
      cell: (i) =>
        i.containers.length ? (
          <span className="flex flex-wrap gap-x-2 text-xs">
            {i.containers.slice(0, 3).map((c) => (
              <Link key={c.id} to={`/containers/${c.id}`} className="text-accent hover:underline">
                {c.name}
              </Link>
            ))}
            {i.containers.length > 3 ? <span className="text-muted">+{i.containers.length - 3}</span> : null}
          </span>
        ) : (
          <span className="text-muted">unused</span>
        ),
    },
    {
      key: 'update',
      header: 'Update',
      sort: (a, b) => (statusOf(a)?.state ?? '').localeCompare(statusOf(b)?.state ?? ''),
      cell: (i) => {
        const s = statusOf(i);
        return s ? (
          <span className="inline-flex flex-wrap items-center gap-1" title={s.reason ?? undefined}>
            <UpdateBadge state={s.state} />
            {s.quarantined ? <Badge tone="warning">quarantined</Badge> : null}
          </span>
        ) : (
          <span className="text-muted">–</span>
        );
      },
    },
    {
      key: 'pull',
      header: '',
      align: 'right',
      cell: (i) => {
        const s = statusOf(i);
        return s && s.state === 'update_available' ? (
          <Button
            size="sm"
            icon="download"
            disabledReason={writeBlock}
            onClick={() => void doPull(s.ref).catch(() => undefined)}
          >
            Pull
          </Button>
        ) : null;
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Images"
        description="Pulling only downloads and stages an image. Deploying it is a separate, planned step under Maintenance."
        actions={
          <>
            <Button
              icon="refresh"
              loading={check.isPending}
              disabledReason={writeBlock}
              onClick={() => check.mutate(undefined)}
            >
              Check for updates
            </Button>
            <Button icon="trash" disabledReason={writeBlock} onClick={() => setCleanupOpen(true)}>
              Clean up…
            </Button>
          </>
        }
      />
      <ScopeNotice />

      {(staged.data?.staged.length ?? 0) > 0 ? (
        <Card className="mb-4">
          <CardHeader
            title="Staged updates"
            description="Downloaded and ready. Deploy them from Maintenance."
            actions={
              <Link to="/maintenance" className="text-sm text-accent hover:underline">
                Open Maintenance
              </Link>
            }
          />
          <CardBody>
            <ul className="divide-y divide-border text-sm">
              {staged.data?.staged.map((s) => (
                <li key={s.tag} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="font-mono text-xs">{s.ref}</span>
                  <span className="text-xs text-muted">
                    {shortDigest(s.digest)} · staged {relativeTime(s.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <Card className="mb-4">
        <CardBody>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void doPull(pullRef).catch(() => undefined);
            }}
          >
            <Field
              label="Pull an image"
              hint="For example nginx:1.27 or ghcr.io/owner/app:latest"
              className="min-w-64 flex-1"
            >
              <Input
                value={pullRef}
                onChange={(e) => setPullRef(e.target.value)}
                placeholder="repository:tag"
              />
            </Field>
            <Button
              type="submit"
              icon="download"
              variant="primary"
              loading={pull.isPending}
              disabledReason={writeBlock ?? (pullRef.trim() ? null : 'Enter an image reference first.')}
            >
              Pull
            </Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search tag or ID…"
            label="Search images"
          />
          <Segmented
            label="Filter images"
            value={filter}
            onChange={setFilter}
            options={[
              { key: 'all', label: 'All', count: counts.all },
              { key: 'used', label: 'In use', count: counts.used },
              { key: 'unused', label: 'Unused', count: counts.unused },
              { key: 'dangling', label: 'Dangling', count: counts.dangling },
              { key: 'updates', label: 'Updates', count: counts.updates },
            ]}
          />
        </div>
        {images.isLoading ? (
          <LoadingState rows={5} />
        ) : images.error ? (
          <ErrorState
            error={images.error}
            onRetry={() => void images.refetch()}
            title="Could not load images"
          />
        ) : (
          <DataTable
            caption="Images"
            rows={rows}
            rowKey={(i) => i.id}
            columns={columns}
            initialSort={{ key: 'size', dir: 'desc' }}
            empty={{ icon: 'image', title: 'No images match', text: 'Change the filter or the search.' }}
          />
        )}
      </Card>

      {cleanupOpen ? <CleanupDialog onClose={() => setCleanupOpen(false)} onDone={invalidate} /> : null}
      <OperationModal operationId={op?.id ?? null} title={op?.title ?? ''} onClose={() => setOp(null)} />
    </>
  );
}

function CleanupDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [cats, setCats] = useState<Record<CleanupCategory, boolean>>({
    dangling_images: true,
    unused_images: false,
    stopped_containers: false,
    expired_rollback: true,
  });
  const [minAge, setMinAge] = useState('24');
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<CleanupResult | null>(null);

  const doPreview = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const categories = (Object.keys(cats) as CleanupCategory[]).filter((c) => cats[c]);
      setPreview(
        await api.post<CleanupPreview>('/images/cleanup/preview', {
          categories,
          minAgeHours: Number(minAge) || 0,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!preview) return;
    const r = await api.post<CleanupResult>('/images/cleanup/execute', {
      previewId: preview.previewId,
      confirm: preview.previewId,
    });
    setResult(r);
    setPreview(null);
    onDone();
    toast.success('Cleanup finished', `${r.removed.length} removed, ${bytes(r.reclaimedBytes)} reclaimed`);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Clean up unused images"
      size="lg"
      description="You see exactly what would be removed before anything is deleted. Images used by any container and recovery images that are still needed are never removed."
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">What to look for</legend>
          {(Object.keys(CATEGORY_LABEL) as CleanupCategory[]).map((c) => (
            <Checkbox
              key={c}
              checked={cats[c]}
              onChange={(v) => setCats({ ...cats, [c]: v })}
              label={CATEGORY_LABEL[c]}
            />
          ))}
        </fieldset>
        <Field label="Minimum age (hours)" hint="Items newer than this are kept.">
          <Input
            type="number"
            min={0}
            value={minAge}
            onChange={(e) => setMinAge(e.target.value)}
            className="max-w-32"
          />
        </Field>
        <Button variant="primary" icon="search" loading={busy} onClick={() => void doPreview()}>
          Preview
        </Button>
        {error ? <Notice tone="critical">{error}</Notice> : null}
        {result ? (
          <Notice tone="healthy" title="Done">
            Removed {result.removed.length}, skipped {result.skipped.length}. Reclaimed{' '}
            {bytes(result.reclaimedBytes)}.
          </Notice>
        ) : null}
        {preview ? (
          <div className="space-y-3">
            <Notice
              tone={preview.candidates.length ? 'warning' : 'info'}
              title={`${preview.candidates.length} item(s), ${bytes(preview.totalBytes)} would be reclaimed`}
            >
              The preview is valid until {dateTime(preview.expiresAt)}. Nothing has been removed yet.
            </Notice>
            {preview.candidates.length ? (
              <ul
                aria-label="Cleanup candidates"
                className="qm-scroll max-h-64 divide-y divide-border overflow-auto rounded-lg border border-border text-sm"
              >
                {preview.candidates.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs">{c.name}</span>
                      <span className="text-xs text-muted">
                        {CATEGORY_LABEL[c.category]} · {c.note}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs">{c.size == null ? '–' : bytes(c.size)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {preview.protected.length ? (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted">
                  {preview.protected.length} protected item(s) will be kept
                </summary>
                <ul className="mt-2 space-y-1 text-xs">
                  {preview.protected.map((p) => (
                    <li key={p.name + p.category}>
                      <span className="font-mono">{p.name}</span> — {p.reason}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {preview.reportOnly.unusedVolumes.length || preview.reportOnly.unusedNetworks.length ? (
              <Notice tone="info" title="Reported only, never removed here">
                {preview.reportOnly.unusedVolumes.length} unused volume(s) and{' '}
                {preview.reportOnly.unusedNetworks.length} unused network(s) are not touched.
              </Notice>
            ) : null}
            <Button
              variant="danger"
              icon="trash"
              disabled={!preview.candidates.length}
              onClick={() => setConfirmOpen(true)}
            >
              Remove {preview.candidates.length} item(s)…
            </Button>
          </div>
        ) : null}
      </div>
      {preview ? (
        <ConfirmDialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          title="Remove these items"
          target={`${preview.candidates.length} items`}
          impact={`${preview.candidates.length} item(s) listed in the preview are deleted permanently, reclaiming about ${bytes(preview.totalBytes)}. Nothing else is touched.`}
          confirmLabel="Remove"
          onConfirm={execute}
        />
      ) : null}
    </Modal>
  );
}
