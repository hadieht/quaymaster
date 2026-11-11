import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface TabItem<K extends string = string> {
  key: K;
  label: ReactNode;
  count?: number;
}

/** WAI-ARIA tabs: roving focus, arrow keys / Home / End. */
export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix = 'tab',
}: {
  tabs: TabItem<K>[];
  value: K;
  onChange: (k: K) => void;
  label: string;
  idPrefix?: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.key === value);
    let n = i;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = tabs.length - 1;
    else return;
    e.preventDefault();
    const next = tabs[n];
    if (next) {
      onChange(next.key);
      refs.current[next.key]?.focus();
    }
  };
  return (
    <div role="tablist" aria-label={label} onKeyDown={onKey} className="qm-scroll flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((t) => {
        const active = t.key === value;
        return (
          <button
            key={t.key}
            ref={(el) => {
              refs.current[t.key] = el;
            }}
            role="tab"
            id={`${idPrefix}-${t.key}`}
            aria-selected={active}
            aria-controls={`${idPrefix}-panel-${t.key}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.key)}
            className={cn(
              '-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              active ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {t.label}
            {t.count !== undefined ? (
              <span className="rounded-full bg-surface-2 px-1.5 text-xs tabular-nums text-muted">{t.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ id, tab, children, idPrefix = 'tab' }: { id: string; tab: string; children: ReactNode; idPrefix?: string }) {
  if (id !== tab) return null;
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-${id}`} className="pt-4">
      {children}
    </div>
  );
}

/** Compact segmented filter (state filters etc.). */
export function Segmented<K extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { key: K; label: string; count?: number }[];
  value: K;
  onChange: (k: K) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap rounded-lg border border-border bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={o.key === value}
          onClick={() => onChange(o.key)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
            o.key === value ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
          {o.count !== undefined ? <span className="ml-1 tabular-nums opacity-70">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
