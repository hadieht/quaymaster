import { useEffect, useState } from 'react';
import { api } from '@/api/client';
import type {
  ImageSummary,
  NetworkSummary,
  ReclaimReport,
  ResourceRemoveResult,
  StorageCandidate,
  StorageCleanupCategory,
  StorageCleanupPreview,
  StorageCleanupResult,
  VolumeSummary,
} from '@/api/types';
import { Button, Checkbox, ConfirmDialog, Field, Input, Modal, Notice } from '@/components/ui';
import { bytes, dateTime } from '@/lib/format';

/** Estimated versus measured bytes, with the plain-language caveat about shared layers. */
export function ReclaimSummary({ reclaim }: { reclaim: ReclaimReport }) {
  return (
    <div className="space-y-1 text-sm" data-testid="reclaim-summary">
      <p>
        Reclaimed <strong>{bytes(reclaim.reclaimedBytes)}</strong>
        {reclaim.basis === 'estimate' ? ' (estimate — it could not be measured)' : ''}.
      </p>
      <p className="text-xs text-muted">
        Estimated before removal: {bytes(reclaim.estimatedBytes)}
        {reclaim.dfDeltaBytes !== null ? ` · Docker usage dropped by ${bytes(reclaim.dfDeltaBytes)}` : ''}
        {reclaim.freeSpaceDeltaBytes !== null
          ? ` · free space on the Docker disk changed by ${bytes(reclaim.freeSpaceDeltaBytes)}`
          : ''}
        . Layers shared with other images are freed only when the last image using them is removed.
      </p>
      {reclaim.caveat ? (
        <p className="text-xs text-warning" data-testid="reclaim-caveat">
          {reclaim.caveat}
        </p>
      ) : null}
    </div>
  );
}

export const DATA_LOSS_WARNING =
  'This permanently deletes the data in the volume. It cannot be undone and cannot be recovered. Take a backup first.';

interface DialogBase<R> {
  open: boolean;
  onClose: () => void;
  onDone: (r: R) => void;
}

// ---- volumes ---------------------------------------------------------------------------------

export function RemoveVolumeDialog({
  volume,
  open,
  onClose,
  onDone,
}: DialogBase<ResourceRemoveResult> & { volume: VolumeSummary }) {
  const [ack, setAck] = useState(false);
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Delete volume"
      target={volume.name}
      confirmLabel="Delete volume permanently"
      requireText={volume.name}
      impact={
        <span>
          <strong className="text-critical">{DATA_LOSS_WARNING}</strong>
        </span>
      }
      onConfirm={async () => {
        onDone(
          await api.post<ResourceRemoveResult>(`/volumes/${encodeURIComponent(volume.name)}/remove`, {
            confirm: volume.name,
            ...(volume.composeProject ? { acknowledgeComposeProject: ack } : {}),
          }),
        );
      }}
    >
      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">Kind</dt>
        <dd>{volume.anonymous ? 'anonymous (unnamed hash)' : 'named volume'}</dd>
        <dt className="text-muted">Size</dt>
        <dd>{volume.size == null ? 'not measured yet' : bytes(volume.size)}</dd>
        <dt className="text-muted">Created</dt>
        <dd>{volume.createdAt ? dateTime(volume.createdAt) : 'unknown'}</dd>
        <dt className="text-muted">Last known user</dt>
        <dd>
          {volume.composeProject
            ? `Compose project ${volume.composeProject}`
            : 'unknown — no container references it'}
        </dd>
      </dl>
      {volume.composeProject ? (
        <Checkbox
          checked={ack}
          onChange={setAck}
          label={`I know this volume belongs to Compose project “${volume.composeProject}”`}
        />
      ) : null}
    </ConfirmDialog>
  );
}

// ---- networks --------------------------------------------------------------------------------

export function RemoveNetworkDialog({
  network,
  open,
  onClose,
  onDone,
}: DialogBase<ResourceRemoveResult> & { network: NetworkSummary }) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Remove network"
      target={network.name}
      confirmLabel="Remove network"
      impact="The network is removed. Networks hold no data and free no disk space. Docker refuses if a container is attached."
      onConfirm={async () => {
        onDone(
          await api.post<ResourceRemoveResult>(`/networks/${encodeURIComponent(network.id)}/remove`, {
            confirm: network.name,
          }),
        );
      }}
    />
  );
}

