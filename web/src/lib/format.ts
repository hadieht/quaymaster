const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function bytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const s = i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : digits);
  return `${n < 0 ? '-' : ''}${s} ${UNITS[i]}`;
}

export function percent(n: number | null | undefined, digits = 0): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '–' : `${n.toFixed(digits)} %`;
}

/** 93784 → "1d 2h", 3700 → "1h 1m", 45 → "45s" */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '–';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "3 minutes ago" / "in 2 hours" */
export function relativeTime(iso: string | number | null | undefined, now = Date.now()): string {
  if (iso === null || iso === undefined || iso === '') return '–';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return '–';
  const diff = (t - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return diff < 0 ? 'just now' : 'in a few seconds';
  const minutes = diff / 60;
  if (Math.abs(minutes) < 60) return rtf.format(Math.round(minutes), 'minute');
  const hours = diff / 3600;
  if (Math.abs(hours) < 24) return rtf.format(Math.round(hours), 'hour');
  const days = diff / 86400;
  if (Math.abs(days) < 30) return rtf.format(Math.round(days), 'day');
  if (Math.abs(days) < 365) return rtf.format(Math.round(days / 30), 'month');
  return rtf.format(Math.round(days / 365), 'year');
}

export function dateTime(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function timeOnly(iso: string | number): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '–' : d.toLocaleTimeString(undefined, { hour12: false });
}

export function shortDigest(d: string | null | undefined): string {
  if (!d) return '–';
  const i = d.indexOf(':');
  return d.slice(i + 1, i + 13);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "sha256:abcd…" → "abcd1234abcd" (12 hex chars) */
export function shortImageId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12);
}

export function uptimeFromStatus(status: string): string {
  // Docker's `Status` text: "Up 3 hours (healthy)", "Exited (0) 2 days ago"
  return status.replace(/\s*\((healthy|unhealthy|health: starting)\)/, '');
}
