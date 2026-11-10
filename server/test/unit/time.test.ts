import { describe, expect, it } from 'vitest';
import {
  cronError,
  isValidTimeZone,
  nextOccurrences,
  nextWindowStart,
  offsetAt,
  wallToInstant,
  windowAt,
  windowError,
  zonedParts,
  type WindowDef,
} from '../../src/maintenance/time.js';

const utc = (s: string): number => Date.parse(s);
const iso = (ms: number): string => new Date(ms).toISOString();
const BER = 'Europe/Berlin';
const SYD = 'Australia/Sydney';

describe('time zones', () => {
  it('validates IANA names and reads offsets', () => {
    expect(isValidTimeZone(BER)).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(offsetAt(BER, utc('2026-01-15T12:00:00Z'))).toBe(3_600_000);
    expect(offsetAt(BER, utc('2026-07-15T12:00:00Z'))).toBe(7_200_000);
    expect(zonedParts(BER, utc('2026-07-15T12:00:00Z')).hour).toBe(14);
  });

  it('wallToInstant: normal, gap and ambiguous local times', () => {
    // 2026-03-29 02:30 Berlin does not exist: first valid instant after the gap = 03:00 CEST = 01:00Z
    const gap = wallToInstant(BER, Date.UTC(2026, 2, 29, 2, 30));
    expect(gap.kind).toBe('gap');
    expect(iso(gap.instant)).toBe('2026-03-29T01:00:00.000Z');
    // 2026-10-25 02:30 Berlin happens twice; the first (CEST, 00:30Z) wins
    const amb = wallToInstant(BER, Date.UTC(2026, 9, 25, 2, 30));
    expect(amb.kind).toBe('ambiguous');
    expect(iso(amb.instant)).toBe('2026-10-25T00:30:00.000Z');
    const normal = wallToInstant(BER, Date.UTC(2026, 5, 1, 2, 30));
    expect(normal.kind).toBe('normal');
    expect(iso(normal.instant)).toBe('2026-06-01T00:30:00.000Z');
  });
});

describe('cron occurrences (DST-safe)', () => {
  it('rejects malformed expressions', () => {
    expect(cronError('30 2 * * *')).toBeNull();
    expect(cronError('@daily')).toBeNull();
    expect(cronError('* * * *')).toMatch(/5 fields/);
    expect(cronError('61 * * * *')).not.toBeNull();
  });

  it('spring forward (Europe/Berlin): a 02:30 job fires once, at the first valid instant', () => {
    const occ = nextOccurrences('30 2 * * *', BER, utc('2026-03-28T00:00:00Z'), 3);
    expect(occ.map(iso)).toEqual([
      '2026-03-28T01:30:00.000Z', // normal day: 02:30 CET
      '2026-03-29T01:00:00.000Z', // gap day: 03:00 CEST
      '2026-03-30T00:30:00.000Z', // 02:30 CEST
    ]);
  });

  it('fall back (Europe/Berlin): a 02:30 job fires exactly once, at the first occurrence', () => {
    const occ = nextOccurrences('30 2 * * *', BER, utc('2026-10-24T00:00:00Z'), 3);
    expect(occ.map(iso)).toEqual([
      '2026-10-24T00:30:00.000Z',
      '2026-10-25T00:30:00.000Z', // 02:30 CEST (first), not again at 02:30 CET
      '2026-10-26T01:30:00.000Z',
    ]);
  });

  it('a frequent job inside the gap does not fire twice at the same instant', () => {
    const occ = nextOccurrences('*/15 2 * * *', BER, utc('2026-03-29T00:00:00Z'), 10, utc('2026-03-29T02:00:00Z'));
    expect(new Set(occ).size).toBe(occ.length);
    expect(occ.filter((t) => t === utc('2026-03-29T01:00:00Z'))).toHaveLength(1);
  });

  it('southern hemisphere (Australia/Sydney): both transitions', () => {
    // DST starts 2026-10-04 02:00 AEST -> 03:00 AEDT (2026-10-03T16:00Z); 02:30 does not exist
    const start = nextOccurrences('30 2 * * *', SYD, utc('2026-10-03T00:00:00Z'), 2);
    expect(start.map(iso)).toEqual(['2026-10-03T16:00:00.000Z', '2026-10-04T15:30:00.000Z']);
    expect(iso(wallToInstant(SYD, Date.UTC(2026, 9, 4, 2, 30)).instant)).toBe('2026-10-03T16:00:00.000Z');
    // DST ends 2026-04-05 03:00 AEDT -> 02:00 AEST (2026-04-04T16:00Z); 02:30 happens twice
    const amb = wallToInstant(SYD, Date.UTC(2026, 3, 5, 2, 30));
    expect(amb.kind).toBe('ambiguous');
    expect(iso(amb.instant)).toBe('2026-04-04T15:30:00.000Z');
    const end = nextOccurrences('30 2 5 4 *', SYD, utc('2026-04-01T00:00:00Z'), 1);
    expect(end.map(iso)).toEqual(['2026-04-04T15:30:00.000Z']);
  });

  it('respects UTC-fixed zones and day-of-week', () => {
    const occ = nextOccurrences('0 3 * * 0', 'UTC', utc('2026-11-11T00:00:00Z'), 2); // Sundays
    expect(occ.map(iso)).toEqual(['2026-11-15T03:00:00.000Z', '2026-11-22T03:00:00.000Z']);
  });
});

