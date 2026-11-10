import type { Db } from './connection.js';
import type { SecretStore } from './stats.js';

export interface CheckRow {
  ref: string;
  state: string;
  reason: string | null;
  local_digest: string | null;
  remote_digest: string | null;
  source: string | null;
  checked_at: number;
  expires_at: number;
}

/** Cached registry lookups, keyed by canonical `registry/repo:tag`. */
export class ImageChecksRepo {
  constructor(private readonly db: Db) {}

  get(ref: string): CheckRow | undefined {
    return this.db.prepare('SELECT * FROM image_checks WHERE ref = ?').get(ref) as CheckRow | undefined;
  }

  put(row: CheckRow): void {
    this.db
      .prepare(
        `INSERT INTO image_checks (ref, state, reason, local_digest, remote_digest, source, checked_at, expires_at)
         VALUES (@ref,@state,@reason,@local_digest,@remote_digest,@source,@checked_at,@expires_at)
         ON CONFLICT(ref) DO UPDATE SET state=excluded.state, reason=excluded.reason, local_digest=excluded.local_digest,
           remote_digest=excluded.remote_digest, source=excluded.source, checked_at=excluded.checked_at, expires_at=excluded.expires_at`,
      )
      .run(row);
  }

  invalidate(ref?: string): void {
    if (ref) this.db.prepare('DELETE FROM image_checks WHERE ref = ?').run(ref);
    else this.db.prepare('DELETE FROM image_checks').run();
  }
}

export interface StagedRow {
  tag: string;
  ref: string;
  digest: string;
  image_id: string | null;
  created_at: number;
}

export class StagedRepo {
  constructor(private readonly db: Db) {}
  put(r: StagedRow): void {
    this.db
      .prepare(
        `INSERT INTO staged_images (tag, ref, digest, image_id, created_at) VALUES (@tag,@ref,@digest,@image_id,@created_at)
         ON CONFLICT(tag) DO UPDATE SET image_id=excluded.image_id, created_at=excluded.created_at`,
      )
      .run(r);
  }
  get(tag: string): StagedRow | undefined {
    return this.db.prepare('SELECT * FROM staged_images WHERE tag = ?').get(tag) as StagedRow | undefined;
  }
  list(): StagedRow[] {
    return this.db.prepare('SELECT * FROM staged_images ORDER BY created_at DESC').all() as StagedRow[];
  }
  delete(tag: string): void {
    this.db.prepare('DELETE FROM staged_images WHERE tag = ?').run(tag);
  }
}

export interface RollbackRow {
  tag: string;
  run_id: string;
  project: string | null;
  service: string | null;
  container_name: string | null;
  ref: string;
  image_id: string;
  created_at: number;
  expires_at: number;
  released: number;
}

export class RollbackRepo {
  constructor(private readonly db: Db) {}
  put(r: Omit<RollbackRow, 'released'>): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO rollback_points (tag, run_id, project, service, container_name, ref, image_id, created_at, expires_at, released)
         VALUES (@tag,@run_id,@project,@service,@container_name,@ref,@image_id,@created_at,@expires_at,0)`,
      )
      .run(r);
  }
  get(tag: string): RollbackRow | undefined {
    return this.db.prepare('SELECT * FROM rollback_points WHERE tag = ?').get(tag) as RollbackRow | undefined;
  }
  forRun(runId: string): RollbackRow[] {
    return this.db.prepare('SELECT * FROM rollback_points WHERE run_id = ?').all(runId) as RollbackRow[];
  }
  /** Active = not released. They are protected from cleanup until `expires_at`. */
  active(): RollbackRow[] {
    return this.db.prepare('SELECT * FROM rollback_points WHERE released = 0').all() as RollbackRow[];
  }
  expired(now: number): RollbackRow[] {
    return this.db
      .prepare('SELECT * FROM rollback_points WHERE released = 0 AND expires_at <= ?')
      .all(now) as RollbackRow[];
  }
  release(tag: string): void {
    this.db.prepare('UPDATE rollback_points SET released = 1 WHERE tag = ?').run(tag);
  }
  list(limit = 200): RollbackRow[] {
    return this.db
      .prepare('SELECT * FROM rollback_points ORDER BY created_at DESC LIMIT ?')
      .all(limit) as RollbackRow[];
  }
}

export interface QuarantineRow {
  target: string;
  digest: string;
  run_id: string | null;
  reason: string | null;
  created_at: number;
  cleared_at: number | null;
}

/** RT-22: a failed (target, remote digest) pair is skipped by unattended runs until cleared. */
export class QuarantineRepo {
  constructor(private readonly db: Db) {}
  add(target: string, digest: string, runId: string | null, reason: string | null, now: number): boolean {
    const r = this.db
      .prepare(
        `INSERT INTO quarantine (target, digest, run_id, reason, created_at) VALUES (?,?,?,?,?)
         ON CONFLICT(target, digest) DO UPDATE SET cleared_at = NULL, run_id = excluded.run_id, reason = excluded.reason
         WHERE quarantine.cleared_at IS NOT NULL`,
      )
      .run(target, digest, runId, reason, now);
    return r.changes > 0;
  }
  isQuarantined(target: string, digest: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM quarantine WHERE target = ? AND digest = ? AND cleared_at IS NULL')
      .get(target, digest);
  }
  clear(target: string, digest: string | null, now: number): number {
    return digest
      ? this.db
          .prepare('UPDATE quarantine SET cleared_at = ? WHERE target = ? AND digest = ? AND cleared_at IS NULL')
          .run(now, target, digest).changes
      : this.db
          .prepare('UPDATE quarantine SET cleared_at = ? WHERE target = ? AND cleared_at IS NULL')
          .run(now, target).changes;
  }
  list(): QuarantineRow[] {
    return this.db
      .prepare('SELECT * FROM quarantine WHERE cleared_at IS NULL ORDER BY created_at DESC')
      .all() as QuarantineRow[];
  }
}

/** Registry credentials: metadata in a table, the password encrypted in the secret store (AES-256-GCM). */
export class RegistryCredentialsRepo {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
  ) {}

  put(host: string, username: string, password: string): void {
    this.secrets.put(`registry:${host}`, password);
    this.db
      .prepare(
        `INSERT INTO registry_credentials (host, username, updated_at) VALUES (?,?,?)
         ON CONFLICT(host) DO UPDATE SET username=excluded.username, updated_at=excluded.updated_at`,
      )
      .run(host, username, Date.now());
  }

  get(host: string): { username: string; password: string } | undefined {
    const row = this.db.prepare('SELECT username FROM registry_credentials WHERE host = ?').get(host) as
      | { username: string }
      | undefined;
    if (!row) return undefined;
    const password = this.secrets.get(`registry:${host}`);
    return password === undefined ? undefined : { username: row.username, password };
  }

  list(): { host: string; username: string; updated_at: number }[] {
    return this.db
      .prepare('SELECT host, username, updated_at FROM registry_credentials ORDER BY host')
      .all() as { host: string; username: string; updated_at: number }[];
  }

  delete(host: string): boolean {
    this.secrets.delete(`registry:${host}`);
    return this.db.prepare('DELETE FROM registry_credentials WHERE host = ?').run(host).changes > 0;
  }
}
