import { Cron } from 'croner';

/**
 * Time-zone aware cron and maintenance-window arithmetic with explicit, tested DST rules (RT-09):
 *
 *  - a local time that does not exist (spring-forward gap) fires at the first valid instant after the gap
 *  - an ambiguous local time (fall-back overlap) fires ONCE, at its first occurrence
 *  - window membership is computed in UTC: zoned start instant + duration, so a window that spans a
 *    transition is 1 h shorter / longer in elapsed time, never ambiguous
 *  - a window's day-of-week refers to the day it starts; `end <= start` crosses midnight
 */

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    dtf(tz);
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday */
  dow: number;
}

/** The wall-clock reading of instant `utcMs` in `tz`. */
export function zonedParts(tz: string, utcMs: number): ZonedParts {
  const p: Record<string, number> = {};
  for (const part of dtf(tz).formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const hour = (p['hour'] ?? 0) % 24;
  const year = p['year'] ?? 1970;
  const month = p['month'] ?? 1;
  const day = p['day'] ?? 1;
  return {
    year,
    month,
    day,
    hour,
    minute: p['minute'] ?? 0,
    second: p['second'] ?? 0,
    dow: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** Wall clock of `utcMs` in `tz`, encoded as if it were UTC ("floating" time). */
export function floating(tz: string, utcMs: number): number {
  const z = zonedParts(tz, utcMs);
  return Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second) + (((utcMs % 1000) + 1000) % 1000);
}

/** Offset of `tz` from UTC at `utcMs`, in ms (positive east of Greenwich). */
export function offsetAt(tz: string, utcMs: number): number {
  const t = Math.floor(utcMs / 1000) * 1000;
  return floating(tz, t) - t;
}

export interface Resolved {
  instant: number;
  kind: 'normal' | 'gap' | 'ambiguous';
}

/** Resolves a floating wall time to an instant under the DST rules above. */
export function wallToInstant(tz: string, wallMs: number): Resolved {
  const DAY = 86_400_000;
  const offs = [...new Set([offsetAt(tz, wallMs - DAY), offsetAt(tz, wallMs + DAY)])];
  const valid = offs.map((o) => wallMs - o).filter((t) => offsetAt(tz, t) === wallMs - t);
  if (valid.length === 1) return { instant: valid[0] as number, kind: 'normal' };
  if (valid.length >= 2) return { instant: Math.min(...valid), kind: 'ambiguous' };
  // gap: the first valid instant after it is the transition itself
  const guess = wallMs - (offs[0] ?? 0);
  const preOffset = offsetAt(tz, guess - DAY);
  let lo = Math.floor(guess / 1000) * 1000 - DAY; // offset == preOffset here
  let hi = Math.floor(guess / 1000) * 1000 + DAY; // offset != preOffset here
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2000) * 1000;
    if (offsetAt(tz, mid) === preOffset) lo = mid;
    else hi = mid;
  }
  return { instant: hi, kind: 'gap' };
}

// ---- cron ---------------------------------------------------------------------------------

/** Validates a 5-field cron expression (or an `@daily`-style alias). Returns an error message or null. */
export function cronError(expr: string): string | null {
  const e = expr.trim();
  if (!e.startsWith('@') && e.split(/\s+/).length !== 5)
    return 'cron must have 5 fields: minute hour day-of-month month day-of-week';
  try {
    new Cron(e, { timezone: 'UTC', paused: true });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Next `count` occurrences (UTC ms) strictly after `afterMs`, using the DST rules of this module. */
export function nextOccurrences(
  expr: string,
  tz: string,
  afterMs: number,
  count: number,
  untilMs = Number.POSITIVE_INFINITY,
): number[] {
  const cron = new Cron(expr.trim(), { timezone: 'UTC', paused: true });
  const out: number[] = [];
  let from = new Date(floating(tz, afterMs) - 26 * 3_600_000);
  for (let guard = 0; out.length < count && guard < 5000; guard++) {
    const n = cron.nextRun(from);
    if (!n) break;
    from = n;
    const { instant } = wallToInstant(tz, n.getTime());
    if (instant <= afterMs) continue;
    if (instant > untilMs) break;
    if (out[out.length - 1] === instant) continue; // several wall times collapsed into one gap instant
    out.push(instant);
  }
  return out;
}

// ---- windows ------------------------------------------------------------------------------

export interface WindowDef {
  /** 0 = Sunday … 6 = Saturday, the day the window starts. */
  days: number[];
  start: string;
  end: string;
  timezone: string;
}

export function parseHHMM(s: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function windowError(w: WindowDef): string | null {
  if (!isValidTimeZone(w.timezone)) return `unknown time zone "${w.timezone}"`;
  const s = parseHHMM(w.start);
  const e = parseHHMM(w.end);
  if (s === null || e === null) return 'start and end must be HH:MM (24 h)';
  if (s === e) return 'start and end must differ (a window cannot be empty or 24 h long)';
  if (w.days.length === 0 || w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return 'days must be a non-empty list of 0 (Sunday) … 6 (Saturday)';
  }
  return null;
}

export interface WindowSpan {
  start: number;
  end: number;
}

/** The occurrence of `w` that STARTS on local calendar date (y, m, d). */
function occurrenceOn(w: WindowDef, y: number, m: number, d: number): WindowSpan | null {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (!w.days.includes(dow)) return null;
  const s = parseHHMM(w.start) as number;
  const e = parseHHMM(w.end) as number;
  const durMin = e > s ? e - s : e + 1440 - s;
  const start = wallToInstant(w.timezone, Date.UTC(y, m - 1, d, Math.floor(s / 60), s % 60)).instant;
  return { start, end: start + durMin * 60_000 };
}

/** The window occurrence containing `atMs`, or null. */
export function windowAt(w: WindowDef, atMs: number): WindowSpan | null {
  const z = zonedParts(w.timezone, atMs);
  for (const back of [0, 1]) {
    const day = new Date(Date.UTC(z.year, z.month - 1, z.day - back));
    const occ = occurrenceOn(w, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
    if (occ && occ.start <= atMs && atMs < occ.end) return occ;
  }
  return null;
}

/** First window occurrence beginning strictly after `atMs` (searches ~8 days). */
export function nextWindowStart(w: WindowDef, atMs: number): WindowSpan | null {
  const z = zonedParts(w.timezone, atMs);
  for (let fwd = -1; fwd <= 8; fwd++) {
    const day = new Date(Date.UTC(z.year, z.month - 1, z.day + fwd));
    const occ = occurrenceOn(w, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
    if (occ && occ.start > atMs) return occ;
  }
  return null;
}
