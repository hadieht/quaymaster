import type { DeliveryStatus, Severity } from '@quaymaster/shared';
import type { Db } from '../db/connection.js';

export interface ChannelRow {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  minSeverity: Severity;
  events: string[];
  secretName: string;
  createdAt: number;
  updatedAt: number;
}

export interface DeliveryRow {
  id: number;
  ts: number;
  channelId: string;
  channelName: string | null;
  eventType: string;
  severity: Severity;
  dedupeKey: string | null;
  title: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  httpStatus: number | null;
  eventJson: string;
}

interface RawChannel {
  id: string;
  type: string;
  name: string;
  enabled: number;
  min_severity: Severity;
  events: string;
  secret_name: string;
  created_at: number;
  updated_at: number;
}

interface RawDelivery {
  id: number;
  ts: number;
  channel_id: string;
  channel_name: string | null;
  event_type: string;
  severity: Severity;
  dedupe_key: string | null;
  title: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: number | null;
  last_error: string | null;
  http_status: number | null;
  event_json: string;
}

function toChannel(r: RawChannel): ChannelRow {
  let events: string[] = ['*'];
  try {
    const p: unknown = JSON.parse(r.events);
    if (Array.isArray(p)) events = p.filter((x): x is string => typeof x === 'string');
  } catch {
    /* keep default */
  }
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    enabled: r.enabled === 1,
    minSeverity: r.min_severity,
    events,
    secretName: r.secret_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toDelivery(r: RawDelivery): DeliveryRow {
  return {
    id: r.id,
    ts: r.ts,
    channelId: r.channel_id,
    channelName: r.channel_name,
    eventType: r.event_type,
    severity: r.severity,
    dedupeKey: r.dedupe_key,
    title: r.title,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
    httpStatus: r.http_status,
    eventJson: r.event_json,
  };
}

const DELIVERY_SELECT = `SELECT d.*, c.name AS channel_name FROM notification_deliveries d
  LEFT JOIN notification_channels c ON c.id = d.channel_id`;

export class NotificationRepo {
  constructor(private readonly db: Db) {}

  // ---- channels ----
  listChannels(): ChannelRow[] {
    return (this.db.prepare('SELECT * FROM notification_channels ORDER BY name').all() as RawChannel[]).map(
      toChannel,
    );
  }

  getChannel(id: string): ChannelRow | undefined {
    const r = this.db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(id) as
      RawChannel | undefined;
    return r ? toChannel(r) : undefined;
  }

  channelNameExists(name: string, exceptId?: string): boolean {
    const r = this.db
      .prepare('SELECT id FROM notification_channels WHERE name = ? AND id IS NOT ?')
      .get(name, exceptId ?? null);
    return r !== undefined;
  }

  insertChannel(c: ChannelRow): void {
    this.db
      .prepare(
        `INSERT INTO notification_channels (id, type, name, enabled, min_severity, events, secret_name, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        c.id,
        c.type,
        c.name,
        c.enabled ? 1 : 0,
        c.minSeverity,
        JSON.stringify(c.events),
        c.secretName,
        c.createdAt,
        c.updatedAt,
      );
  }

  updateChannel(c: ChannelRow): void {
    this.db
      .prepare(
        'UPDATE notification_channels SET name=?, enabled=?, min_severity=?, events=?, updated_at=? WHERE id=?',
      )
      .run(c.name, c.enabled ? 1 : 0, c.minSeverity, JSON.stringify(c.events), c.updatedAt, c.id);
  }

  deleteChannel(id: string): void {
    this.db.prepare('DELETE FROM notification_channels WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM notification_dedupe WHERE key LIKE ?').run(`${id}|%`);
  }

  // ---- deliveries ----
  insertDelivery(d: Omit<DeliveryRow, 'id' | 'channelName'>): number {
    const info = this.db
      .prepare(
        `INSERT INTO notification_deliveries
         (ts, channel_id, event_type, severity, dedupe_key, title, status, attempts, next_attempt_at, last_error, http_status, event_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        d.ts,
        d.channelId,
        d.eventType,
        d.severity,
        d.dedupeKey,
        d.title,
        d.status,
        d.attempts,
        d.nextAttemptAt,
        d.lastError,
        d.httpStatus,
        d.eventJson,
      );
    return Number(info.lastInsertRowid);
  }

  getDelivery(id: number): DeliveryRow | undefined {
    const r = this.db.prepare(`${DELIVERY_SELECT} WHERE d.id = ?`).get(id) as RawDelivery | undefined;
    return r ? toDelivery(r) : undefined;
  }

  updateDeliveryResult(
    id: number,
    u: {
      status: DeliveryStatus;
      attempts: number;
      nextAttemptAt: number | null;
      lastError: string | null;
      httpStatus: number | null;
    },
  ): void {
    this.db
      .prepare(
        'UPDATE notification_deliveries SET status=?, attempts=?, next_attempt_at=?, last_error=?, http_status=? WHERE id=?',
      )
      .run(u.status, u.attempts, u.nextAttemptAt, u.lastError, u.httpStatus, id);
  }

  listDeliveries(opts: { limit: number; channelId?: string; beforeId?: number }): DeliveryRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.channelId) {
      where.push('d.channel_id = ?');
      args.push(opts.channelId);
    }
    if (opts.beforeId) {
      where.push('d.id < ?');
      args.push(opts.beforeId);
    }
    args.push(opts.limit);
    const sql = `${DELIVERY_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args) as RawDelivery[]).map(toDelivery);
  }

  /** Failed deliveries whose retry time has come. */
  dueRetries(now: number, limit: number): DeliveryRow[] {
    return (
      this.db
        .prepare(
          `${DELIVERY_SELECT} WHERE d.status = 'failed' AND d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= ?
           ORDER BY d.next_attempt_at, d.id LIMIT ?`,
        )
        .all(now, limit) as RawDelivery[]
    ).map(toDelivery);
  }

  /** Housekeeping: keep the delivery log bounded. */
  pruneDeliveries(olderThan: number): void {
    this.db.prepare(`DELETE FROM notification_deliveries WHERE ts < ? AND status != 'failed'`).run(olderThan);
    this.db.prepare('DELETE FROM notification_dedupe WHERE last_sent_at < ?').run(olderThan);
  }

  // ---- dedupe ----
  lastSent(key: string): number | undefined {
    const r = this.db.prepare('SELECT last_sent_at FROM notification_dedupe WHERE key = ?').get(key) as
      { last_sent_at: number } | undefined;
    return r?.last_sent_at;
  }

  markSent(key: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO notification_dedupe (key, last_sent_at, suppressed) VALUES (?,?,0)
         ON CONFLICT(key) DO UPDATE SET last_sent_at=excluded.last_sent_at`,
      )
      .run(key, now);
  }

  bumpSuppressed(key: string): void {
    this.db.prepare('UPDATE notification_dedupe SET suppressed = suppressed + 1 WHERE key = ?').run(key);
  }

  suppressedCount(key: string): number {
    const r = this.db.prepare('SELECT suppressed FROM notification_dedupe WHERE key = ?').get(key) as
      { suppressed: number } | undefined;
    return r?.suppressed ?? 0;
  }
}
