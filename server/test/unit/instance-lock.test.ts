import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireInstanceLock } from '../../src/db/connection.js';

function dir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'qm-lock-'));
}

describe('instance lock', () => {
  it('refuses a second holder while the first is alive', () => {
    const d = dir();
    const release = acquireInstanceLock(d);
    // simulate another host (container) holding a fresh lock
    writeFileSync(
      path.join(d, 'quaymaster.lock'),
      `4242\n${new Date().toISOString()}\nsome-other-container\n`,
    );
    expect(() => acquireInstanceLock(d)).toThrow(/Another Quaymaster instance/);
    release();
  });

  it('reclaims a lock left by a SIGKILLed container (other hostname, stale mtime), even if the pid exists here', () => {
    const d = dir();
    const lock = path.join(d, 'quaymaster.lock');
    writeFileSync(lock, `1\n${new Date().toISOString()}\nold-container-id\n`); // pid 1 always exists
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const release = acquireInstanceLock(d);
    release();
  });
});
