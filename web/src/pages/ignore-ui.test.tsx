import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IgnoredEntry, ProjectReason } from '@/api/types';

const post = vi.fn();
const get = vi.fn();
const del = vi.fn();
vi.mock('@/api/client', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  api: {
    post: (...a: unknown[]) => post(...a),
    get: (...a: unknown[]) => get(...a),
    del: (...a: unknown[]) => del(...a),
  },
}));

let admin = true;
vi.mock('@/state/auth', () => ({
  useAuth: () => ({ isAdmin: admin }),
  useMode: () => ({ mode: { readOnly: false }, isLoading: false }),
}));

import { ToastProvider } from '@/components/ui';
import { ProjectReasons } from '@/components/domain/ProjectReasons';
import { StopMonitoringButton } from '@/components/domain/StopMonitoring';
import { IgnoredPanel } from '@/pages/settings/Ignored';

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  post.mockReset();
  get.mockReset();
  del.mockReset();
  admin = true;
});

describe('ProjectReasons', () => {
  const reasons: ProjectReason[] = [
    {
      code: 'not_mounted',
      message: 'The project folder is not visible inside Quaymaster.',
      hint: 'Mount it read-only.',
    },
    { code: 'file_missing', message: 'compose.yaml does not exist in the folder.' },
  ];
  const hint = { path: '/srv/x', volume: '/srv/x:/srv/x:ro', stackPaths: 'QM_STACK_PATHS=/srv/x' };

  it('shows one message per reason and a copy-pasteable mount hint', () => {
    render(<ProjectReasons reasons={reasons} mountHint={hint} fileAccess="none" />);
    expect(screen.getByText('Project folder is not mounted into Quaymaster')).toBeInTheDocument();
    expect(screen.getByText('The project folder is not visible inside Quaymaster.')).toBeInTheDocument();
    expect(screen.getByText('Mount it read-only.')).toBeInTheDocument();
    expect(screen.getByText('Compose file is missing')).toBeInTheDocument();
    expect(screen.getByText('/srv/x:/srv/x:ro')).toBeInTheDocument();
    expect(screen.getByText('QM_STACK_PATHS=/srv/x')).toBeInTheDocument();
    expect(screen.queryByText(/temporary read-only helper/)).toBeNull();
  });

  it('mentions the read-only helper when files are read that way, and omits the hint without one', () => {
    render(<ProjectReasons reasons={reasons} mountHint={null} fileAccess="helper" />);
    expect(screen.getByText(/temporary read-only helper/)).toBeInTheDocument();
    expect(screen.queryByTestId('mount-hint')).toBeNull();
  });
});

describe('StopMonitoringButton', () => {
  it('keeps the confirm button disabled until the exact name is typed, then posts the ignore request', async () => {
    post.mockResolvedValue({});
    wrap(<StopMonitoringButton kind="project" name="qmtest-app" />);
    fireEvent.click(screen.getByRole('button', { name: /^Stop monitoring/ }));
    expect(document.body.textContent).toMatch(/does not stop,\s*remove or modify anything/);
    const confirm = screen.getAllByRole('button', { name: /^Stop monitoring/ }).at(-1)!;
    expect(confirm).toBeDisabled();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'qmtest-ap' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: 'qmtest-app' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/ignored', {
        kind: 'project',
        name: 'qmtest-app',
        confirm: 'qmtest-app',
      }),
    );
  });

  it('is disabled for viewers', () => {
    admin = false;
    wrap(<StopMonitoringButton kind="container" name="qmtest-c" />);
    expect(screen.getByRole('button', { name: /^Stop monitoring/ })).toBeDisabled();
  });
});

describe('IgnoredPanel', () => {
  const entries: IgnoredEntry[] = [
    {
      id: 7,
      kind: 'project',
      name: 'qmtest-hidden',
      workingDir: '/srv/hidden',
      ignoredAt: '2026-01-01T10:00:00Z',
      ignoredBy: 'admin',
    },
    {
      id: 8,
      kind: 'container',
      name: 'qmtest-solo',
      workingDir: '',
      ignoredAt: '2026-01-02T10:00:00Z',
      ignoredBy: 'admin',
    },
  ];

  it('lists ignored entries and restores one with DELETE /ignored/:id', async () => {
    get.mockResolvedValue({ entries });
    del.mockResolvedValue({});
    wrap(<IgnoredPanel />);
    expect(await screen.findByText('qmtest-hidden')).toBeInTheDocument();
    expect(screen.getByText('qmtest-solo')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Restore' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(del).toHaveBeenCalledWith('/ignored/7'));
  });

  it('shows an empty state', async () => {
    get.mockResolvedValue({ entries: [] });
    wrap(<IgnoredPanel />);
    expect(await screen.findByText('Nothing is ignored')).toBeInTheDocument();
  });
});
