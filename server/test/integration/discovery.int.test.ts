import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fixtures, startApp, type TestApp } from '../helpers/app.js';

/** Snapshot of the whole daemon (ids, names, states) used to prove read-only discovery mutates nothing. */
function daemonSnapshot(): string {
  return execFileSync(
    'docker',
    ['ps', '-a', '--no-trunc', '--format', '{{.ID}} {{.Names}} {{.State}} {{.Image}}'],
    {
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter((l) => !l.includes('qmtest-')) // the fixtures may legitimately change; everything else must not
    .sort()
    .join('\n');
}

describe('discovery and read endpoints (real daemon, fixtures + read-only look at the real host)', () => {
  let t: TestApp;
  let before: string;

  beforeAll(async () => {
    before = daemonSnapshot();
    fixtures('up', 'multi', 'single', 'secrets', 'standalone');
    t = await startApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('negotiates the API version and reports health', async () => {
    const r = await t.call('GET', '/api/v1/system/health', undefined, t.admin);
    expect(r.status).toBe(200);
    expect(r.body.docker).toBe('ok');
    expect(r.body.apiVersion).toMatch(/^1\.\d+$/);
    expect(r.body.composeVersion).toMatch(/^\d+\.\d+/);
  });

  it('classifies fixture projects as full and lists services with status', async () => {
    const r = await t.call('GET', '/api/v1/compose/projects', undefined, t.admin);
    expect(r.status).toBe(200);
    const byName = Object.fromEntries(r.body.map((p: { name: string }) => [p.name, p]));
    const multi = byName['qmtest-multi'];
    expect(multi.level).toBe('full');
    expect(multi.reasons).toEqual([]);
    expect(multi.services.map((s: { name: string }) => s.name)).toEqual(['app', 'db', 'worker']);
    expect(multi.status).toBe('running');
    expect(byName['qmtest-single'].level).toBe('full');
    expect(byName['qmtest-single'].services[0].image).toContain('alpine');
  });

  it('builds the dependency graph with healthcheck conditions', async () => {
    const r = await t.call('GET', '/api/v1/compose/projects/qmtest-multi/graph', undefined, t.admin);
    expect(r.status).toBe(200);
    expect(r.body.graph.order).toEqual(['db', 'app', 'worker']);
    expect(r.body.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'app', to: 'db', kind: 'depends_on', condition: 'service_healthy' }),
        expect.objectContaining({
          from: 'worker',
          to: 'app',
          kind: 'depends_on',
          condition: 'service_started',
        }),
      ]),
    );
  });

  it('validates a project and serves a redacted config view', async () => {
    const v = await t.call('GET', '/api/v1/compose/projects/qmtest-multi/validate', undefined, t.admin);
    expect(v.body).toEqual({ valid: true, errors: [], warnings: [] });
    const c = await t.call('GET', '/api/v1/compose/projects/qmtest-multi/config', undefined, t.admin);
    expect(c.status).toBe(200);
    expect(c.body.config.services.db.image).toBe('alpine:latest');
  });

  it('marks real, non-Compose containers as standalone and fixtures as mutable', async () => {
    const r = await t.call('GET', '/api/v1/containers', undefined, t.admin);
    expect(r.status).toBe(200);
    const standalone = r.body.find((c: { name: string }) => c.name === 'qmtest-standalone');
    expect(standalone.capability).toBe('standalone');
    expect(standalone.mutable).toBe(true);
    const solo = r.body.find((c: { name: string }) => c.name === 'qmtest-single-solo-1');
    expect(solo.capability).toBe('full');
    expect(solo.composeProject).toBe('qmtest-single');
  });

  it('read-only discovery of the real environment: other projects are limited, nothing is mutable, nothing changed', async () => {
    const projects = (await t.call('GET', '/api/v1/compose/projects', undefined, t.admin)).body as {
      name: string;
      level: string;
      mutable: boolean;
      reasons: string[];
    }[];
    const real = projects.filter((p) => !p.name.startsWith('qmtest-'));
    // The reference host has several real projects; on other machines this may be empty.
    for (const p of real) {
      expect(p.level).toBe('limited');
      expect(p.mutable).toBe(false);
      expect(p.reasons.join(' ')).toMatch(
        /outside (QM_STACK_PATHS|the allowed stack paths)|labels|does not exist/,
      );
    }
    const containers = (await t.call('GET', '/api/v1/containers', undefined, t.admin)).body as {
      name: string;
      mutable: boolean;
    }[];
    for (const c of containers.filter((x) => !x.name.startsWith('qmtest-'))) expect(c.mutable).toBe(false);
    // full inspect of a real container is allowed (read) and redacted
    const anyReal = containers.find((c) => !c.name.startsWith('qmtest-'));
    if (anyReal) {
      const i = await t.call('GET', `/api/v1/containers/${anyReal.name}`, undefined, t.admin);
      expect(i.status).toBe(200);
      expect(JSON.stringify(i.body)).not.toMatch(/"Env":\[[^\]]*(PASSWORD|SECRET|TOKEN)=[^•]/i);
    }
    expect(daemonSnapshot()).toBe(before);
  });

  it('serves images, volumes, networks, host metrics, df and docker info', async () => {
    const images = (await t.call('GET', '/api/v1/images', undefined, t.admin)).body as {
      tags: string[];
      inUse: boolean;
      containers: unknown[];
    }[];
    const alpine = images.find((i) => i.tags.includes('alpine:latest'));
    expect(alpine?.inUse).toBe(true);
    expect(alpine?.containers.length).toBeGreaterThanOrEqual(6);
    const vols = (await t.call('GET', '/api/v1/volumes', undefined, t.admin)).body as {
      name: string;
      usedBy: string[];
      composeProject: string | null;
    }[];
    expect(vols.find((v) => v.name === 'qmtest-multi_dbdata')?.usedBy).toEqual(['qmtest-multi-db-1']);
    const nets = (await t.call('GET', '/api/v1/networks', undefined, t.admin)).body as {
      name: string;
      containers: string[];
    }[];
    expect(nets.find((n) => n.name === 'qmtest-multi_default')?.containers).toHaveLength(3);
    const host = (await t.call('GET', '/api/v1/system/host', undefined, t.admin)).body;
    expect(host.memTotal).toBeGreaterThan(0);
    expect(host.dockerRoot.free).toBeGreaterThan(0);
    const df = await t.call('GET', '/api/v1/system/df', undefined, t.admin);
    expect(df.status, df.raw).toBe(200);
    const info = await t.call('GET', '/api/v1/system/info', undefined, t.admin);
    expect(info.body.ServerVersion).toBeTruthy();
  });

  it('GET routes have no side effects (RT-18): audit log and operations are unchanged', async () => {
    const auditBefore = (await t.call('GET', '/api/v1/audit?limit=500', undefined, t.admin)).body.entries
      .length;
    const gets = [
      '/api/v1/containers',
      '/api/v1/compose/projects',
      '/api/v1/compose/projects/qmtest-multi',
      '/api/v1/compose/projects/qmtest-multi/graph',
      '/api/v1/compose/projects/qmtest-multi/config',
      '/api/v1/compose/projects/qmtest-multi/validate',
      '/api/v1/images',
      '/api/v1/volumes',
      '/api/v1/networks',
      '/api/v1/events',
      '/api/v1/operations',
      '/api/v1/system/mode',
      '/api/v1/system/health',
      '/api/v1/system/host',
    ];
    for (const g of gets) expect((await t.call('GET', g, undefined, t.admin)).status).toBe(200);
    const auditAfter = (await t.call('GET', '/api/v1/audit?limit=500', undefined, t.admin)).body.entries
      .length;
    expect(auditAfter).toBe(auditBefore);
    expect((await t.call('GET', '/api/v1/operations', undefined, t.admin)).body.operations).toHaveLength(0);
  });
});
