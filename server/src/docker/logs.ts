import type { Readable } from 'node:stream';
import { globalScrubber, redactText } from '../redaction/redact.js';

export interface LogLine {
  stream: 'stdout' | 'stderr';
  /** RFC3339 timestamp when `timestamps` was requested, else null. */
  ts: string | null;
  text: string;
}

export const MAX_LINE_BYTES = 16 * 1024;

/** Incremental parser for Docker's multiplexed log stream (8-byte frame headers). TTY streams are raw. */
export class LogDemuxer {
  private buf: Buffer = Buffer.alloc(0);
  private readonly partial: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };

  constructor(
    private readonly tty: boolean,
    private readonly timestamps: boolean,
    private readonly onLine: (l: LogLine) => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.tty) {
      this.text('stdout', chunk.toString('utf8'));
      return;
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 8) {
      const type = this.buf[0];
      const size = this.buf.readUInt32BE(4);
      if (type === undefined || type > 2 || this.buf[1] !== 0) {
        // not a multiplexed stream after all (or corrupt): treat the rest as raw stdout
        this.text('stdout', this.buf.toString('utf8'));
        this.buf = Buffer.alloc(0);
        return;
      }
      if (this.buf.length < 8 + size) return;
      const payload = this.buf.subarray(8, 8 + size).toString('utf8');
      this.buf = this.buf.subarray(8 + size);
      if (type === 0) this.text('stdout', payload); // stdin echo treated as stdout
      else this.text(type === 1 ? 'stdout' : 'stderr', payload);
    }
  }

  private text(stream: 'stdout' | 'stderr', s: string): void {
    const data = this.partial[stream] + s;
    const parts = data.split('\n');
    this.partial[stream] = parts.pop() ?? '';
    if (this.partial[stream].length > MAX_LINE_BYTES) {
      parts.push(this.partial[stream]);
      this.partial[stream] = '';
    }
    for (const p of parts) this.emit(stream, p.replace(/\r$/, ''));
  }

  private emit(stream: 'stdout' | 'stderr', line: string): void {
    let ts: string | null = null;
    let text = line;
    if (this.timestamps) {
      const m = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z) ([\s\S]*)$/.exec(line);
      if (m) {
        ts = m[1] ?? null;
        text = m[2] ?? '';
      }
    }
    this.onLine({ stream, ts, text: text.length > MAX_LINE_BYTES ? text.slice(0, MAX_LINE_BYTES) + '…' : text });
  }

  flush(): void {
    for (const s of ['stdout', 'stderr'] as const) {
      if (this.partial[s]) this.emit(s, this.partial[s]);
      this.partial[s] = '';
    }
  }
}

/** Demultiplexes a complete (non-follow) log buffer. */
export function demuxBuffer(buf: Buffer, tty: boolean, timestamps: boolean): LogLine[] {
  const out: LogLine[] = [];
  const d = new LogDemuxer(tty, timestamps, (l) => out.push(l));
  d.push(buf);
  d.flush();
  return out;
}

/**
 * Logs routinely contain secrets that no rule can reliably recognise (RT-30). We still apply the
 * known-value scrubber and the text rules, and the API additionally requires the `logs:read`
 * permission, which viewers do not have by default.
 */
export function cleanLogLine(l: LogLine): LogLine {
  return { ...l, text: redactText(globalScrubber.scrub(l.text)) };
}

/** Byte-rate limiter with back-pressure: pauses the source stream when the per-second budget is spent. */
export class RateLimitedPump {
  private used = 0;
  private windowStart = Date.now();
  private resumeTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly source: Readable,
    private readonly bytesPerSec: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Account for `n` bytes; pauses the source when over budget. Returns true if it paused. */
  account(n: number): boolean {
    const t = this.now();
    if (t - this.windowStart >= 1000) {
      this.windowStart = t;
      this.used = 0;
    }
    this.used += n;
    if (this.used >= this.bytesPerSec) {
      this.source.pause();
      const wait = Math.max(10, 1000 - (t - this.windowStart));
      this.resumeTimer = setTimeout(() => {
        this.used = 0;
        this.windowStart = this.now();
        this.source.resume();
      }, wait);
      this.resumeTimer.unref();
      return true;
    }
    return false;
  }

  stop(): void {
    clearTimeout(this.resumeTimer);
  }
}
