import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { IconButton } from './Button';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** `drawer` slides in from the right. */
  variant?: 'dialog' | 'drawer';
  size?: 'sm' | 'md' | 'lg';
}

/**
 * Modal on the native <dialog> element: focus is trapped, Escape closes it, focus returns to the
 * trigger, and the page behind is inert — all provided by the browser.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  variant = 'dialog',
  size = 'md',
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  if (!open) return null;
  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' }[size];
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // click on the backdrop
      }}
      className={cn(
        'm-0 h-full max-h-none w-full max-w-none bg-transparent p-0 text-fg backdrop:bg-black/50',
        variant === 'dialog' && 'flex items-center justify-center p-4',
      )}
    >
      <div
        className={cn(
          'flex max-h-full flex-col border border-border bg-surface text-fg shadow-xl',
          variant === 'drawer'
            ? 'ml-auto h-full w-full max-w-xl rounded-l-xl'
            : cn('w-full rounded-xl', widths),
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            {description ? <div className="mt-1 text-sm text-muted">{description}</div> : null}
          </div>
          <IconButton icon="x" label="Close" onClick={onClose} className="-mr-2 -mt-1" />
        </header>
        <div className="qm-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <footer className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </dialog>
  );
}

export const Dialog = Modal;
export function Drawer(props: Omit<ModalProps, 'variant'>) {
  return <Modal {...props} variant="drawer" />;
}
