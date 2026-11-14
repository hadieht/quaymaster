import type { IgnoredEntry } from '@quaymaster/shared';
import type { Db } from './connection.js';

interface Row {
  id: number;
  kind: 'project' | 'container';
  name: string;
  working_dir: string;
  ignored_at: number;
  ignored_by: string;
}

const toEntry = (r: Row): IgnoredEntry => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  workingDir: r.working_dir,
  ignoredAt: new Date(r.ignored_at).toISOString(),
  ignoredBy: r.ignored_by,
});

/** Persistence of the "stop monitoring" list. Keyed by (kind, name, working directory). */
export class IgnoreRepo {
  constructor(private readonly db: Db) {}

  list(): IgnoredEntry[] {
    return (
      this.db.prepare('SELECT * FROM ignored_targets ORDER BY kind, name, working_dir').all() as Row[]
    ).map(toEntry);
  }

  get(id: number): IgnoredEntry | undefined {
    const r = this.db.prepare('SELECT * FROM ignored_targets WHERE id = ?').get(id) as Row | undefined;
    return r ? toEntry(r) : undefined;
  }

  /** Idempotent: re-ignoring an already ignored target returns the existing entry. */
  add(kind: 'project' | 'container', name: string, workingDir: string, by: string): IgnoredEntry {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO ignored_targets (kind, name, working_dir, ignored_at, ignored_by) VALUES (?,?,?,?,?)',
      )
      .run(kind, name, workingDir, Date.now(), by);
    return toEntry(
      this.db
        .prepare('SELECT * FROM ignored_targets WHERE kind = ? AND name = ? AND working_dir = ?')
        .get(kind, name, workingDir) as Row,
    );
  }

  remove(id: number): boolean {
    return this.db.prepare('DELETE FROM ignored_targets WHERE id = ?').run(id).changes > 0;
  }
}
