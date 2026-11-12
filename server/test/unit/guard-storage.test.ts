import { describe, expect, it } from 'vitest';
import { checkEngineRequest } from '../../src/security/guard.js';

const rw = { readOnlyReason: null };
const NET = 'd'.repeat(64);

describe('Engine allow-list: volume and network removal', () => {
  it('needs a permit naming exactly that volume, and is never forced', () => {
    const permit = { kind: 'volume_remove' as const, name: 'qmtest-v' };
    expect(() => checkEngineRequest('DELETE', '/volumes/qmtest-v', rw, permit)).not.toThrow();
    expect(() =>
      checkEngineRequest('DELETE', '/v1.45/volumes/qmtest-v?force=false', rw, permit),
    ).not.toThrow();
    expect(() => checkEngineRequest('DELETE', '/volumes/qmtest-v?force=true', rw, permit)).toThrow(
      /not authorised/,
    );
    expect(() => checkEngineRequest('DELETE', '/volumes/other', rw, permit)).toThrow(/not authorised/);
    expect(() => checkEngineRequest('DELETE', '/volumes/qmtest-v', rw, undefined)).toThrow(/allow-list/);
    expect(() =>
      checkEngineRequest('DELETE', '/volumes/qmtest-v', rw, { kind: 'image_remove', name: 'qmtest-v' }),
    ).toThrow(/allow-list/);
  });

  it('needs a permit naming exactly that network by full ID', () => {
    const permit = { kind: 'network_remove' as const, id: NET };
    expect(() => checkEngineRequest('DELETE', `/networks/${NET}`, rw, permit)).not.toThrow();
    expect(() => checkEngineRequest('DELETE', `/networks/${'e'.repeat(64)}`, rw, permit)).toThrow(
      /not authorised/,
    );
    expect(() =>
      checkEngineRequest('DELETE', '/networks/bridge', rw, { kind: 'network_remove', id: 'bridge' }),
    ).toThrow(/not authorised/); // names are refused: full IDs only
    expect(() => checkEngineRequest('DELETE', `/networks/${NET}`, rw, undefined)).toThrow(/allow-list/);
  });

  it('prune endpoints stay forbidden even with a remove permit; read-only mode blocks removal', () => {
    for (const p of ['/volumes/prune', '/networks/prune', '/images/prune', '/build/prune', '/system/prune']) {
      expect(() => checkEngineRequest('POST', p, rw, { kind: 'volume_remove', name: 'prune' })).toThrow(
        /allow-list/,
      );
    }
    expect(() =>
      checkEngineRequest(
        'DELETE',
        '/volumes/qmtest-v',
        { readOnlyReason: 'QM_READ_ONLY is set' },
        {
          kind: 'volume_remove',
          name: 'qmtest-v',
        },
      ),
    ).toThrow(/Read-only/);
  });
});
