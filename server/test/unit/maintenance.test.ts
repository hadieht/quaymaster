import { describe, expect, it } from 'vitest';
import type { Plan } from '@quaymaster/shared';
import { waitForHealth, type InspectLite } from '../../src/maintenance/health.js';
import {
  computePlanHash,
  effectiveHealthTimeoutSeconds,
  orderServices,
  parseDurationMs,
} from '../../src/maintenance/planner.js';
import { resolveAutoRollback, resolvePolicy, unattendedBlockers } from '../../src/maintenance/policy.js';
import { RegistryClient, RegistryError, parseChallenge } from '../../src/registry/client.js';
import { digestsForRepo, parseImageRef, rollbackTag, stagedTag } from '../../src/registry/reference.js';
import { classify } from '../../src/updates/detector.js';

describe('image references', () => {
  it('normalises Docker Hub, ghcr and local registries', () => {
    expect(parseImageRef('nginx')).toMatchObject({
      registry: 'docker.io',
      repo: 'library/nginx',
      tag: 'latest',
    });
    expect(parseImageRef('ghcr.io/a/b:1')).toMatchObject({ registry: 'ghcr.io', repo: 'a/b', tag: '1' });
    expect(parseImageRef('127.0.0.1:5055/qmtest-app:latest')).toMatchObject({
      registry: '127.0.0.1:5055',
      repo: 'qmtest-app',
    });
    expect(parseImageRef('x@sha256:' + 'a'.repeat(64))?.digest).toBe('sha256:' + 'a'.repeat(64));
    expect(parseImageRef('UPPER/Case')).toBeNull();
  });
  it('picks the RepoDigest of the matching repository only', () => {
    const ref = parseImageRef('nginx:1') as NonNullable<ReturnType<typeof parseImageRef>>;
    const d = 'sha256:' + '1'.repeat(64);
    expect(digestsForRepo([`nginx@${d}`, `other/nginx@sha256:${'2'.repeat(64)}`], ref)).toEqual([d]);
  });
  it('rollback and staged tags are valid lower-case repository names (RT-06)', () => {
    expect(rollbackTag('My.Project', 'Web.Server', 'ABC-123')).toMatch(
      /^quaymaster-rollback\/[0-9a-f]{12}:abc-123$/,
    );
    expect(stagedTag({ registry: 'docker.io', repo: 'library/nginx' }, 'sha256:' + 'f'.repeat(64))).toMatch(
      /^quaymaster-staged\/[0-9a-f]{12}:f{12}$/,
    );
  });
});

describe('planner: ordering and hashing', () => {
  const edge = (from: string, to: string, kind: 'depends_on' | 'shares_namespace' = 'depends_on') => ({
    from,
    to,
    kind,
  });
  it('orders dependencies first, including indirect ones through services outside the selection', () => {
    const r = orderServices(
      [
        { name: 'web', order: null },
        { name: 'db', order: null },
      ],
      [edge('web', 'cache'), edge('cache', 'db')],
    );
    expect(r.order).toEqual(['db', 'web']);
  });
  it('uses update_order then name to break ties; reports cycles', () => {
    expect(
      orderServices(
        [
          { name: 'b', order: 1 },
          { name: 'a', order: 2 },
          { name: 'c', order: null },
        ],
        [],
      ).order,
    ).toEqual(['b', 'a', 'c']);
    expect(
      orderServices(
        [
          { name: 'a', order: null },
          { name: 'b', order: null },
        ],
        [edge('a', 'b'), edge('b', 'a')],
      ).cycle,
    ).toEqual(['a', 'b']);
  });
  it('namespace providers come before their dependents', () => {
    expect(
      orderServices(
        [
          { name: 'qbit', order: null },
          { name: 'gluetun', order: null },
        ],
        [edge('qbit', 'gluetun', 'shares_namespace')],
      ).order,
    ).toEqual(['gluetun', 'qbit']);
  });
  it('plan hash changes when the target digest, image or config changes, not with timestamps', () => {
    const svc = {
      service: 'app',
      role: 'update',
      ref: 'x:1',
      fromImageId: 'sha256:a',
      toDigest: 'sha256:b',
      configHash: 'h',
      wasRunning: true,
      updateMode: 'auto',
      critical: false,
      requireApproval: false,
      autoRollback: true,
      health: { kind: 'healthcheck', timeoutSeconds: 60, stabilizationSeconds: 10, probe: null },
    } as unknown as Plan['services'][number];
    const base = { kind: 'compose', target: 'p', order: ['app'], services: [svc] } as Pick<
      Plan,
      'kind' | 'target' | 'order' | 'services'
    >;
    const h = computePlanHash(base);
    expect(computePlanHash({ ...base })).toBe(h);
    expect(computePlanHash({ ...base, services: [{ ...svc, toDigest: 'sha256:c' }] })).not.toBe(h);
    expect(computePlanHash({ ...base, services: [{ ...svc, configHash: 'other' }] })).not.toBe(h);
    expect(computePlanHash({ ...base, services: [{ ...svc, fromImageId: 'sha256:z' }] })).not.toBe(h);
  });
  it('health timeout respects the healthcheck own timings (RT-10) and durations parse', () => {
    expect(
      effectiveHealthTimeoutSeconds(60, { intervalMs: 30_000, retries: 3, startPeriodMs: 300_000 }),
    ).toBe(420);
    expect(effectiveHealthTimeoutSeconds(60, null)).toBe(60);
    expect(parseDurationMs('1m30s')).toBe(90_000);
    expect(parseDurationMs(2e9)).toBe(2000);
  });
});