describe('maintenance windows', () => {
  const win = (over: Partial<WindowDef>): WindowDef => ({
    days: [0, 1, 2, 3, 4, 5, 6],
    start: '02:00',
    end: '04:00',
    timezone: BER,
    ...over,
  });

  it('validates: start == end is rejected, bad zone, bad days', () => {
    expect(windowError(win({}))).toBeNull();
    expect(windowError(win({ end: '02:00' }))).toMatch(/differ/);
    expect(windowError(win({ timezone: 'Nope/Zone' }))).toMatch(/time zone/);
    expect(windowError(win({ days: [] }))).toMatch(/days/);
    expect(windowError(win({ days: [7] }))).toMatch(/days/);
    expect(windowError(win({ start: '2:00' }))).toMatch(/HH:MM/);
  });

  it('contains instants inside and excludes the end instant', () => {
    const w = win({});
    expect(windowAt(w, utc('2026-06-01T00:30:00Z'))).not.toBeNull(); // 02:30 CEST
    expect(windowAt(w, utc('2026-06-01T00:00:00Z'))).not.toBeNull(); // 02:00 CEST exactly: open
    expect(windowAt(w, utc('2026-06-01T02:00:00Z'))).toBeNull(); // 04:00 CEST exactly: closed
    expect(windowAt(w, utc('2026-06-01T12:00:00Z'))).toBeNull();
  });

  it('midnight crossing: day-of-week refers to the START day (Saturday 23:00 - 02:00)', () => {
    const w = win({ days: [6], start: '23:00', end: '02:00', timezone: 'UTC' });
    expect(windowAt(w, utc('2026-11-14T23:30:00Z'))).not.toBeNull(); // Saturday 23:30
    expect(windowAt(w, utc('2026-11-15T01:00:00Z'))).not.toBeNull(); // Sunday 01:00 belongs to Saturday's window
    expect(windowAt(w, utc('2026-11-15T02:00:00Z'))).toBeNull();
    expect(windowAt(w, utc('2026-11-15T23:30:00Z'))).toBeNull(); // Sunday 23:30: not a start day
    expect(windowAt(w, utc('2026-11-16T01:00:00Z'))).toBeNull();
  });

  it('DST: end = zoned start instant + duration, so a 02:00-04:00 window is 2 h long on every day', () => {
    const w = win({});
    const spring = windowAt(w, utc('2026-03-29T01:30:00Z')); // 03:30 CEST
    expect(spring).not.toBeNull();
    expect(iso(spring?.start ?? 0)).toBe('2026-03-29T01:00:00.000Z'); // 02:00 does not exist -> 03:00 CEST
    expect(iso(spring?.end ?? 0)).toBe('2026-03-29T03:00:00.000Z');
    const fall = windowAt(w, utc('2026-10-25T01:30:00Z')); // 02:30 CET, second pass of the repeated hour
    expect(fall).not.toBeNull();
    expect(iso(fall?.start ?? 0)).toBe('2026-10-25T00:00:00.000Z'); // first 02:00 (CEST)
    expect(((fall?.end ?? 0) - (fall?.start ?? 0)) / 3_600_000).toBe(2);
  });

  it('finds the next start', () => {
    const w = win({ days: [1], timezone: 'UTC' }); // Mondays 02:00-04:00 UTC
    const next = nextWindowStart(w, utc('2026-11-11T10:00:00Z')); // a Wednesday
    expect(iso(next?.start ?? 0)).toBe('2026-11-16T02:00:00.000Z');
    expect(iso(next?.end ?? 0)).toBe('2026-11-16T04:00:00.000Z');
    expect(nextWindowStart(win({ days: [1], timezone: 'UTC' }), utc('2026-11-16T02:00:00Z'))?.start).toBe(
      utc('2026-11-23T02:00:00Z'),
    );
  });
});
