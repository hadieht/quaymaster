import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { TONE_CLASSES, type Tone } from '@/lib/status';

/** Status pill. The label is always text (colour is never the only signal). */
export function Badge({
  tone = 'inactive',
  dot = true,
  children,
  className,
  title,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const c = TONE_CLASSES[tone];
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium',
        c.bg,
        c.border,
        c.text,
        className,
      )}
    >
      {dot ? <span className={cn('h-1.5 w-1.5 rounded-full', c.dot)} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-muted', className)}>
      {children}
    </span>
  );
}
