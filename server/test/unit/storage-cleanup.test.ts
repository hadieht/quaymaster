import { describe, expect, it } from 'vitest';
import type { AuditService } from '../../src/audit/audit.js';
import { StorageCleanupService, type ComposeOwnership } from '../../src/docker/storage-cleanup.js';
import { Guard, NO_SELF, permitStore, type MutationPermit } from '../../src/security/guard.js';
import type { AppError } from '../../src/util/errors.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- fakes implement only what the service touches */

const HEX1 = 'a'.repeat(64);
const HEX2 = 'b'.repeat(64);
const HEX3 = 'c'.repeat(64);
const NET_ID = (n: string): string => n.repeat(64);
const CREATED = '2026-01-01T00:00:00Z';
const ACTOR = { name: 'admin', ip: '127.0.0.1' };

interface FakeVol {
  Name: string;
  CreatedAt?: string;
  Labels?: Record<string, string> | null;
}
interface FakeNet {
  Id: string;
  Name: string;
  Created?: string;
  Labels?: Record<string, string>;
  Containers?: Record<string, unknown>;
}
interface FakeCont {
  Id: string;
  Names: string[];
  Mounts?: { Name?: string }[];
  NetworkSettings?: { Networks: Record<string, { NetworkID: string }> };
}

function setup(
  opts: {
    scope?: string[];
    visibleScope?: string[];
    readOnly?: boolean;
    selfVolumes?: string[];
    selfNetworks?: string[];
    own?: Partial<ComposeOwnership>;
    now?: { t: number };
  } = {},
) {
  const volumes: FakeVol[] = [];
  const networks: FakeNet[] = [];
  const containers: FakeCont[] = [];
  const removed: { what: string; name: string; permit: MutationPermit | undefined }[] = [];
  const audit: any[] = [];
  const clock = opts.now ?? { t: Date.parse('2026-06-01T00:00:00Z') };
  const docker: any = {
    listVolumes: async () => ({ Volumes: volumes.map((v) => ({ ...v })) }),
    listNetworks: async () => networks.map((n) => ({ ...n })),
    listContainers: async (o: { filters?: { volume?: string[]; network?: string[] } } = {}) => {
      let list = containers;
      if (o.filters?.volume)
        list = list.filter((c) => (c.Mounts ?? []).some((m) => m.Name === o.filters!.volume![0]));
      if (o.filters?.network)
        list = list.filter((c) =>
          Object.values(c.NetworkSettings?.Networks ?? {}).some(
            (n) => n.NetworkID === o.filters!.network![0],
          ),
        );
      return list;
    },
    getVolume: (name: string) => ({
      inspect: async () => {
        const v = volumes.find((x) => x.Name === name);
        if (!v) throw Object.assign(new Error('no such volume'), { statusCode: 404 });
        return { ...v };
      },
      remove: async () => {
        removed.push({ what: 'volume', name, permit: permitStore.getStore() });
        volumes.splice(
          volumes.findIndex((x) => x.Name === name),
          1,
        );
      },
    }),
    getNetwork: (ref: string) => ({
      inspect: async () => {
        const n = networks.find((x) => x.Id === ref || x.Name === ref);
        if (!n) throw Object.assign(new Error('no such network'), { statusCode: 404 });
        return { ...n };
      },
      remove: async () => {
        removed.push({ what: 'network', name: ref, permit: permitStore.getStore() });
        networks.splice(
          networks.findIndex((x) => x.Id === ref),
          1,
        );
      },
    }),
  };
  const guard = new Guard({
    readOnly: opts.readOnly ?? false,
    scope: opts.scope ?? [],
    visibleScope: opts.visibleScope ?? [],
    protectedNames: [],
    self: { ...NO_SELF, volumes: opts.selfVolumes ?? [], networks: opts.selfNetworks ?? [] },
  });
  const svc = new StorageCleanupService({
    docker,
    guard,
    audit: { record: (e: unknown) => audit.push(e) } as unknown as AuditService,
    usage: {
      measure: async () => ({
        volumes: Object.fromEntries(volumes.map((v) => [v.Name, 1000])),
        images: {},
        layersSize: 5000,
        volumesSize: volumes.length * 1000,
      }),
    },
    freeBytes: async () => 1_000_000,
    composeOwnership: async () => ({
      ok: true,
      projects: new Set(),
      volumes: new Map(),
      networks: new Map(),
      ...opts.own,
    }),
    minAgeMs: 0,
    now: () => clock.t,
  });
  return { svc, volumes, networks, containers, removed, audit, clock, docker };
}

