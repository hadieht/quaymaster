import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageSummary, NetworkSummary, StorageCleanupPreview, VolumeSummary } from '@/api/types';

const post = vi.fn();
vi.mock('@/api/client', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  api: { post: (...a: unknown[]) => post(...a), get: vi.fn() },
}));

import {
  RemoveImageDialog,
  RemoveNetworkDialog,
  RemoveVolumeDialog,
  StorageCleanupDialog,
} from './StorageRemoval';

const reclaim = {
  estimatedBytes: 2048,
  freeSpaceDeltaBytes: 1024,
  dfDeltaBytes: 2048,
  reclaimedBytes: 2048,
  basis: 'df' as const,
  note: '',
};
const vol = (over: Partial<VolumeSummary> = {}): VolumeSummary => ({
  name: 'qmtest-data',
  driver: 'local',
  mountpoint: '/x',
  createdAt: '2026-01-01T00:00:00Z',
  labels: {},
  composeProject: null,
  usedBy: [],
  anonymous: false,
  size: 4096,
  ...over,
});
const img = (over: Partial<ImageSummary> = {}): ImageSummary => ({
  id: 'sha256:' + 'a'.repeat(64),
  shortId: 'aaaaaaaaaaaa',
  tags: ['qmtest/app:1', 'qmtest/app:2'],
  digests: [],
  size: 1000,
  createdAt: '2026-01-01T00:00:00Z',
  containers: [],
  inUse: false,
  ...over,
});

beforeEach(() => {
  post.mockReset();
});

