import { useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Icon } from './Icon';
import { EmptyState } from './states';
import type { IconName } from './Icon';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Provide a comparator to make the column sortable. */
  sort?: (a: T, b: T) => number;
  className?: string;
  /** Hide below the `md` breakpoint to keep small screens uncluttered. */
  hideOnSmall?: boolean;
  align?: 'right';
}

export interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  caption: string;
  onRowClick?: (row: T) => void;
  empty?: { title: string; text?: string; icon?: IconName; action?: ReactNode };
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  /** Rows shown at once; a "show more" button reveals the rest. */
  pageSize?: number;
  dense?: boolean;
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  caption,
  onRowClick,
  empty,
  initialSort,
  pageSize = 100,
  dense,
}: DataTableProps<T>) {
  const [sort, setSort] = useState(initialSort ?? null);
  const [limit, setLimit] = useState(pageSize);

  const sorted = useMemo(() => {
    const col = sort ? columns.find((c) => c.key === sort.key) : undefined;
    if (!sort || !col?.sort) return rows;
    const cmp = col.sort;
    const out = [...rows].sort((a, b) => cmp(a, b));
    return sort.dir === 'desc' ? out.reverse() : out;
  }, [rows, columns, sort]);

  if (rows.length === 0) {
    return (
      <EmptyState icon={empty?.icon} title={empty?.title ?? 'Nothing to show'} action={empty?.action}>
        {empty?.text}
      </EmptyState>
    );
  }
  const visible = sorted.slice(0, limit);
  return (
    <div>
      <div className="qm-scroll overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                    className={cn(
                      'whitespace-nowrap px-3 py-2 font-medium',
                      c.hideOnSmall && 'hidden md:table-cell',
                      c.align === 'right' && 'text-right',
                    )}
                  >
                    {c.sort ? (
                      <button
                        type="button"
                        onClick={() =>
                          setSort(
                            active && sort?.dir === 'asc'
                              ? { key: c.key, dir: 'desc' }
                              : { key: c.key, dir: 'asc' },
                          )
                        }
                        className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-fg"
                      >
                        {c.header}
                        {active ? (
                          <Icon name={sort?.dir === 'asc' ? 'arrowUp' : 'arrowDown'} className="h-3 w-3" />
                        ) : null}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
                className={cn(
                  'border-b border-border/60 last:border-0',
                  onRowClick &&
                    'cursor-pointer hover:bg-surface-2/70 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand',
                )}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      'px-3 align-middle',
                      dense ? 'py-1.5' : 'py-2.5',
                      c.hideOnSmall && 'hidden md:table-cell',
                      c.align === 'right' && 'text-right tabular-nums',
                      c.className,
                    )}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length > limit ? (
        <div className="border-t border-border px-3 py-2 text-center">
          <button
            type="button"
            onClick={() => setLimit(limit + pageSize)}
            className="text-sm font-medium text-accent hover:underline"
          >
            Show more ({sorted.length - limit} remaining)
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Search box with a clear button. */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  label = 'Search',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
}) {
  return (
    <div className="relative w-full sm:w-64">
      <Icon
        name="search"
        className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
      />
      <input
        type="search"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-md border border-border bg-surface pl-8 pr-3 text-sm placeholder:text-muted/70"
      />
    </div>
  );
}
