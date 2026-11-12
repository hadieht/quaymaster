import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { TONE_CLASSES, type Tone } from '@/lib/status';
import { Icon, type IconName } from './Icon';

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-xl border border-border bg-surface shadow-card', className)}>
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('p-4', className)}>{children}</div>;
}

/** Headline number with label — the dashboard summary cards. */
export function StatCard({
  label,
  value,
  sub,
  icon,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: IconName;
  tone?: Tone;
}) {
  const c = tone ? TONE_CLASSES[tone] : null;
  return (
    <Card className="p-4">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
        {icon ? <Icon name={icon} className={cn('h-4 w-4 shrink-0', c?.text)} /> : null}
        <span className="min-w-0 truncate">{label}</span>
      </div>
      <div className={cn('mt-1 whitespace-nowrap text-2xl font-semibold tabular-nums', c?.text)}>{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-muted">{sub}</div> : null}
    </Card>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function KeyValue({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[minmax(6rem,max-content)_1fr] gap-x-4 gap-y-2 text-sm', className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v ?? '–'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ProgressBar({ value, tone, label }: { value: number; tone?: Tone; label: string }) {
  const pct = Math.max(0, Math.min(100, value));
  const t: Tone = tone ?? (pct >= 90 ? 'critical' : pct >= 75 ? 'warning' : 'healthy');
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
    >
      {/* width through a CSS custom property is not needed: CSSOM style writes are allowed by the CSP */}
      <div
        className={cn('h-full rounded-full transition-all', TONE_CLASSES[t].bar)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function CodeBlock({
  children,
  className,
  maxHeight = 'max-h-96',
}: {
  children: ReactNode;
  className?: string;
  maxHeight?: string;
}) {
  return (
    <pre
      className={cn(
        'qm-scroll overflow-auto rounded-lg border border-border bg-surface-2 p-3 text-xs leading-relaxed',
        maxHeight,
        className,
      )}
    >
      <code>{children}</code>
    </pre>
  );
}