describe('policy resolution (RT-23)', () => {
  it('default is notify + approval required', () => {
    const p = resolvePolicy([]);
    expect(p).toMatchObject({
      updateMode: 'notify',
      critical: false,
      requireApproval: true,
      autoRollbackExplicit: null,
    });
  });
  it('most specific wins for update_mode, but safety flags are most restrictive', () => {
    const p = resolvePolicy([
      { level: 'project:x', policy: { critical: true, requireApproval: true, autoRollback: false } },
      {
        level: 'service:x/web',
        policy: { updateMode: 'auto', critical: false, requireApproval: false, autoRollback: true },
      },
    ]);
    expect(p.updateMode).toBe('auto');
    expect(p.critical).toBe(true);
    expect(p.requireApproval).toBe(true);
    expect(p.autoRollbackExplicit).toBe(false);
  });
  it('unattended truth table', () => {
    expect(
      unattendedBlockers({ updateMode: 'auto', critical: false, requireApproval: false }, 'auto'),
    ).toEqual([]);
    expect(
      unattendedBlockers({ updateMode: 'auto', critical: true, requireApproval: false }, 'auto'),
    ).toHaveLength(1);
    expect(
      unattendedBlockers({ updateMode: 'auto', critical: false, requireApproval: true }, 'auto'),
    ).toHaveLength(1);
    expect(
      unattendedBlockers({ updateMode: 'notify', critical: false, requireApproval: false }, 'auto'),
    ).toHaveLength(1);
    expect(
      unattendedBlockers({ updateMode: 'auto', critical: false, requireApproval: false }, 'manual'),
    ).toHaveLength(1);
  });
  it('auto-rollback defaults OFF with persistent mounts, ON otherwise; explicit wins', () => {
    expect(resolveAutoRollback(null, true).value).toBe(false);
    expect(resolveAutoRollback(null, false).value).toBe(true);
    expect(resolveAutoRollback(true, true).value).toBe(true);
    expect(resolveAutoRollback(false, false).value).toBe(false);
  });
});

