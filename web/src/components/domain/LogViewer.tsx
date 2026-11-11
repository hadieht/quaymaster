import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { q } from '@/api/hooks';
import { openStream, type StreamStatus } from '@/api/stream';
import type { LogLineDto } from '@/api/types';
import { Button, Checkbox, ErrorState, Icon, LoadingState, Notice, SearchInput, Select } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useAuth } from '@/state/auth';

const MAX_LINES = 5000;

function lineTime(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour12: false });
}

/** Highlights case-insensitive matches of `needle` in `text`. */
function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  let i = 0;
  let k = 0;
  for (;;) {
    const at = lower.indexOf(n, i);
    if (at < 0) break;
    parts.push(text.slice(i, at));
    parts.push(
      <mark key={k++} className="rounded bg-warning/40 px-0.5 text-fg">
        {text.slice(at, at + n.length)}
      </mark>,
    );
    i = at + n.length;
  }
  parts.push(text.slice(i));
  return <>{parts}</>;
}

/** Tail, follow (SSE), search, wrap and download for one container's logs. */
export function LogViewer({ containerRef, name }: { containerRef: string; name: string }) {
  const { canReadLogs } = useAuth();
  const [tail, setTail] = useState(200);
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [stamps, setStamps] = useState(true);
  const [search, setSearch] = useState('');
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [stick, setStick] = useState(true);
  const [live, setLive] = useState<LogLineDto[]>([]);
  const [status, setStatus] = useState<StreamStatus>('closed');
  const boxRef = useRef<HTMLDivElement>(null);

  const snapshot = useQuery({ ...q.logs(containerRef, tail), enabled: canReadLogs && !follow });

  useEffect(() => {
    if (!canReadLogs || !follow) return;
    setLive([]);
    return openStream(`/logs/${encodeURIComponent(containerRef)}`, {
      query: () => ({ tail }),
      onStatus: setStatus,
      events: {
        log: (d) =>
          setLive((l) => {
            const next = l.length >= MAX_LINES ? l.slice(l.length - MAX_LINES + 1) : l.slice();
            next.push(d as LogLineDto);
            return next;
          }),
      },
    });
  }, [containerRef, tail, follow, canReadLogs]);

  const lines = follow ? live : (snapshot.data?.lines ?? []);
  const shown = useMemo(() => {
    if (!search || !onlyMatches) return lines;
    const n = search.toLowerCase();
    return lines.filter((l) => l.text.toLowerCase().includes(n));
  }, [lines, search, onlyMatches]);
  const matches = useMemo(() => {
    if (!search) return 0;
    const n = search.toLowerCase();
    return lines.reduce((c, l) => (l.text.toLowerCase().includes(n) ? c + 1 : c), 0);
  }, [lines, search]);

  // keep scrolled to the bottom while following, unless the user scrolled up
  useEffect(() => {
    const el = boxRef.current;
    if (el && stick && follow) el.scrollTop = el.scrollHeight;
  }, [shown, stick, follow]);

  const onScroll = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  }, []);

  const download = () => {
    const text = shown.map((l) => `${stamps && l.ts ? `${l.ts} ` : ''}${l.stream === 'stderr' ? '[stderr] ' : ''}${l.text}`).join('\n');
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.log`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (!canReadLogs) {
    return (
      <Notice tone="warning" title="Logs are not available to your account">
        Reading container logs is a separate permission. An administrator can grant it in Settings → Security → Users.
      </Notice>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search in log…" label="Search logs" />
        <Select aria-label="Lines to load" value={tail} onChange={(e) => setTail(Number(e.target.value))} className="w-36">
          {[100, 200, 500, 1000, 2000].map((n) => (
            <option key={n} value={n}>
              Last {n} lines
            </option>
          ))}
        </Select>
        <Checkbox checked={follow} onChange={setFollow} label="Follow" />
        <Checkbox checked={wrap} onChange={setWrap} label="Wrap lines" />
        <Checkbox checked={stamps} onChange={setStamps} label="Timestamps" />
        <Checkbox checked={onlyMatches} onChange={setOnlyMatches} label="Only matches" disabled={!search} />
        <div className="ml-auto flex items-center gap-2">
          {follow ? (
            <span className="text-xs text-muted" role="status">
              {status === 'live' ? 'Streaming' : status === 'closed' ? 'Stopped' : 'Reconnecting…'}
            </span>
          ) : null}
          <Button size="sm" icon="download" onClick={download} disabled={shown.length === 0}>
            Download
          </Button>
        </div>
      </div>
      {search ? (
        <p className="text-xs text-muted" aria-live="polite">
          {matches} matching {matches === 1 ? 'line' : 'lines'}
        </p>
      ) : null}
      {!follow && snapshot.isLoading ? (
        <LoadingState label="Loading logs…" />
      ) : !follow && snapshot.error ? (
        <ErrorState error={snapshot.error} onRetry={() => void snapshot.refetch()} title="Could not read the logs" />
      ) : (
        <div className="relative">
          <div
            ref={boxRef}
            onScroll={onScroll}
            tabIndex={0}
            role="log"
            aria-label={`Logs of ${name}`}
            className="qm-scroll h-[28rem] overflow-auto rounded-lg border border-border bg-[rgb(var(--surface-2))] p-2 font-mono text-xs leading-5"
          >
            {shown.length === 0 ? (
              <div className="p-4 text-center text-muted">{lines.length === 0 ? 'No log output yet.' : 'No line matches the search.'}</div>
            ) : (
              shown.map((l, i) => (
                <div key={i} className={cn('flex gap-2 px-1 hover:bg-surface/60', l.stream === 'stderr' && 'text-critical')}>
                  {stamps && l.ts ? <span className="shrink-0 select-none text-muted">{lineTime(l.ts)}</span> : null}
                  <span className={cn('min-w-0 flex-1', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>
                    <Highlight text={l.text} needle={search} />
                  </span>
                </div>
              ))
            )}
          </div>
          {follow && !stick ? (
            <button
              type="button"
              onClick={() => {
                setStick(true);
                if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
              }}
              className="absolute bottom-3 right-5 inline-flex items-center gap-1 rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-fg shadow"
            >
              <Icon name="arrowDown" className="h-3 w-3" /> Jump to latest
            </button>
          ) : null}
        </div>
      )}
      <p className="text-xs text-muted">Secrets that Quaymaster knows about are masked in log output. Showing at most {MAX_LINES} lines.</p>
    </div>
  );
}
