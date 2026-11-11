import { useEffect, useState, type ReactNode } from 'react';
import { describeError } from '@/api/client';
import { Button, type ButtonVariant } from './Button';
import { Modal } from './Dialog';
import { Notice } from './states';
import { Field, Input } from './Field';

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  /** e.g. "Stop container" */
  title: string;
  /** The exact thing acted upon, shown prominently. */
  target: string;
  /** What will happen / the impact, in plain words. */
  impact: ReactNode;
  confirmLabel: string;
  variant?: ButtonVariant;
  /** When set the user must type this exact text (the target name) to enable the button. */
  requireText?: string;
  children?: ReactNode;
  onConfirm: () => Promise<unknown> | unknown;
}

/** Every disruptive action goes through this dialog: it names the target and states the impact. */
export function ConfirmDialog({
  open,
  onClose,
  title,
  target,
  impact,
  confirmLabel,
  variant = 'danger',
  requireText,
  children,
  onConfirm,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTyped('');
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const typedOk = !requireText || typed === requireText;
  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={variant} onClick={() => void run()} loading={busy} disabled={!typedOk}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="break-all rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-sm">
          {target}
        </div>
        <div className="text-sm">{impact}</div>
        {children}
        {requireText ? (
          <Field label={`Type “${requireText}” to confirm`}>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        ) : null}
        {error ? (
          <Notice tone="critical" title="The action failed">
            {error}
          </Notice>
        ) : null}
      </div>
    </Modal>
  );
}