describe('health gate state machine', () => {
  const mk = (over: Partial<InspectLite['State']> = {}, image = 'sha256:new', restarts = 0): InspectLite => ({
    Image: image,
    RestartCount: restarts,
    State: {
      Status: 'running',
      Running: true,
      Restarting: false,
      ExitCode: 0,
      StartedAt: 't0',
      Health: null,
      ...over,
    },
  });
  const run = (seq: InspectLite[], kind: 'healthcheck' | 'stability' | 'oneshot', extra = {}) => {
    let i = 0;
    let t = 0;
    return waitForHealth(
      {
        inspect: async () => seq[Math.min(i++, seq.length - 1)] ?? null,
        now: () => t,
        sleep: async (ms) => void (t += ms),
        pollMs: 1000,
        ...extra,
      },
      ['c'],
      { kind, timeoutMs: 20_000, stabilizationMs: 3000, probe: null, expectedImageId: 'sha256:new' },
    );
  };
  it('healthcheck: starting → healthy passes; unhealthy fails at once', async () => {
    expect(
      (
        await run(
          [mk({ Health: { Status: 'starting' } }), mk({ Health: { Status: 'healthy' } })],
          'healthcheck',
        )
      ).ok,
    ).toBe(true);
    const bad = await run(
      [mk({ Health: { Status: 'starting' } }), mk({ Health: { Status: 'unhealthy' } })],
      'healthcheck',
    );
    expect(bad).toMatchObject({ ok: false });
    expect(bad.reason).toMatch(/unhealthy/);
  });
  it('wrong image after deploy is a health failure (RT-06)', async () => {
    expect((await run([mk({}, 'sha256:old')], 'stability')).reason).toMatch(/runs image/);
  });
  it('stability: stable for the period passes; a restart loop or exit fails', async () => {
    expect((await run([mk()], 'stability')).ok).toBe(true);
    expect((await run([mk(), mk({}, 'sha256:new', 2)], 'stability')).reason).toMatch(/restart loop/);
    expect((await run([mk({ Status: 'exited', Running: false, ExitCode: 1 })], 'stability')).reason).toMatch(
      /exited with code 1/,
    );
  });
  it('one-shot services succeed on exit 0 and fail on non-zero', async () => {
    expect((await run([mk(), mk({ Status: 'exited', Running: false, ExitCode: 0 })], 'oneshot')).ok).toBe(
      true,
    );
    expect((await run([mk({ Status: 'exited', Running: false, ExitCode: 3 })], 'oneshot')).ok).toBe(false);
  });
  it('times out and reports the last observation', async () => {
    const r = await run([mk({ Health: { Status: 'starting' } })], 'healthcheck');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/timed out after 20s: health is starting/);
  });
});

describe('update classification', () => {
  const ref = parseImageRef('127.0.0.1:5055/qmtest-app:latest');
  const d1 = 'sha256:' + '1'.repeat(64);
  const d2 = 'sha256:' + '2'.repeat(64);
  const ok = (digest: string) => ({ digest, source: 'registry' as const, error: null, checkedAt: 0 });
  const base = { ref, rawRef: '127.0.0.1:5055/qmtest-app:latest', stagedPresent: false, imageIsId: false };
  it('up_to_date / update_available / update_staged', () => {
    const rd = [`127.0.0.1:5055/qmtest-app@${d1}`];
    expect(classify({ ...base, localRepoDigests: rd, remote: ok(d1) }).state).toBe('up_to_date');
    expect(classify({ ...base, localRepoDigests: rd, remote: ok(d2) }).state).toBe('update_available');
    expect(classify({ ...base, localRepoDigests: rd, remote: ok(d2), stagedPresent: true }).state).toBe(
      'update_staged',
    );
  });
  it('multi-arch: a local platform digest listed in the remote index counts as up to date', () => {
    expect(
      classify({
        ...base,
        localRepoDigests: [`127.0.0.1:5055/qmtest-app@${d1}`],
        remote: ok(d2),
        remotePlatformDigests: [d1],
      }).state,
    ).toBe('up_to_date');
  });
  it('local_only, pinned_digest and unknown with reasons', () => {
    expect(
      classify({
        ...base,
        localRepoDigests: [],
        remote: {
          digest: null,
          source: 'registry',
          checkedAt: 0,
          error: { kind: 'not_found', message: 'nope' },
        },
      }).state,
    ).toBe('local_only');
    expect(
      classify({ ...base, ref: parseImageRef('x@' + d1), localRepoDigests: [], remote: ok(d1) }).state,
    ).toBe('pinned_digest');
    const u = classify({
      ...base,
      localRepoDigests: [`127.0.0.1:5055/qmtest-app@${d1}`],
      remote: {
        digest: null,
        source: 'registry',
        checkedAt: 0,
        error: { kind: 'network', message: 'timeout' },
      },
    });
    expect(u).toMatchObject({ state: 'unknown', reason: 'timeout' });
  });
});

