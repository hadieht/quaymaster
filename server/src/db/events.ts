import type { DockerEventRecord } from '@quaymaster/shared';
import type { Db } from './connection.js';

interface EventRow {
  id: number;
  ts: number;
  type: string;
  action: string;
  actor_id: string;
  name: string | null;
  image: string | null;
  project: string | null;
  service: string | null;
  attributes: string;
  synthetic: number;
}

export type NewEvent = Omit<DockerEventRecord, 'id' | 'time'> & { ts: number };

export class EventsRepo {
  constructor(private readonly db: Db) {}

  /** Inserts a batch in one transaction (RT-25/26: batched writes). Returns assigned ids in order. */
  insertMany(events: NewEvent[]): number[] {
    const stmt = this.db.prepare(
      'INSERT INTO events (ts, type, action, actor_id, name, image, project, service, attributes, synthetic) VALUES (?,?,?,?,?,?,?,?,?,?)',
    );
    const ids: number[] = [];
    this.db.transaction(() => {
      for (const e of events) {
        const info = stmt.run(
          e.ts,
          e.type,
          e.action,
          e.actorId,
          e.name,
          e.image,
          e.project,
          e.service,
          JSON.stringify(e.attributes),
          e.synthetic ? 1 : 0,
        );
        ids.push(Number(info.lastInsertRowid));
      }
    })();
    return ids;
  }

  list(opts: { limit: number; beforeId?: number; sinceId?: number; containerId?: string; project?: string }): DockerEventRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.beforeId) (where.push('id < ?'), args.push(opts.beforeId));
    if (opts.sinceId) (where.push('id > ?'), args.push(opts.sinceId));
    if (opts.containerId) (where.push('actor_id = ?'), args.push(opts.containerId));
    if (opts.project) (where.push('project = ?'), args.push(opts.project));
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, opts.limit) as EventRow[]).map(toRecord);
  }

  lastTimestamp(): number | null {
    const r = this.db.prepare('SELECT MAX(ts) AS t FROM events WHERE synthetic = 0').get() as { t: number | null };
    return r.t;
  }

  /** Deletes at most `batch` old rows (RT-26: never block the event loop with a huge DELETE). */
  prune(olderThanMs: number, batch = 5000): number {
    return this.db
      .prepare('DELETE FROM events WHERE id IN (SELECT id FROM events WHERE ts < ? LIMIT ?)')
      .run(olderThanMs, batch).changes;
  }
}

function toRecord(r: EventRow): DockerEventRecord {
  return {
    id: r.id,
    time: new Date(r.ts).toISOString(),
    type: r.type,
    action: r.action,
    actorId: r.actor_id,
    name: r.name,
    image: r.image,
    project: r.project,
    service: r.service,
    attributes: JSON.parse(r.attributes) as Record<string, string>,
    synthetic: r.synthetic === 1,
  };
}
