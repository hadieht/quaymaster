import { api } from './client';
import { API_BASE } from './client';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'closed';

export interface StreamOptions {
  /** Handlers by SSE event name; `data` is parsed JSON. */
  events: Record<string, (data: unknown) => void>;
  onStatus?: (s: StreamStatus) => void;
  /** Evaluated on every (re)connect, so streams can resume (e.g. `sinceId`). */
  query?: () => Record<string, string | number | undefined>;
}

const MIN_DELAY = 1000;
const MAX_DELAY = 30_000;

export function streamUrl(path: string, query?: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
  const s = qs.toString();
  return `${API_BASE}/stream${path}${s ? `?${s}` : ''}`;
}

/**
 * Server-Sent Events with reconnect. The server ends a stream with an `end` event when the session
 * changes; after any drop we probe `/auth/me` first so an expired session goes to the login page
 * (through the API client's 401 handler) instead of reconnecting forever.
 * Returns a function that closes the stream.
 */
export function openStream(path: string, opts: StreamOptions): () => void {
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = MIN_DELAY;
  let stopped = false;

  const status = (s: StreamStatus) => opts.onStatus?.(s);

  const connect = () => {
    if (stopped) return;
    status(delay === MIN_DELAY && !es ? 'connecting' : 'reconnecting');
    es = new EventSource(streamUrl(path, opts.query?.()), { withCredentials: true });
    es.onopen = () => {
      delay = MIN_DELAY;
      status('live');
    };
    for (const [name, handler] of Object.entries(opts.events)) {
      es.addEventListener(name, (ev) => {
        try {
          handler(JSON.parse((ev as MessageEvent<string>).data) as unknown);
        } catch {
          /* malformed frame: ignore */
        }
      });
    }
    es.addEventListener('end', () => {
      es?.close();
      es = null;
      schedule();
    });
    es.onerror = () => {
      es?.close();
      es = null;
      schedule();
    };
  };

  const schedule = () => {
    if (stopped) return;
    status('reconnecting');
    const wait = delay + Math.random() * 250;
    delay = Math.min(delay * 2, MAX_DELAY);
    timer = setTimeout(() => {
      api
        .get('/auth/me')
        .catch(() => undefined)
        .finally(connect);
    }, wait);
  };

  connect();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    es?.close();
    es = null;
    status('closed');
  };
}