const names = (c: { name: string }[]): string[] => c.map((x) => x.name).sort();
const rejects = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a rejection');
};

describe('storage cleanup: volume eligibility matrix', () => {
  it('only offers unused volumes of the chosen category; anonymous vs named is never confused', async () => {
    const t = setup();
    t.volumes.push(
      { Name: HEX1, CreatedAt: CREATED },
      { Name: HEX2, CreatedAt: CREATED }, // used by a stopped container
      { Name: 'pgdata', CreatedAt: CREATED },
      { Name: 'labelled-hex', CreatedAt: CREATED, Labels: { 'com.docker.compose.project': 'gone' } },
    );
    t.containers.push({ Id: 'x'.repeat(64), Names: ['/stopped'], Mounts: [{ Name: HEX2 }] });

    const anon = await t.svc.preview({ categories: ['anonymous_volumes'], minAgeHours: 0 }, ACTOR);
    expect(names(anon.candidates)).toEqual([HEX1]);
    expect(anon.candidates[0]?.anonymous).toBe(true);
    expect(anon.protected.find((p) => p.name === HEX2)?.reason).toMatch(/stopped container counts/);
    expect(anon.confirmPhrase).toBe('delete 1 volume');
    expect(anon.deletesData).toBe(true);
    expect(anon.estimatedBytes).toBe(1000);

    const named = await t.svc.preview({ categories: ['named_volumes'], minAgeHours: 0 }, ACTOR);
    expect(names(named.candidates)).toEqual(['pgdata']);
    expect(named.candidates.every((c) => !c.anonymous)).toBe(true);
    expect(named.confirmPhrase).toBe('delete 1 volume');
    // a hash-named volume WITH a Compose label is a named (Compose) volume, never "anonymous"
    expect(named.protected.find((p) => p.name === 'labelled-hex')?.reason).toMatch(/cannot find/);
    const opt = await t.svc.preview(
      { categories: ['named_volumes'], includeComposeProjectVolumes: true, minAgeHours: 0 },
      ACTOR,
    );
    expect(names(opt.candidates)).toEqual(['labelled-hex', 'pgdata']);
    expect(opt.candidates.every((c) => !c.anonymous)).toBe(true);
  });

  it('requires at least one category (volumes are never on by default)', async () => {
    const t = setup();
    const e = await rejects(t.svc.preview({ categories: [] }, ACTOR));
    expect(e.code).toBe('validation');
  });

  it('keeps volumes of a Compose project that still exists unless explicitly opted in', async () => {
    const own = {
      projects: new Set(['shop']),
      volumes: new Map([['shop_db', 'shop']]),
    };
    const t = setup({ own });
    t.volumes.push(
      { Name: 'shop_db', CreatedAt: CREATED, Labels: { 'com.docker.compose.project': 'shop' } },
      { Name: 'old_vol', CreatedAt: CREATED, Labels: { 'com.docker.compose.project': 'deleted-project' } },
      { Name: 'declared_unlabelled', CreatedAt: CREATED },
    );
    own.volumes.set('declared_unlabelled', 'shop');
    const p = await t.svc.preview({ categories: ['named_volumes'], minAgeHours: 0 }, ACTOR);
    // RT3-01: an undiscovered project is not proof that it was deleted from disk: it needs the opt-in too
    expect(names(p.candidates)).toEqual([]);
    expect(p.protected.map((x) => x.name).sort()).toEqual(['declared_unlabelled', 'old_vol', 'shop_db']);
    expect(p.protected.find((x) => x.name === 'old_vol')?.reason).toMatch(
      /Quaymaster cannot find.*may still exist on disk/,
    );
    const opt = await t.svc.preview(
      { categories: ['named_volumes'], includeComposeProjectVolumes: true, minAgeHours: 0 },
      ACTOR,
    );
    expect(names(opt.candidates)).toEqual(['declared_unlabelled', 'old_vol', 'shop_db']);
    expect(opt.candidates.find((c) => c.name === 'old_vol')?.lastKnownUser).toBe(
      'Compose project deleted-project',
    );
  });

  it('RT3-01: single removal of a volume of an undiscovered Compose project needs the acknowledgement', async () => {
    const t = setup();
    t.volumes.push({
      Name: 'ghost_db',
      CreatedAt: CREATED,
      Labels: { 'com.docker.compose.project': 'ghost' },
    });
    const e = await rejects(t.svc.removeVolume('ghost_db', { confirm: 'ghost_db' }, ACTOR));
    expect(e.code).toBe('conflict');
    expect((e.details as { requires?: string }).requires).toBe('acknowledgeComposeProject');
    expect(t.removed).toEqual([]);
    const ok = await t.svc.removeVolume(
      'ghost_db',
      { confirm: 'ghost_db', acknowledgeComposeProject: true },
      ACTOR,
    );
    expect(ok.action).toBe('deleted');
  });

  it('RT3-02: volumes and networks outside QM_VISIBLE_SCOPE are neither listed nor removable', async () => {
    const t = setup({ visibleScope: ['app-*'] });
    t.volumes.push(
      { Name: 'app-data', CreatedAt: CREATED },
      { Name: 'secret-db', CreatedAt: CREATED },
      { Name: 'x_db', CreatedAt: CREATED, Labels: { 'com.docker.compose.project': 'app-x' } },
    );
    t.networks.push({ Id: NET_ID('e'), Name: 'secret-net', Created: CREATED });
    const p = await t.svc.preview(
      {
        categories: ['named_volumes', 'unused_networks'],
        includeComposeProjectVolumes: true,
        minAgeHours: 0,
      },
      ACTOR,
    );
    const seen = [...p.candidates, ...p.protected].map((x) => x.name).sort();
    expect(seen).toEqual(['app-data', 'x_db']);
    expect((await rejects(t.svc.removeVolume('secret-db', { confirm: 'secret-db' }, ACTOR))).code).toBe(
      'not_found',
    );
    expect((await rejects(t.svc.removeNetwork(NET_ID('e'), { confirm: 'secret-net' }, ACTOR))).code).toBe(
      'not_found',
    );
    expect(t.removed).toEqual([]);
  });

  it('fails closed when Compose discovery failed', async () => {
    const t = setup({ own: { ok: false } });
    t.volumes.push({ Name: 'v', CreatedAt: CREATED, Labels: { 'com.docker.compose.project': 'p' } });
    const p = await t.svc.preview({ categories: ['named_volumes'], minAgeHours: 0 }, ACTOR);
    expect(p.candidates).toHaveLength(0);
    expect(p.protected[0]?.reason).toMatch(/could not be discovered/);
  });

  it("never offers Quaymaster's own volume, out-of-scope volumes, or young volumes", async () => {
    const t = setup({ scope: ['qmtest-*'], selfVolumes: ['qmtest-own'] });
    t.volumes.push(
      { Name: 'qmtest-own', CreatedAt: CREATED },
      { Name: 'qmtest-ok', CreatedAt: CREATED },
      { Name: 'real-data', CreatedAt: CREATED },
      { Name: 'qmtest-new', CreatedAt: new Date(t.clock.t - 3_600_000).toISOString() },
    );
    const p = await t.svc.preview({ categories: ['named_volumes'], minAgeHours: 24 }, ACTOR);
    expect(names(p.candidates)).toEqual(['qmtest-ok']);
    const why = Object.fromEntries(p.protected.map((x) => [x.name, x.reason]));
    expect(why['qmtest-own']).toMatch(/Quaymaster's own container/);
    expect(why['real-data']).toMatch(/outside QM_MANAGED_SCOPE/);
    expect(why['qmtest-new']).toMatch(/minimum age/);
  });
});

describe('storage cleanup: network eligibility matrix', () => {
  it('skips predefined, attached, Compose-defined, own and out-of-scope networks', async () => {
    const t = setup({
      scope: ['qmtest-*', 'bridge', 'host', 'none'],
      selfNetworks: ['qmtest-self'],
      own: {
        projects: new Set(['qmtest-proj']),
        networks: new Map([['qmtest-proj_default', 'qmtest-proj']]),
      },
    });
    t.networks.push(
      { Id: NET_ID('1'), Name: 'bridge', Created: CREATED },
      { Id: NET_ID('2'), Name: 'host', Created: CREATED },
      { Id: NET_ID('3'), Name: 'none', Created: CREATED },
      { Id: NET_ID('4'), Name: 'qmtest-free', Created: CREATED },
      { Id: NET_ID('5'), Name: 'qmtest-attached', Created: CREATED },
      { Id: NET_ID('6'), Name: 'qmtest-stopped-user', Created: CREATED },
      { Id: NET_ID('7'), Name: 'qmtest-proj_default', Created: CREATED },
      { Id: NET_ID('8'), Name: 'qmtest-self', Created: CREATED },
      { Id: NET_ID('9'), Name: 'other-net', Created: CREATED },
    );
    t.containers.push({
      Id: 'a'.repeat(64),
      Names: ['/qmtest-c'],
      NetworkSettings: { Networks: { 'qmtest-attached': { NetworkID: NET_ID('5') } } },
    });
    t.containers.push({
      Id: 'b'.repeat(64),
      Names: ['/qmtest-stopped'],
      NetworkSettings: { Networks: { 'qmtest-stopped-user': { NetworkID: '' } } },
    });
    const p = await t.svc.preview({ categories: ['unused_networks'], minAgeHours: 0 }, ACTOR);
    expect(names(p.candidates)).toEqual(['qmtest-free']);
    expect(p.confirmPhrase).toBeNull();
    expect(p.estimatedBytes).toBe(0);
    const why = Object.fromEntries(p.protected.map((x) => [x.name, x.reason]));
    expect(why['qmtest-attached']).toMatch(/attached/);
    expect(why['qmtest-stopped-user']).toMatch(/attached/);
    expect(why['qmtest-proj_default']).toMatch(/Compose project/);
    expect(why['qmtest-self']).toMatch(/Quaymaster's own/);
    expect(why['other-net']).toMatch(/outside QM_MANAGED_SCOPE/);
    expect(why['bridge']).toBeUndefined(); // the daemon's own networks are not even listed
  });
});

describe('storage cleanup: execute (preview token, confirmation, TOCTOU)', () => {
  const withTwo = () => {
    const t = setup();
    t.volumes.push({ Name: HEX1, CreatedAt: CREATED }, { Name: HEX3, CreatedAt: CREATED });
    return t;
  };

  it('removes exactly the previewed volumes with a permit naming each one, audits each, and reports bytes', async () => {
    const t = withTwo();
    const p = await t.svc.preview({ categories: ['anonymous_volumes'], minAgeHours: 0 }, ACTOR);
    const r = await t.svc.execute(p.previewId, 'delete 2 volumes', ACTOR);
    expect(r.removed.map((x) => x.name).sort()).toEqual([HEX1, HEX3]);
    expect(r.skipped).toEqual([]);
    expect(t.removed.map((x) => x.permit)).toEqual([
      { kind: 'volume_remove', name: HEX1 },
      { kind: 'volume_remove', name: HEX3 },
    ]);
    expect(r.reclaim.estimatedBytes).toBe(2000);
    expect(r.reclaim.basis).toBe('df');
    const rec = t.audit.filter((a) => a.action === 'volume.remove');
    expect(rec).toHaveLength(2);
    expect(rec[0]).toMatchObject({ actor: 'admin', outcome: 'success', target: HEX1 });
    expect(rec[0].params.bytes).toBe(1000);
  });

  it('a volume that a container started using after the preview is skipped, not removed', async () => {
    const t = withTwo();
    const p = await t.svc.preview({ categories: ['anonymous_volumes'], minAgeHours: 0 }, ACTOR);
    t.containers.push({ Id: 'f'.repeat(64), Names: ['/late'], Mounts: [{ Name: HEX1 }] });
    const r = await t.svc.execute(p.previewId, 'delete 2 volumes', ACTOR);
    expect(r.removed.map((x) => x.name)).toEqual([HEX3]);
    expect(r.skipped[0]).toMatchObject({ name: HEX1 });
    expect(r.skipped[0]?.reason).toMatch(/in use/);
    expect(t.volumes.map((v) => v.Name)).toEqual([HEX1]);
    expect(
      t.audit.some((a) => a.action === 'volume.remove' && a.outcome === 'denied' && a.target === HEX1),
    ).toBe(true);
  });

  it('a volume recreated under the same name since the preview is skipped', async () => {
    const t = withTwo();
    const p = await t.svc.preview({ categories: ['anonymous_volumes'], minAgeHours: 0 }, ACTOR);
    t.volumes[0]!.CreatedAt = '2026-05-31T00:00:00Z';
    const r = await t.svc.execute(p.previewId, 'delete 2 volumes', ACTOR);
    expect(r.skipped.map((s) => s.name)).toEqual([HEX1]);
    expect(r.skipped[0]?.reason).toMatch(/recreated/);
  });

  it('only previewed candidates are removed: a volume created after the preview survives', async () => {
    const t = withTwo();
    const p = await t.svc.preview({ categories: ['anonymous_volumes'], minAgeHours: 0 }, ACTOR);
    t.volumes.push({ Name: HEX2, CreatedAt: CREATED });
    await t.svc.execute(p.previewId, 'delete 2 volumes', ACTOR);
    expect(t.volumes.map((v) => v.Name)).toEqual([HEX2]);
  });

  it('a network that gained a container since the preview is skipped', async () => {
    const t = setup();
    t.networks.push({ Id: NET_ID('4'), Name: 'n1', Created: CREATED });
    const p = await t.svc.preview({ categories: ['unused_networks'], minAgeHours: 0 }, ACTOR);
    t.containers.push({
      Id: 'a'.repeat(64),
      Names: ['/c'],
      NetworkSettings: { Networks: { n1: { NetworkID: NET_ID('4') } } },
    });
    const r = await t.svc.execute(p.previewId, p.previewId, ACTOR);
    expect(r.removed).toEqual([]);
    expect(r.skipped[0]?.reason).toMatch(/attached/);
  });

  it('rejects tampered or missing confirmation, unknown ids, other users and expired previews', async () => {
    const t = withTwo();
    const p = await t.svc.preview({ categories: ['anonymous_volumes'], minAgeHours: 0 }, ACTOR);
    for (const bad of ['', p.previewId, 'delete 1 volume', 'DELETE 2 VOLUMES']) {
      const e = await rejects(t.svc.execute(p.previewId, bad, ACTOR));
      expect(e.code, bad).toBe('confirmation_required');
    }
    expect((await rejects(t.svc.execute(crypto.randomUUID(), 'delete 2 volumes', ACTOR))).code).toBe(
      'conflict',
    );
    expect(
      (await rejects(t.svc.execute(p.previewId, 'delete 2 volumes', { name: 'other', ip: null }))).code,
    ).toBe('forbidden');
    expect(t.removed).toHaveLength(0);
    t.clock.t += 11 * 60_000;
    const e = await rejects(t.svc.execute(p.previewId, 'delete 2 volumes', ACTOR));
    expect(e.code).toBe('conflict');
    expect(e.message).toMatch(/expire/);
    expect(t.removed).toHaveLength(0);
    expect(
      t.audit.filter((a) => a.action === 'storage.cleanup.execute' && a.outcome === 'denied').length,
    ).toBeGreaterThan(3);
  });

  it('a preview can only be executed once', async () => {
    const t = withTwo();
    const p = await t.svc.preview({ categories: ['anonymous_volumes'], minAgeHours: 0 }, ACTOR);
    await t.svc.execute(p.previewId, 'delete 2 volumes', ACTOR);
    expect((await rejects(t.svc.execute(p.previewId, 'delete 2 volumes', ACTOR))).code).toBe('conflict');
  });

  it('read-only mode refuses execute and single removals before anything else', async () => {
    const t = setup({ readOnly: true });
    t.volumes.push({ Name: 'qmtest-v', CreatedAt: CREATED });
    const p = await t.svc.preview({ categories: ['named_volumes'], minAgeHours: 0 }, ACTOR);
    expect((await rejects(t.svc.execute(p.previewId, p.confirmPhrase!, ACTOR))).code).toBe('read_only');
    expect((await rejects(t.svc.removeVolume('qmtest-v', { confirm: 'qmtest-v' }, ACTOR))).code).toBe(
      'read_only',
    );
    expect((await rejects(t.svc.removeNetwork('n', { confirm: 'n' }, ACTOR))).code).toBe('read_only');
    expect(t.removed).toHaveLength(0);
  });
});

describe('storage cleanup: single removal', () => {
  it('a named volume needs its exact name; the Engine call carries a name-bound, unforced permit', async () => {
    const t = setup({ scope: ['qmtest-*'] });
    t.volumes.push({ Name: 'qmtest-v', CreatedAt: CREATED });
    const e = await rejects(t.svc.removeVolume('qmtest-v', { confirm: 'qmtest' }, ACTOR));
    expect(e.code).toBe('confirmation_required');
    expect(t.removed).toHaveLength(0);
    const r = await t.svc.removeVolume('qmtest-v', { confirm: 'qmtest-v' }, ACTOR);
    expect(r).toMatchObject({ kind: 'volume', name: 'qmtest-v', action: 'deleted' });
    expect(t.removed[0]?.permit).toEqual({ kind: 'volume_remove', name: 'qmtest-v' });
    expect(t.audit.at(-1)).toMatchObject({ action: 'volume.remove', outcome: 'success', target: 'qmtest-v' });
  });

  it('refuses out-of-scope, in-use (stopped container) and own volumes server-side', async () => {
    const t = setup({ scope: ['qmtest-*'], selfVolumes: ['qmtest-own'] });
    t.volumes.push(
      { Name: 'real', CreatedAt: CREATED },
      { Name: 'qmtest-used', CreatedAt: CREATED },
      { Name: 'qmtest-own', CreatedAt: CREATED },
    );
    t.containers.push({ Id: 'e'.repeat(64), Names: ['/qmtest-stopped'], Mounts: [{ Name: 'qmtest-used' }] });
    expect((await rejects(t.svc.removeVolume('real', { confirm: 'real' }, ACTOR))).code).toBe('out_of_scope');
    expect((await rejects(t.svc.removeVolume('qmtest-used', { confirm: 'qmtest-used' }, ACTOR))).code).toBe(
      'conflict',
    );
    expect((await rejects(t.svc.removeVolume('qmtest-own', { confirm: 'qmtest-own' }, ACTOR))).code).toBe(
      'self_protected',
    );
    expect(t.removed).toHaveLength(0);
    expect(t.audit.filter((a) => a.outcome === 'denied')).toHaveLength(3);
  });

  it('a Compose project volume needs an explicit acknowledgement', async () => {
    const t = setup({ own: { projects: new Set(['shop']) } });
    t.volumes.push({ Name: 'shop_db', CreatedAt: CREATED, Labels: { 'com.docker.compose.project': 'shop' } });
    const e = await rejects(t.svc.removeVolume('shop_db', { confirm: 'shop_db' }, ACTOR));
    expect(e.code).toBe('conflict');
    expect((e.details as { requires?: string }).requires).toBe('acknowledgeComposeProject');
    await t.svc.removeVolume('shop_db', { confirm: 'shop_db', acknowledgeComposeProject: true }, ACTOR);
    expect(t.removed).toHaveLength(1);
  });

  it('rejects unsafe names before touching Docker', async () => {
    const t = setup();
    for (const bad of ['-rf', '../x', 'a b', '']) {
      expect((await rejects(t.svc.removeVolume(bad, { confirm: bad }, ACTOR))).code).toBe('validation');
    }
  });

  it('removes a free network by full ID, refuses an attached one', async () => {
    const t = setup({ scope: ['qmtest-*'] });
    t.networks.push(
      { Id: NET_ID('1'), Name: 'qmtest-free', Created: CREATED },
      { Id: NET_ID('2'), Name: 'qmtest-busy', Created: CREATED, Containers: { x: {} } },
    );
    const e = await rejects(t.svc.removeNetwork('qmtest-busy', { confirm: 'qmtest-busy' }, ACTOR));
    expect(e.code).toBe('conflict');
    const r = await t.svc.removeNetwork('qmtest-free', { confirm: 'qmtest-free' }, ACTOR);
    expect(r.reclaim.reclaimedBytes).toBe(0);
    expect(t.removed[0]?.permit).toEqual({ kind: 'network_remove', id: NET_ID('1') });
  });
});
