import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { describeError } from '@/api/client';
import { Icon, type IconName } from './Icon';
import { Button } from './Button';

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg className={cn('animate-spin text-accent', className)} viewBox="0 0 24 24" fill="none" role="status" aria-label="Loading">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-surface-2', className)} aria-hidden="true" />;
}

export function LoadingState({ label = 'Loading…', rows = 0 }: { label?: string; rows?: number }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-muted" role="status" aria-live="polite">
      {rows > 0 ? (
        <div className="w-full space-y-2" aria-hidden="true">
          {Array.from({ length: rows }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : (
        <Spinner />
      )}
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function EmptyState({
  icon = 'box',
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-muted">
        <Icon name={icon} className="h-5 w-5" />
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {children ? <p className="max-w-md text-sm text-muted">{children}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Something went wrong' }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-critical/10 text-critical">
        <Icon name="alert" className="h-5 w-5" />
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="max-w-md break-words text-sm text-muted">{describeError(error)}</p>
      {onRetry ? (
        <Button size="sm" icon="refresh" onClick={onRetry} className="mt-2">
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Inline notice box, in the shared status colours. */
export function Notice({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: 'info' | 'warning' | 'critical' | 'healthy';
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  const t = {
    info: 'border-info/30 bg-info/10 text-fg',
    warning: 'border-warning/40 bg-warning/10 text-fg',
    critical: 'border-critical/40 bg-critical/10 text-fg',
    healthy: 'border-healthy/40 bg-healthy/10 text-fg',
  }[tone];
  const icon: IconName = tone === 'healthy' ? 'check' : tone === 'info' ? 'info' : 'alert';
  const color = { info: 'text-info', warning: 'text-warning', critical: 'text-critical', healthy: 'text-healthy' }[tone];
  return (
    <div role={tone === 'critical' ? 'alert' : 'note'} className={cn('flex gap-3 rounded-lg border p-3 text-sm', t, className)}>
      <Icon name={icon} className={cn('mt-0.5 h-4 w-4', color)} />
      <div className="min-w-0 flex-1">
        {title ? <div className="font-semibold">{title}</div> : null}
        {children ? <div className={cn('text-muted', title && 'mt-0.5')}>{children}</div> : null}
      </div>
    </div>
  );
}
