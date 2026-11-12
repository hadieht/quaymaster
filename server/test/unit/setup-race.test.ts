import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SetupService } from '../../src/auth/setup.js';

/** Audit M-01: the setup token can be redeemed only once, even by concurrent requests. */
describe('M-01 setup token redemption', () => {
  function make() {
    const dataDir = mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'qm-setup-'));
    const users: string[] = [];
    let failNext = false;
    const svc = new SetupService({
      users: { count: () => users.length } as never,
      auth: {
        createUser: async (u: { username: string }) => {
          await new Promise((r) => setTimeout(r, 40)); // the scrypt hash yields the event loop
          if (failNext) {
            failNext = false;
            throw new Error('weak password');
          }
          users.push(u.username);
          return { id: users.length };
        },
      } as never,
      passwords: {} as never,
      config: { dataDir, admin: null } as never,
      announce: () => undefined,
    });
    return { svc, users, dataDir, failNext: () => (failNext = true) };
  }

  it('four concurrent redemptions create exactly one admin', async () => {
    const t = make();
    await t.svc.init();
    const token = readFileSync(path.join(t.dataDir, 'setup-token'), 'utf8').trim();
    const results = await Promise.allSettled(
      [0, 1, 2, 3].map((i) =>
        t.svc.complete({ token, username: `race${i}`, password: 'x'.repeat(14), ip: '127.0.0.1' }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(t.users).toHaveLength(1);
    t.svc.stop();
  });

  it('a failed creation (e.g. weak password) does not burn the token', async () => {
    const t = make();
    await t.svc.init();
    const token = readFileSync(path.join(t.dataDir, 'setup-token'), 'utf8').trim();
    t.failNext();
    await expect(
      t.svc.complete({ token, username: 'a', password: 'x'.repeat(14), ip: '127.0.0.1' }),
    ).rejects.toThrow();
    await t.svc.complete({ token, username: 'b', password: 'x'.repeat(14), ip: '127.0.0.1' });
    expect(t.users).toEqual(['b']);
    t.svc.stop();
  });
});
