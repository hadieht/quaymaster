import { describe, expect, it } from 'vitest';
import { parseTokenRealms } from '../../src/config/env.js';
import { DEFAULT_REALM_ALLOW, mergeRealmAllow } from '../../src/registry/client.js';

describe('registry token realms', () => {
  it('docker.n8n.io may use Docker Hub token service by default', () => {
    expect(DEFAULT_REALM_ALLOW['docker.n8n.io']).toEqual(['auth.docker.io']);
  });

  it('parses registry=token pairs, lowercased', () => {
    expect(parseTokenRealms(['Reg.Example.com=Auth.Example.com', 'reg.example.com=sso.example.org'])).toEqual(
      {
        'reg.example.com': ['auth.example.com', 'sso.example.org'],
      },
    );
  });

  it.each([
    'nohost',
    'a.b.c=',
    '=a.b.c',
    'a.b.c=d.e.f=g.h.i',
    'a.b.c=1.2.3',
    'a.b.c=evil.com:99',
    'a b.c=d.e',
    'a.b.c=-x.com',
  ])('rejects malformed entry %s', (bad) => {
    expect(() => parseTokenRealms([bad])).toThrow(/QM_REGISTRY_TOKEN_REALMS/);
  });

  it('configured hosts add to the built-ins and never replace them', () => {
    const m = mergeRealmAllow(DEFAULT_REALM_ALLOW, {
      'ghcr.io': ['extra.example.com'],
      'new.example.com': ['tok.example.com'],
    });
    expect(m['ghcr.io']).toEqual(['ghcr.io', 'extra.example.com']);
    expect(m['new.example.com']).toEqual(['tok.example.com']);
    expect(m['registry-1.docker.io']).toEqual(['auth.docker.io']);
  });
});
