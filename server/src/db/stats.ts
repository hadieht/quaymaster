import type { Db } from './connection.js';
import type { SecretBox } from '../crypto/secretbox.js';

export interface RollupRow {
  container_id: string;
  minute: number;
  name: string;
  samples: number;
  cpu_avg: number;
  cpu_max: number;
  mem_avg: number;
  mem_max: number;
  net_rx: number;
  net_tx: number;
  blk_read: number;
  blk_write: number;
}

export class StatsRepo {
  constructor(private readonly db: Db) {}

  upsertMany(rows: RollupRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO stats_rollups (container_id, minute, name, samples, cpu_avg, cpu_max, mem_avg, mem_max, net_rx, net_tx, blk_read, blk_write)
       VALUES (@container_id, @minute, @name, @samples, @cpu_avg, @cpu_max, @mem_avg, @mem_max, @net_rx, @net_tx, @blk_read, @blk_write)
       ON CONFLICT(container_id, minute) DO UPDATE SET samples=excluded.samples, cpu_avg=excluded.cpu_avg, cpu_max=excluded.cpu_max,
         mem_avg=excluded.mem_avg, mem_max=excluded.mem_max, net_rx=excluded.net_rx, net_tx=excluded.net_tx,
         blk_read=excluded.blk_read, blk_write=excluded.blk_write`,
    );
    this.db.transaction(() => {
      for (const r of rows) stmt.run(r);
    })();
  }

  history(containerId: string, sinceMinute: number, limit = 10_000): RollupRow[] {
    return this.db
      .prepare('SELECT * FROM stats_rollups WHERE container_id = ? AND minute >= ? ORDER BY minute LIMIT ?')
      .all(containerId, sinceMinute, limit) as RollupRow[];
  }

  prune(olderThanMinute: number, batch = 5000): number {
    return this.db
      .prepare(
        'DELETE FROM stats_rollups WHERE rowid IN (SELECT rowid FROM stats_rollups WHERE minute < ? LIMIT ?)',
      )
      .run(olderThanMinute, batch).changes;
  }
}

/** Key/value store for small settings. */
export class KvRepo {
  constructor(private readonly db: Db) {}
  get(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }
  set(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
}

/** Encrypted secret storage (notification / registry credentials in later phases). */
export class SecretStore {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
  ) {}

  private aad(name: string): string {
    return `secret_store:ciphertext:${name}`;
  }

  put(name: string, plaintext: string): void {
    const ct = this.box.encrypt(plaintext, this.aad(name));
    this.db
      .prepare(
        'INSERT INTO secret_store (name, ciphertext, updated_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET ciphertext=excluded.ciphertext, updated_at=excluded.updated_at',
      )
      .run(name, ct, Date.now());
  }

  get(name: string): string | undefined {
    const r = this.db.prepare('SELECT ciphertext FROM secret_store WHERE name = ?').get(name) as
      | { ciphertext: string }
      | undefined;
    return r ? this.box.decrypt(r.ciphertext, this.aad(name)) : undefined;
  }

  delete(name: string): void {
    this.db.prepare('DELETE FROM secret_store WHERE name = ?').run(name);
  }
}
