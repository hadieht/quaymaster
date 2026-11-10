import type { AuditEntry } from '@quaymaster/shared';
import type { Db } from './connection.js';

interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  ip: string | null;
  action: string;
  target: string | null;
  params: string | null;
  outcome: AuditEntry['outcome'];
  duration_ms: number | null;
}

export class AuditRepo {
  constructor(private readonly db: Db) {}

  insert(e: Omit<AuditRow, 'id'>): number {
    const info = this.db
      .prepare(
        'INSERT INTO audit_log (ts, actor, ip, action, target, params, outcome, duration_ms) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(e.ts, e.actor, e.ip, e.action, e.target, e.params, e.outcome, e.duration_ms);
    return Number(info.lastInsertRowid);
  }

  list(opts: { limit: number; beforeId?: number; action?: string; actor?: string }): AuditEntry[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.beforeId) {
      where.push('id < ?');
      args.push(opts.beforeId);
    }
    if (opts.action) {
      where.push('action = ?');
      args.push(opts.action);
    }
    if (opts.actor) {
      where.push('actor = ?');
      args.push(opts.actor);
    }
    const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, opts.limit) as AuditRow[];
    return rows.map((r) => ({
      id: r.id,
      time: new Date(r.ts).toISOString(),
      actor: r.actor,
      ip: r.ip,
      action: r.action,
      target: r.target,
      params: r.params ? (JSON.parse(r.params) as unknown) : null,
      outcome: r.outcome,
      durationMs: r.duration_ms,
    }));
  }

  /** Retention prune in small batches (the trigger refuses rows younger than 30 days). */
  prune(olderThanMs: number, batch = 2000): number {
    return this.db
      .prepare('DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE ts < ? LIMIT ?)')
      .run(olderThanMs, batch).changes;
  }
}
