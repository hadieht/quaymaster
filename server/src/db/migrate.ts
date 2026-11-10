import type { Db } from './connection.js';
import path from 'node:path';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Forward-only migrations. Never edit an applied migration: add a new one.
 * (Kept as TypeScript so the build needs no asset-copy step.)
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','viewer')),
  logs_read INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  password_changed_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_secret TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  ip TEXT,
  action TEXT NOT NULL,
  target TEXT,
  params TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','denied')),
  duration_ms INTEGER
);
CREATE INDEX audit_ts ON audit_log(ts);
-- Append-only at the database level too: rows can never be updated, and only rows older than the
-- 30-day minimum retention may be deleted (by the retention job).
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_no_young_delete BEFORE DELETE ON audit_log
WHEN OLD.ts > (CAST(strftime('%s','now') AS INTEGER) - 30*86400) * 1000
BEGIN SELECT RAISE(ABORT, 'audit_log rows younger than 30 days cannot be deleted'); END;

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  name TEXT,
  image TEXT,
  project TEXT,
  service TEXT,
  attributes TEXT NOT NULL DEFAULT '{}',
  synthetic INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX events_ts ON events(ts);
CREATE INDEX events_actor ON events(actor_id);

CREATE TABLE stats_rollups (
  container_id TEXT NOT NULL,
  minute INTEGER NOT NULL,
  name TEXT NOT NULL,
  samples INTEGER NOT NULL,
  cpu_avg REAL NOT NULL, cpu_max REAL NOT NULL,
  mem_avg REAL NOT NULL, mem_max REAL NOT NULL,
  net_rx INTEGER NOT NULL, net_tx INTEGER NOT NULL,
  blk_read INTEGER NOT NULL, blk_write INTEGER NOT NULL,
  PRIMARY KEY (container_id, minute)
) WITHOUT ROWID;
CREATE INDEX stats_minute ON stats_rollups(minute);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  actor TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  compose_version TEXT,
  params TEXT,
  output TEXT NOT NULL DEFAULT '',
  error TEXT
);
CREATE INDEX operations_started ON operations(started_at);

-- Write-ahead intents (RT-14): persisted BEFORE each side-effecting sub-step so startup
-- reconciliation can tell what was in flight. Used by phase 2's executor; created now.
CREATE TABLE intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES operations(id),
  service TEXT,
  action TEXT NOT NULL,
  from_image TEXT,
  to_image TEXT,
  container_ids_before TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

-- RT-09: one row per (schedule, occurrence); an occurrence with any run is never started again.
CREATE TABLE schedule_occurrences (
  schedule_id TEXT NOT NULL,
  occurrence_utc INTEGER NOT NULL,
  status TEXT NOT NULL,
  run_id TEXT,
  UNIQUE (schedule_id, occurrence_utc)
);

CREATE TABLE secret_store (
  name TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
];

export function runMigrations(db: Db, opts: { backupDir?: string; migrations?: Migration[] } = {}): number[] {
  const migrations = opts.migrations ?? MIGRATIONS;
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`,
  );
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  const newest = Math.max(0, ...migrations.map((m) => m.version));
  const dbNewest = Math.max(0, ...applied);
  if (dbNewest > newest) {
    throw new Error(
      `Database schema version ${dbNewest} is newer than this build supports (${newest}). Refusing to start; upgrade Quaymaster or restore a backup.`,
    );
  }
  const pending = migrations.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return [];
  if (applied.size > 0 && opts.backupDir) {
    const target = path.join(opts.backupDir, `backup-pre-v${pending[0]?.version}.db`);
    db.prepare('VACUUM INTO ?').run(target);
  }
  const done: number[] = [];
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        Date.now(),
      );
    })();
    done.push(m.version);
  }
  return done;
}