describe('registry client (mocked HTTP)', () => {
  const D = 'sha256:' + 'a'.repeat(64);
  const resp = (status: number, headers: Record<string, string> = {}, body = '') =>
    new Response(body, { status, headers });
  const ref = parseImageRef('registry.example.org/team/app:1') as NonNullable<
    ReturnType<typeof parseImageRef>
  >;
  const opts = { sleep: async () => undefined, jitterMs: () => 0, minIntervalMs: 0 };

  it('parses Bearer challenges', () => {
    expect(
      parseChallenge('Bearer realm="https://a/token",service="s",scope="repository:x:pull"')?.params,
    ).toMatchObject({ realm: 'https://a/token', service: 's' });
  });
  it('HEAD with token auth and the manifest Accept types', async () => {
    const calls: { url: string; method: string; accept?: string; auth?: string }[] = [];
    const fetchMock = (async (url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      calls.push({ url, method: String(init.method), accept: h['Accept'], auth: h['Authorization'] });
      if (url.includes('/token')) return resp(200, {}, JSON.stringify({ token: 'T', expires_in: 300 }));
      if (!h['Authorization'])
        return resp(401, {
          'www-authenticate': 'Bearer realm="https://registry.example.org/token",service="reg"',
        });
      return resp(200, { 'docker-content-digest': D });
    }) as unknown as typeof fetch;
    const c = new RegistryClient({ ...opts, fetch: fetchMock });
    expect((await c.headManifest(ref)).digest).toBe(D);
    expect(calls.find((x) => x.method === 'HEAD')?.accept).toMatch(
      /oci\.image\.index.*manifest\.list.*oci\.image\.manifest.*manifest\.v2/,
    );
    expect(calls.at(-1)?.auth).toBe('Bearer T');
    await c.headManifest(ref); // token cached: no second token request
    expect(calls.filter((x) => x.url.includes('/token'))).toHaveLength(1);
  });
  it('never sends credentials to a foreign token realm (RT-20)', async () => {
    const seen: string[] = [];
    const fetchMock = (async (url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>)['Authorization'] ?? ''}`);
      return resp(401, { 'www-authenticate': 'Bearer realm="https://evil.example.net/token"' });
    }) as unknown as typeof fetch;
    const c = new RegistryClient({
      ...opts,
      fetch: fetchMock,
      credentials: () => ({ username: 'u', password: 'p' }),
    });
    await expect(c.headManifest(ref)).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(seen.some((s) => s.includes('evil.example.net'))).toBe(false);
  });
  it('backs off on HTTP 429 (Retry-After) and then fails fast without hammering', async () => {
    let n = 0;
    const slept: number[] = [];
    const fetchMock = (async () => (n++, resp(429, { 'retry-after': '2' }))) as unknown as typeof fetch;
    let now = 1_000_000;
    const c = new RegistryClient({
      ...opts,
      fetch: fetchMock,
      maxRetries: 1,
      now: () => now,
      sleep: async (ms) => void slept.push(ms),
    });
    await expect(c.headManifest(ref)).rejects.toBeInstanceOf(RegistryError);
    expect(n).toBe(2); // one retry
    expect(slept).toContain(2000);
    const before = n;
    await expect(c.headManifest(ref)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(n).toBe(before); // backed off: no request at all
    now += 3000;
    await expect(c.headManifest(ref)).rejects.toBeInstanceOf(RegistryError);
    expect(n).toBeGreaterThan(before);
  });
  it('http is only used for loopback / configured hosts', async () => {
    const urls: string[] = [];
    const fetchMock = (async (url: string) => (
      urls.push(url),
      resp(200, { 'docker-content-digest': D })
    )) as unknown as typeof fetch;
    const c = new RegistryClient({ ...opts, fetch: fetchMock });
    await c.headManifest(parseImageRef('127.0.0.1:5055/x:1') as never);
    await c.headManifest(ref);
    expect(urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:5055/);
    expect(urls[1]).toMatch(/^https:\/\/registry\.example\.org/);
  });
});
