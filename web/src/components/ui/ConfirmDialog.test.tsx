import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('names the target and keeps the confirm button disabled until the name is typed', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <ConfirmDialog
        open
        onClose={() => undefined}
        title="Remove container"
        target="qmtest-x"
        impact="It is deleted."
        confirmLabel="Remove"
        requireText="qmtest-x"
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getAllByText('qmtest-x').length).toBeGreaterThan(0);
    const btn = screen.getByRole('button', { name: 'Remove' });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'qmtest-x' } });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });
  it('shows the server error and stays open when the action fails', async () => {
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        open
        onClose={onClose}
        title="Stop"
        target="t"
        impact="x"
        confirmLabel="Stop it"
        onConfirm={() => Promise.reject(new Error('Refused: out of scope'))}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop it' }));
    expect(await screen.findByText(/Refused: out of scope/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