// ---- images ----------------------------------------------------------------------------------

const ALL = '__all__';

export function RemoveImageDialog({
  image,
  open,
  onClose,
  onDone,
}: DialogBase<ResourceRemoveResult> & { image: ImageSummary }) {
  const [choice, setChoice] = useState<string>(ALL);
  const multi = image.tags.length > 1;
  const untag = multi && choice !== ALL;
  const label = image.tags[0] ?? image.shortId;
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={untag ? 'Remove tag' : 'Delete image'}
      target={untag ? choice : label}
      confirmLabel={untag ? 'Remove tag' : 'Delete image'}
      impact={
        untag
          ? 'Only this tag is removed. The image and its layers stay, because it has other tags. No disk space is freed.'
          : `The image and all its tags are deleted. About ${bytes(image.size)} is the full size; layers shared with other images are freed only when the last image using them is removed. Images used by any container are refused.`
      }
      onConfirm={async () => {
        onDone(
          await api.post<ResourceRemoveResult>(`/images/${encodeURIComponent(image.id)}/remove`, {
            confirm: untag ? choice : label,
            ...(untag ? { tag: choice } : {}),
          }),
        );
      }}
    >
      {multi ? (
        <fieldset className="space-y-1 text-sm">
          <legend className="mb-1 text-xs text-muted">
            This image has {image.tags.length} tags. Remove:
          </legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="img-choice" checked={choice === ALL} onChange={() => setChoice(ALL)} />
            the whole image (all tags)
          </label>
          {image.tags.map((t) => (
            <label key={t} className="flex items-center gap-2">
              <input type="radio" name="img-choice" checked={choice === t} onChange={() => setChoice(t)} />
              only the tag <span className="font-mono text-xs">{t}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
    </ConfirmDialog>
  );
}

// ---- bulk storage cleanup --------------------------------------------------------------------

const KIND_LABEL: Record<StorageCleanupCategory, string> = {
  unused_networks: 'Unused networks',
  anonymous_volumes: 'Anonymous unused volumes (unnamed hash)',
  named_volumes: 'Named unused volumes',
};

export function StorageCleanupDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (r: StorageCleanupResult) => void;
}) {
  const [networks, setNetworks] = useState(true);
  const [volumes, setVolumes] = useState(false); // volumes are OFF by default
  const [anonymous, setAnonymous] = useState(true);
  const [named, setNamed] = useState(false);
  const [compose, setCompose] = useState(false);
  const [minAge, setMinAge] = useState('24');
  const [preview, setPreview] = useState<StorageCleanupPreview | null>(null);
  const [result, setResult] = useState<StorageCleanupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Red-team RT3-07: a preview belongs to the options it was made with. Changing any option after a preview
  // used to leave the old candidate list on screen, and "Remove" executed the OLD preview.
  useEffect(() => {
    setPreview(null);
    setConfirmOpen(false);
  }, [networks, volumes, anonymous, named, compose, minAge]);
  const categories: StorageCleanupCategory[] = [
    ...(networks ? (['unused_networks'] as const) : []),
    ...(volumes && anonymous ? (['anonymous_volumes'] as const) : []),
    ...(volumes && named ? (['named_volumes'] as const) : []),
  ];

  const doPreview = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setPreview(
        await api.post<StorageCleanupPreview>('/storage/cleanup/preview', {
          categories,
          includeComposeProjectVolumes: volumes && named && compose,
          minAgeHours: Number(minAge) || 0,
        }),
      );
    } catch (e) {
      setPreview(null);
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!preview) return;
    const r = await api.post<StorageCleanupResult>('/storage/cleanup/execute', {
      previewId: preview.previewId,
      confirm: preview.confirmPhrase ?? preview.previewId,
    });
    setResult(r);
    setPreview(null);
    onDone(r);
  };

  const volCount = preview?.candidates.filter((c) => c.kind === 'volume').length ?? 0;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Clean up unused volumes and networks"
      size="lg"
      description="You see exactly what would be removed before anything is deleted. Containers are never touched. Anything a container references (running or stopped), Quaymaster’s own resources and out-of-scope resources are always kept."
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">What to look for</legend>
          <Checkbox checked={networks} onChange={setNetworks} label={KIND_LABEL.unused_networks} />
          <Checkbox
            checked={volumes}
            onChange={setVolumes}
            label="Also clean up unused volumes (deletes data permanently)"
          />
          {volumes ? (
            <div className="ml-6 space-y-2 border-l border-border pl-3">
              <Checkbox checked={anonymous} onChange={setAnonymous} label={KIND_LABEL.anonymous_volumes} />
              <Checkbox checked={named} onChange={setNamed} label={KIND_LABEL.named_volumes} />
              {named ? (
                <Checkbox
                  checked={compose}
                  onChange={setCompose}
                  label="Include volumes that belong to a Compose project (also projects Quaymaster cannot find — they may still exist on disk)"
                />
              ) : null}
            </div>
          ) : null}
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
        <Button
          variant="primary"
          icon="search"
          loading={busy}
          disabled={categories.length === 0}
          onClick={() => void doPreview()}
        >
          Preview
        </Button>
        {error ? <Notice tone="critical">{error}</Notice> : null}
        {result ? (
          <Notice tone="healthy" title={`Removed ${result.removed.length}, skipped ${result.skipped.length}`}>
            <ReclaimSummary reclaim={result.reclaim} />
            {result.skipped.length ? (
              <ul className="mt-2 text-xs">
                {result.skipped.map((s) => (
                  <li key={s.id}>
                    <span className="font-mono">{s.name}</span> — {s.reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </Notice>
        ) : null}
        {preview ? (
          <div className="space-y-3">
            {preview.deletesData ? (
              <Notice tone="critical" title="This permanently deletes data">
                {DATA_LOSS_WARNING}
              </Notice>
            ) : null}
            <Notice
              tone={preview.candidates.length ? 'warning' : 'info'}
              title={`${preview.candidates.length} item(s); about ${bytes(preview.estimatedBytes)} would be freed`}
            >
              Valid until {dateTime(preview.expiresAt)}. Nothing has been removed yet. Networks free no disk
              space.
            </Notice>
            {preview.candidates.length ? (
              <table aria-label="Cleanup candidates" className="w-full text-left text-xs">
                <thead className="text-muted">
                  <tr>
                    <th className="py-1 pr-2">Name</th>
                    <th className="pr-2">Kind</th>
                    <th className="pr-2 text-right">Size</th>
                    <th className="pr-2">Created</th>
                    <th>Last known user</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {preview.candidates.map((c) => (
                    <CandidateRow key={c.id} c={c} />
                  ))}
                </tbody>
              </table>
            ) : null}
            {preview.protected.length ? (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted">
                  {preview.protected.length} protected item(s) will be kept
                </summary>
                <ul className="mt-2 space-y-1 text-xs">
                  {preview.protected.map((p) => (
                    <li key={p.kind + p.name}>
                      <span className="font-mono">{p.name}</span> — {p.reason}
                    </li>
                  ))}
                </ul>
              </details>
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
          target={`${preview.candidates.length} item(s)`}
          impact={
            preview.deletesData ? (
              <span>
                <strong className="text-critical">
                  {volCount} volume(s) will be deleted permanently. {DATA_LOSS_WARNING}
                </strong>
                <ul className="mt-2 max-h-40 overflow-auto font-mono text-xs" aria-label="Volumes to delete">
                  {preview.candidates
                    .filter((c) => c.kind === 'volume')
                    .map((c) => (
                      <li key={c.id}>
                        {c.name}
                        {c.composeProject ? ` (Compose project ${c.composeProject})` : ''}
                      </li>
                    ))}
                </ul>
              </span>
            ) : (
              'The listed networks are removed. Nothing else is touched.'
            )
          }
          confirmLabel="Remove"
          requireText={preview.confirmPhrase ?? undefined}
          onConfirm={execute}
        />
      ) : null}
    </Modal>
  );
}

function CandidateRow({ c }: { c: StorageCandidate }) {
  return (
    <tr>
      <td className="max-w-64 truncate py-1 pr-2 font-mono" title={c.name}>
        {c.name}
      </td>
      <td className="pr-2">
        {c.kind === 'network' ? 'network' : c.anonymous ? 'anonymous volume' : 'named volume'}
      </td>
      <td className="pr-2 text-right">
        {c.kind === 'network' ? '–' : c.size == null ? 'n/a' : bytes(c.size)}
      </td>
      <td className="pr-2">{c.createdAt ? dateTime(c.createdAt) : '–'}</td>
      <td>{c.lastKnownUser ?? 'unknown'}</td>
    </tr>
  );
}