describe('RemoveVolumeDialog', () => {
  it('shows the data-loss warning and only enables deletion after the exact volume name is typed', async () => {
    const onDone = vi.fn();
    post.mockResolvedValue({ kind: 'volume', name: 'qmtest-data', action: 'deleted', reclaim });
    render(<RemoveVolumeDialog open volume={vol()} onClose={() => undefined} onDone={onDone} />);
    expect(screen.getByText(/permanently deletes the data in the volume/i)).toBeInTheDocument();
    expect(screen.getByText(/Take a backup first/)).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'Delete volume permanently' });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'qmtest-dat' } });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'qmtest-data' } });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith('/volumes/qmtest-data/remove', { confirm: 'qmtest-data' });
  });

  it('a Compose-project volume sends the acknowledgement only when it is ticked', async () => {
    post.mockResolvedValue({ kind: 'volume', name: 'p_db', action: 'deleted', reclaim });
    render(
      <RemoveVolumeDialog
        open
        volume={vol({ name: 'p_db', composeProject: 'p' })}
        onClose={() => undefined}
        onDone={() => undefined}
      />,
    );
    expect(screen.getByText(/Compose project p/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'p_db' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete volume permanently' }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith('/volumes/p_db/remove', {
      confirm: 'p_db',
      acknowledgeComposeProject: true,
    });
  });

  it('keeps the dialog open and shows the server refusal', async () => {
    post.mockRejectedValue(new Error('Refused: volume qmtest-data is in use by container c'));
    const onDone = vi.fn();
    render(<RemoveVolumeDialog open volume={vol()} onClose={() => undefined} onDone={onDone} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'qmtest-data' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete volume permanently' }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(await screen.findByText(/in use by container c/)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('RemoveNetworkDialog / RemoveImageDialog', () => {
  it('removes a network by id and sends its name as confirmation', async () => {
    post.mockResolvedValue({ kind: 'network', name: 'n1', action: 'deleted', reclaim });
    const net = {
      id: 'f'.repeat(64),
      name: 'n1',
      driver: 'bridge',
      scope: 'local',
      internal: false,
      composeProject: null,
      containers: [],
      labels: {},
    } satisfies NetworkSummary;
    render(<RemoveNetworkDialog open network={net} onClose={() => undefined} onDone={() => undefined} />);
    expect(screen.getByText(/free no disk space/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove network' }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith(`/networks/${'f'.repeat(64)}/remove`, { confirm: 'n1' });
  });

  it('a multi-tag image offers untag-one-tag versus delete-all and says which one it does', async () => {
    post.mockResolvedValue({
      kind: 'image',
      name: 'x',
      action: 'untagged',
      removedTags: ['qmtest/app:2'],
      reclaim,
    });
    render(<RemoveImageDialog open image={img()} onClose={() => undefined} onDone={() => undefined} />);
    expect(screen.getByText(/all tags/)).toBeInTheDocument();
    expect(
      screen.getByText(/shared with other images are freed only when the last image/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('radio')[1] as HTMLElement);
    // the first "only the tag" radio is qmtest/app:1
    expect(screen.getByText(/Only this tag is removed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag' }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]?.[1]).toEqual({ confirm: 'qmtest/app:1', tag: 'qmtest/app:1' });
  });
});

describe('StorageCleanupDialog', () => {
  const preview = (over: Partial<StorageCleanupPreview> = {}): StorageCleanupPreview => ({
    previewId: '11111111-1111-4111-8111-111111111111',
    expiresAt: '2026-01-01T00:10:00Z',
    categories: ['anonymous_volumes'],
    includeComposeProjectVolumes: false,
    minAgeHours: 24,
    candidates: [
      {
        id: 'volume:qmtest-a',
        kind: 'volume',
        category: 'named_volumes',
        name: 'qmtest-a',
        size: 5000,
        createdAt: '2026-01-01T00:00:00Z',
        ageHours: 48,
        anonymous: false,
        composeProject: null,
        lastKnownUser: null,
        note: '',
      },
      {
        id: 'volume:qmtest-b',
        kind: 'volume',
        category: 'named_volumes',
        name: 'qmtest-b',
        size: 100,
        createdAt: null,
        ageHours: null,
        anonymous: false,
        composeProject: 'old',
        lastKnownUser: 'Compose project old',
        note: '',
      },
    ],
    protected: [{ name: 'qmtest-used', kind: 'volume', reason: 'in use by container x' }],
    estimatedBytes: 5100,
    confirmPhrase: 'delete 2 volumes',
    deletesData: true,
    ...over,
  });

  it('volumes are off by default: only networks are requested until volumes are explicitly enabled', async () => {
    post.mockResolvedValue(preview({ candidates: [], confirmPhrase: null, deletesData: false }));
    render(<StorageCleanupDialog open onClose={() => undefined} onDone={() => undefined} />);
    expect(screen.getByLabelText(/Also clean up unused volumes/)).not.toBeChecked();
    expect(screen.queryByLabelText(/Named unused volumes/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]?.[0]).toBe('/storage/cleanup/preview');
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      categories: ['unused_networks'],
      includeComposeProjectVolumes: false,
    });
  });

  it('enabling volumes defaults to anonymous only; named volumes and Compose volumes are explicit opt-ins', async () => {
    post.mockResolvedValue(preview({ candidates: [], confirmPhrase: null, deletesData: false }));
    render(<StorageCleanupDialog open onClose={() => undefined} onDone={() => undefined} />);
    fireEvent.click(screen.getByLabelText(/Also clean up unused volumes/));
    expect(screen.getByLabelText(/Anonymous unused volumes/)).toBeChecked();
    expect(screen.getByLabelText(/Named unused volumes/)).not.toBeChecked();
    expect(screen.queryByLabelText(/belong to a Compose project/)).toBeNull();
    fireEvent.click(screen.getByLabelText(/Named unused volumes/));
    expect(screen.getByLabelText(/belong to a Compose project/)).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      categories: ['unused_networks', 'anonymous_volumes', 'named_volumes'],
      includeComposeProjectVolumes: false,
    });
  });

  it('previews name, size and last user, warns about data loss, and requires the typed phrase before removing', async () => {
    post.mockResolvedValueOnce(preview());
    const onDone = vi.fn();
    render(<StorageCleanupDialog open onClose={() => undefined} onDone={onDone} />);
    fireEvent.click(screen.getByLabelText(/Also clean up unused volumes/));
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));
    expect(await screen.findByText('qmtest-a')).toBeInTheDocument();
    expect(screen.getByText('Compose project old')).toBeInTheDocument();
    expect(screen.getByText(/This permanently deletes data/)).toBeInTheDocument();
    expect(screen.getByText(/protected item\(s\) will be kept/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Remove 2 item/ }));
    const confirmBtn = screen.getByRole('button', { name: 'Remove' });
    expect(confirmBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type “delete 2 volumes” to confirm/), {
      target: { value: 'delete 2 volume' },
    });
    expect(confirmBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type “delete 2 volumes” to confirm/), {
      target: { value: 'delete 2 volumes' },
    });
    expect(confirmBtn).toBeEnabled();
    post.mockResolvedValueOnce({
      removed: [{ id: 'volume:qmtest-a', name: 'qmtest-a', kind: 'volume', bytes: 5000 }],
      skipped: [{ id: 'volume:qmtest-b', name: 'qmtest-b', reason: 'in use by container late' }],
      reclaim,
    });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(post.mock.calls[1]).toEqual([
      '/storage/cleanup/execute',
      { previewId: '11111111-1111-4111-8111-111111111111', confirm: 'delete 2 volumes' },
    ]);
    expect(await screen.findByTestId('reclaim-summary')).toHaveTextContent('Reclaimed 2.0 KB');
    expect(screen.getByText(/in use by container late/)).toBeInTheDocument();
  });

  it('RT3-07: changing an option after a preview discards it; the confirm dialog names every volume', async () => {
    post.mockResolvedValue(preview());
    render(<StorageCleanupDialog open onClose={() => undefined} onDone={() => undefined} />);
    fireEvent.click(screen.getByLabelText(/Also clean up unused volumes/));
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));
    expect(await screen.findByRole('button', { name: /Remove 2 item/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Remove 2 item/ }));
    const list = screen.getByRole('list', { name: 'Volumes to delete' });
    expect(list).toHaveTextContent('qmtest-a');
    expect(list).toHaveTextContent('qmtest-b (Compose project old)');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // an option change makes the stale preview (and its Remove button) disappear
    fireEvent.click(screen.getByLabelText(/Named unused volumes/));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Remove 2 item/ })).toBeNull());
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a network-only preview needs no typed phrase and shows no data-loss banner', async () => {
    post.mockResolvedValueOnce(
      preview({
        categories: ['unused_networks'],
        candidates: [
          {
            id: 'network:n',
            kind: 'network',
            category: 'unused_networks',
            name: 'qmtest-net',
            size: 0,
            createdAt: null,
            ageHours: null,
            anonymous: false,
            composeProject: null,
            lastKnownUser: null,
            note: '',
          },
        ],
        estimatedBytes: 0,
        confirmPhrase: null,
        deletesData: false,
      }),
    );
    render(<StorageCleanupDialog open onClose={() => undefined} onDone={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));
    expect(await screen.findByText('qmtest-net')).toBeInTheDocument();
    expect(screen.queryByText(/This permanently deletes data/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Remove 1 item/ }));
    expect(screen.queryByRole('textbox', { name: /Type/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled();
  });
});
