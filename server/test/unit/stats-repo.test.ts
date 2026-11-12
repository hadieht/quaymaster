import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/db/connection.js';
import { StatsRepo, type RollupRow } from '../../src/db/stats.js';

const row = (id: string, minute: number): RollupRow => ({
  container_id: id,
  minute,
  name: 'qmtest-x',
  samples: 1,
  cpu_avg: 1,
  cpu_max: 1,
  mem_avg: 1,
  mem_max: 1,
  net_rx: 0,
  net_tx: 0,
  blk_read: 0,
  blk_write: 0,
});

describe('StatsRepo.prune', () => {
  it('deletes only roll-ups older than the cutoff (WITHOUT ROWID table)', () => {
    const opened = openDatabase(path.join(mkdtempSync(path.join(os.tmpdir(), 'qm-stats-')), 'q.db'));
    const repo = new StatsRepo(opened.db);
    repo.upsertMany([row('a', 1), row('a', 2), row('b', 1), row('b', 10)]);
    expect(repo.prune(5)).toBe(3);
    expect(repo.since(0).map((r) => `${r.container_id}${r.minute}`)).toEqual(['b10']);
  });
});
