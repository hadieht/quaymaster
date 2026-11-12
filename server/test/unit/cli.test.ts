import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli.js';
import { openDatabase } from '../../src/db/connection.js';

describe('operator CLI', () => {
  const old = process.env['QM_DATA_DIR'];
  afterEach(() => {
    if (old === undefined) delete process.env['QM_DATA_DIR'];
    else process.env['QM_DATA_DIR'] = old;
  });

  it('online backup produces a valid database, restore puts it back, overwrite is refused', async () => {
    const base = mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'qm-cli-'));
    process.env['QM_DATA_DIR'] = path.join(base, 'data');
    const o = openDatabase(path.join(base, 'data', 'quaymaster.db'));
    o.db
      .prepare(
        "INSERT INTO users(username,password_hash,role,created_at,password_changed_at) VALUES('cli','x','viewer',1,1)",
      )
      .run();
    const dest = path.join(base, 'bk', 'q.db');
    expect(await main(['backup', dest])).toBe(0);
    expect(existsSync(dest)).toBe(true);
    await expect(main(['backup', dest])).rejects.toThrow(/already exists/);
    expect(await main(['check', dest])).toBe(0);
    o.close();
    expect(await main(['restore', dest])).toBe(0);
    expect(await main(['nonsense'])).toBe(2);
  });
});
