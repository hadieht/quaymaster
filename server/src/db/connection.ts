import Database from 'better-sqlite3';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { runMigrations } from './migrate.js';

export type Db = Database.Database;

export interface OpenedDb {
  db: Db;
  close(): void;
}

/** Opens (creating if needed) the SQLite database with the pragmas from RT-27, then migrates. */
export function openDatabase(file: string, opts: { backupDir?: string } = {}): OpenedDb {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  runMigrations(db, { backupDir: file === ':memory:' ? undefined : (opts.backupDir ?? path.dirname(file)) });
  let timer: NodeJS.Timeout | undefined;
  if (file !== ':memory:') {
    timer = setInterval(() => {
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        /* busy: try again next time */
      }
    }, 10 * 60_000);
    timer.unref();
  }
  return {
    db,
    close() {
      if (timer) clearInterval(timer);
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        /* ignore */
      }
      db.close();
    },
  };
}

/**
 * Single-instance guard (RT-27): two instances on one data directory would run two schedulers.
 * Node has no flock(), so this is an O_EXCL pid file with a liveness check for stale files.
 */
export function acquireInstanceLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const lock = path.join(dataDir, 'quaymaster.lock');
  const tryCreate = (): number | null => {
    try {
      return openSync(lock, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw e;
    }
  };
  let fd = tryCreate();
  if (fd === null) {
    const holder = Number.parseInt(readFileSync(lock, 'utf8').split('\n')[0] ?? '', 10);
    let alive = false;
    if (Number.isInteger(holder) && holder > 0 && holder !== process.pid) {
      try {
        process.kill(holder, 0);
        alive = true;
      } catch (e) {
        alive = (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    }
    if (alive) {
      throw new Error(`Another Quaymaster instance (pid ${holder}) is using ${dataDir}. Refusing to start.`);
    }
    unlinkSync(lock);
    fd = tryCreate();
    if (fd === null) throw new Error(`Could not acquire ${lock}`);
  }
  writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
  closeSync(fd);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (existsSync(lock)) unlinkSync(lock);
  };
}
