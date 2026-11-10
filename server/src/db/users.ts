import type { Role } from '@quaymaster/shared';
import type { Db } from './connection.js';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  logs_read: number;
  disabled: number;
  created_at: number;
  password_changed_at: number;
}

export class UsersRepo {
  constructor(private readonly db: Db) {}

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  create(u: { username: string; passwordHash: string; role: Role; logsRead?: boolean }): UserRow {
    const now = Date.now();
    const info = this.db
      .prepare(
        'INSERT INTO users (username, password_hash, role, logs_read, created_at, password_changed_at) VALUES (?,?,?,?,?,?)',
      )
      .run(u.username, u.passwordHash, u.role, u.logsRead ? 1 : 0, now, now);
    return this.byId(Number(info.lastInsertRowid)) as UserRow;
  }

  byId(id: number): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  byUsername(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  }

  list(): UserRow[] {
    return this.db.prepare('SELECT * FROM users ORDER BY id').all() as UserRow[];
  }

  countActiveAdmins(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0").get() as {
        n: number;
      }
    ).n;
  }

  update(id: number, patch: { role?: Role; logsRead?: boolean; disabled?: boolean }): void {
    if (patch.role !== undefined) this.db.prepare('UPDATE users SET role=? WHERE id=?').run(patch.role, id);
    if (patch.logsRead !== undefined) {
      this.db.prepare('UPDATE users SET logs_read=? WHERE id=?').run(patch.logsRead ? 1 : 0, id);
    }
    if (patch.disabled !== undefined) {
      this.db.prepare('UPDATE users SET disabled=? WHERE id=?').run(patch.disabled ? 1 : 0, id);
    }
  }

  setPasswordHash(id: number, hash: string): void {
    this.db
      .prepare('UPDATE users SET password_hash=?, password_changed_at=? WHERE id=?')
      .run(hash, Date.now(), id);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }
}
