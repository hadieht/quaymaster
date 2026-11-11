const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: 'Every night at 03:00', cron: '0 3 * * *' },
  { label: 'Every Sunday at 04:00', cron: '0 4 * * 0' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Weekdays at 02:30', cron: '30 2 * * 1-5' },
  { label: '1st of the month at 05:00', cron: '0 5 1 * *' },
];

const pad = (n: number | string) => String(n).padStart(2, '0');

function list(field: string, name: (n: number) => string): string | null {
  const parts = field.split(',');
  const out: string[] = [];
  for (const p of parts) {
    const range = /^(\d+)-(\d+)$/.exec(p);
    if (range) out.push(`${name(Number(range[1]))} to ${name(Number(range[2]))}`);
    else if (/^\d+$/.test(p)) out.push(name(Number(p)));
    else return null;
  }
  return out.join(', ');
}

/** Plain-language description of a 5-field cron expression; null when it is too unusual to explain. */
export function describeCron(expr: string): string | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  let when: string;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) when = `at ${pad(hour)}:${pad(min)}`;
  else if (min === '*' && hour === '*') when = 'every minute';
  else if (/^\*\/(\d+)$/.test(min) && hour === '*') when = `every ${/^\*\/(\d+)$/.exec(min)![1]} minutes`;
  else if (/^\d+$/.test(min) && hour === '*') when = `at minute ${min} of every hour`;
  else if (/^\d+$/.test(min) && /^\*\/(\d+)$/.test(hour)) when = `at minute ${min} every ${/^\*\/(\d+)$/.exec(hour)![1]} hours`;
  else return null;

  let day = '';
  const dows = dow === '*' ? null : list(dow, (n) => DAYS[n % 7] ?? String(n));
  const doms = dom === '*' ? null : list(dom, (n) => `day ${n}`);
  const mons = mon === '*' ? null : list(mon, (n) => MONTHS[n - 1] ?? String(n));
  if (dow !== '*' && dows === null) return null;
  if (dom !== '*' && doms === null) return null;
  if (mon !== '*' && mons === null) return null;
  if (dows) day += ` on ${dows}`;
  if (doms) day += `${dows ? ' or' : ' on'} ${doms} of the month`;
  if (mons) day += ` in ${mons}`;
  if (!dows && !doms && !mons) day = when.startsWith('every') || when.includes('every') ? '' : ' every day';
  return (when.charAt(0).toUpperCase() + when.slice(1) + day).trim();
}

export const WEEKDAYS = [
  { n: 1, label: 'Mon' },
  { n: 2, label: 'Tue' },
  { n: 3, label: 'Wed' },
  { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' },
  { n: 6, label: 'Sat' },
  { n: 0, label: 'Sun' },
];
