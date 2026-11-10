import type { Db } from './connection.js';

export interface SessionRow {
  id_hash: string;
  user_id: number;
  csrf_secret: string;
  created_at: number;
  last_seen: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
}

export class SessionsRepo {
  constructor(private readonly db: Db) {}

  insert(s: SessionRow): void {
    this.db
      .prepare(
        'INSERT INTO sessions (id_hash, user_id, csrf_secret, created_at, last_seen, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(s.id_hash, s.user_id, s.csrf_secret, s.created_at, s.last_seen, s.expires_at, s.ip, s.user_agent);
  }

  get(idHash: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as SessionRow | undefined;
  }

  touch(idHash: string, now: number): void {
    this.db.prepare('UPDATE sessions SET last_seen = ? WHERE id_hash = ?').run(now, idHash);
  }

  delete(idHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
  }

  /** Deletes every session of a user (optionally keeping one) and returns the removed hashes. */
  deleteForUser(userId: number, exceptIdHash?: string): string[] {
    const rows = this.db
      .prepare('SELECT id_hash FROM sessions WHERE user_id = ? AND id_hash != ?')
      .all(userId, exceptIdHash ?? '') as { id_hash: string }[];
    this.db
      .prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?')
      .run(userId, exceptIdHash ?? '');
    return rows.map((r) => r.id_hash);
  }

  deleteExpired(now: number, idleMs: number): number {
    return this.db
      .prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen < ?')
      .run(now, now - idleMs).changes;
  }
}
