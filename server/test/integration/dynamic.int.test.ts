import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ADMIN,
  fixtures,
  STACKS_DIR,
  startApp,
  waitFor,
  waitOperation,
  type TestApp,
} from '../helpers/app.js';

/**
 * Dynamic discovery, the read-only file helper and "stop monitoring", against the real daemon.
 * SAFETY: only qmtest-* resources labelled quaymaster.test=true are created, changed or removed. Quaymaster instances run
 * with QM_MANAGED_SCOPE=qmtest-* (testConfig), so real projects on the host are listed but never read or acted on.
 */

const DYN_DIR = path.join(STACKS_DIR, 'qmtest-dynamic');
const SECRET_VALUE = 'fx-dyn-secret-7421';
const docker = (...args: string[]): string => execFileSync('docker', args, { encoding: 'utf8' }).trim();

/** A local image that contains Node.js and may be used as the helper image; null when there is none. */
function helperImage(): string | null {
  const fromEnv = process.env['QM_TEST_HELPER_IMAGE'];
  if (fromEnv) return fromEnv;
  const imgs = docker('images', '--format', '{{.Repository}}:{{.Tag}}').split('\n');
  return imgs.find((i) => /(^|\/)quaymaster:/.test(i)) ?? imgs.find((i) => /(^|\/)node:/.test(i)) ?? null;
}

/** alpine when it is cached locally (the shared fixtures use it); otherwise any local image with a `sleep`. Never pulled. */
function baseImage(): string {
  try {
    docker('image', 'inspect', 'alpine:latest');
    return 'alpine:latest';
  } catch {
    const img = helperImage();
    if (!img) throw new Error('no local image available for the fixtures');
    return img;
  }
}

const STANDALONE = 'qmtest-dyn-standalone';
const startedAt = (name: string): string =>
  docker('inspect', '--format', '{{.State.StartedAt}} {{.Id}}', name);
const helperContainers = (): string[] =>
  docker('ps', '-a', '--filter', 'label=quaymaster.helper=true', '--format', '{{.Names}}')
    .split('\n')
    .filter(Boolean);

describe('dynamic discovery, read-only helper and stop-monitoring (real daemon)', () => {
  const image = helperImage();
  let a: TestApp; // no QM_STACK_PATHS at all
  let before: string;

  beforeAll(async () => {
    writeFileSync(
      path.join(DYN_DIR, '.env'),
      `DYN_PASSWORD=${SECRET_VALUE}\nPLAIN_SETTING=visible-key-only\n`,
    );
    process.env['QM_TEST_IMAGE'] = baseImage();
    fixtures('up', 'dynamic');
    docker(
      'run',
      '-d',
      '--name',
      STANDALONE,
      '--label',
      'quaymaster.test=true',
      '--pull',
      'never',
      baseImage(),
      'sleep',
      '3600',
    );
    before = startedAt('qmtest-dynamic-app-1');
    a = await startApp({
      QM_STACK_PATHS: '',
      QM_HELPER_LABELS: 'quaymaster.test=true',
      ...(image ? { QM_HELPER_IMAGE: image } : {}),
    });
  });
  afterAll(async () => {
    await a?.close();
    try {
      fixtures('down');
    } finally {
      try {
        docker('rm', '-f', STANDALONE);
      } catch {
        /* already gone */
      }
      rmSync(path.join(DYN_DIR, '.env'), { force: true });
    }
  });

  const project = async (t: TestApp = a) =>
    (await t.call('GET', '/api/v1/compose/projects', undefined, t.admin)).body.find(
      (p: { name: string }) => p.name === 'qmtest-dynamic',
    );

  it('lists a project with zero configuration and explains exactly why files are not used', async () => {
    const p = await project();
    expect(p).toBeTruthy();
    expect(p.status).toBe('running');
    expect(p.level).toBe('limited');
    expect(p.reasonDetails).toHaveLength(1);
    expect(p.reasonDetails[0].code).toBe('path_not_allowed');
    expect(p.reasonDetails[0].hint).toContain(`- ${DYN_DIR}:${DYN_DIR}`);
    expect(p.mountHint).toEqual({
      path: DYN_DIR,
      volume: `- ${DYN_DIR}:${DYN_DIR}`,
      stackPaths: `QM_STACK_PATHS=${DYN_DIR}`,
    });
    expect(p.fileAccess).toBe(image ? 'helper' : 'none');
    expect(p.services.map((s: { name: string }) => s.name)).toEqual(['app']);
  });

  it('still lets the administrator restart, but refuses file operations with the reasons', async () => {
    const r = await a.call('POST', '/api/v1/compose/projects/qmtest-dynamic/actions/redeploy', {}, a.admin);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('limited_capability');
    expect(r.body.error.details.reasonDetails[0].code).toBe('path_not_allowed');
    expect(r.body.error.details.mountHint.volume).toBe(`- ${DYN_DIR}:${DYN_DIR}`);
    const ok = await a.call('POST', '/api/v1/compose/projects/qmtest-dynamic/actions/restart', {}, a.admin);
    expect(ok.status).toBe(202);
    expect((await waitOperation(a, ok.body.operationId)).status).toBe('succeeded');
    before = startedAt('qmtest-dynamic-app-1'); // a restart changes StartedAt; the ignore test compares from here
  });

  it.skipIf(!image)(
    'shows the configuration of an unmounted project through the read-only helper',
    async () => {
      const r = await a.call('GET', '/api/v1/compose/projects/qmtest-dynamic/config', undefined, a.admin);
      expect(r.status, r.raw).toBe(200);
      expect(r.body.source).toBe('files');
      expect(r.body.files).toEqual(expect.arrayContaining(['compose.yaml', '.env']));
      expect(r.body.config['compose.yaml'].services.app.image).toBe('${QM_TEST_IMAGE:-alpine:latest}'); // exactly as written: not interpolated
      // .env: KEYS only; values never leave the server
      expect(r.body.envKeys).toEqual(['DYN_PASSWORD', 'PLAIN_SETTING']);
      expect(r.raw).not.toContain(SECRET_VALUE);
      expect(r.raw).not.toContain('visible-key-only');
      // the helper is gone again, and the project is untouched
      await waitFor(() => helperContainers().length === 0, 'helper removal', 10_000);
      expect(docker('inspect', '--format', '{{.State.Status}}', 'qmtest-dynamic-app-1')).toBe('running');
    },
  );

  it.skipIf(!image)('never reads or helps projects outside QM_MANAGED_SCOPE', async () => {
    const all = (await a.call('GET', '/api/v1/compose/projects', undefined, a.admin)).body as {
      name: string;
      fileAccess: string;
      mutable: boolean;
    }[];
    for (const p of all.filter((x) => !x.name.startsWith('qmtest-'))) {
      expect(p.fileAccess).toBe('none');
      expect(p.mutable).toBe(false);
      const c = await a.call('GET', `/api/v1/compose/projects/${p.name}/config`, undefined, a.admin);
      expect(c.status).toBe(409);
    }
    expect(helperContainers().filter((n) => !n.startsWith('qmtest-'))).toEqual([]);
  });

  it('read-only mode cannot create a helper', async () => {
    const ro = await startApp({
      QM_STACK_PATHS: '',
      QM_READ_ONLY: 'true',
      ...(image ? { QM_HELPER_IMAGE: image } : {}),
    });
    try {
      const p = await project(ro);
      expect(p.fileAccess).toBe('none');
      const r = await ro.call('GET', '/api/v1/compose/projects/qmtest-dynamic/config', undefined, ro.admin);
      expect(r.status).toBe(409);
      expect(helperContainers()).toEqual([]);
    } finally {
      await ro.close();
    }
  });

  it('a stack path (or a same-path mount) still makes the project fully manageable (back-compat)', async () => {
    const b = await startApp({ QM_STACK_PATHS: STACKS_DIR });
    try {
      const p = await project(b);
      expect(p).toMatchObject({ level: 'full', fileAccess: 'local', reasons: [], mountHint: null });
      const cfg = await b.call('GET', '/api/v1/compose/projects/qmtest-dynamic/config', undefined, b.admin);
      expect(cfg.body.source).toBe('compose');
      expect(JSON.stringify(cfg.body)).not.toContain(SECRET_VALUE);
    } finally {
      await b.close();
    }
  });

  describe('stop monitoring', () => {
    const del = (id: number) => a.call('DELETE', `/api/v1/ignored/${id}`, undefined, a.admin);
    let entryId = 0;

    it('needs an administrator and the typed name; viewers and mismatches are refused', async () => {
      await a.ctx.auth.createUser({ username: 'viewer1', password: 'viewer-test-password', role: 'viewer' });
      const viewer = await a.login('viewer1', 'viewer-test-password');
      const body = { kind: 'project', name: 'qmtest-dynamic', confirm: 'qmtest-dynamic' };
      expect((await a.call('POST', '/api/v1/ignored', body, viewer)).status).toBe(403);
      const wrong = await a.call('POST', '/api/v1/ignored', { ...body, confirm: 'nope' }, a.admin);
      expect(wrong.status).toBe(409);
      expect(wrong.body.error.code).toBe('confirmation_required');
      expect((await a.call('GET', '/api/v1/ignored', undefined, a.admin)).body.entries).toEqual([]);
      expect((await a.call('POST', '/api/v1/ignored', { ...body, extra: 1 }, a.admin)).status).toBe(400);
      const missing = { kind: 'project', name: 'does-not-exist', confirm: 'does-not-exist' };
      expect((await a.call('POST', '/api/v1/ignored', missing, a.admin)).status).toBe(404);
      expect((await a.call('DELETE', '/api/v1/ignored/1', undefined, viewer)).status).toBe(403);
    });

    it('hides the project everywhere, refuses every action, and touches nothing', async () => {
      const r = await a.call(
        'POST',
        '/api/v1/ignored',
        { kind: 'project', name: 'qmtest-dynamic', confirm: 'qmtest-dynamic' },
        a.admin,
      );
      expect(r.status, r.raw).toBe(201);
      entryId = r.body.id;
      expect(r.body).toMatchObject({
        kind: 'project',
        name: 'qmtest-dynamic',
        workingDir: DYN_DIR,
        ignoredBy: ADMIN.username,
      });

      // lists
      expect(await project()).toBeUndefined();
      const names = (
        (await a.call('GET', '/api/v1/containers', undefined, a.admin)).body as { name: string }[]
      ).map((c) => c.name);
      expect(names.filter((n) => n.startsWith('qmtest-dynamic'))).toEqual([]);
      // detail, graph, config, validate
      for (const sub of ['', '/graph', '/config', '/validate']) {
        const x = await a.call('GET', `/api/v1/compose/projects/qmtest-dynamic${sub}`, undefined, a.admin);
        expect(x.status, sub).toBe(409);
        expect(x.body.error.code).toBe('ignored');
      }
      // project actions and container-level access
      for (const act of ['up', 'stop', 'start', 'restart', 'redeploy', 'down']) {
        const x = await a.call(
          'POST',
          `/api/v1/compose/projects/qmtest-dynamic/actions/${act}`,
          { confirm: 'qmtest-dynamic' },
          a.admin,
        );
        expect(x.status, act).toBe(409);
        expect(x.body.error.code).toBe('ignored');
      }
      const insp = await a.call('GET', '/api/v1/containers/qmtest-dynamic-app-1', undefined, a.admin);
      expect(insp.status).toBe(409);
      expect(insp.body.error.code).toBe('ignored');
      const act = await a.call(
        'POST',
        '/api/v1/containers/qmtest-dynamic-app-1/actions/restart',
        {},
        a.admin,
      );
      expect(act.status).toBe(409);
      expect(act.body.error.code).toBe('ignored');
      // update checks and maintenance planning do not see it either
      const upd = await a.call('GET', '/api/v1/updates', undefined, a.admin);
      expect(JSON.stringify(upd.body)).not.toContain('qmtest-dynamic');
      const plan = await a.call('POST', '/api/v1/maintenance/plan', { project: 'qmtest-dynamic' }, a.admin);
      expect(plan.status).toBe(409);
      expect(plan.body.error.code).toBe('ignored');

      // the safety computations still know it exists: its volumes, networks and images stay protected
      expect((await a.ctx.compose.discoverAll(true)).some((p) => p.name === 'qmtest-dynamic')).toBe(true);

      // nothing was touched: same container, same start time, still running; network still there
      expect(startedAt('qmtest-dynamic-app-1')).toBe(before);
      expect(docker('inspect', '--format', '{{.State.Status}}', 'qmtest-dynamic-app-1')).toBe('running');
      expect(
        docker('network', 'ls', '--filter', 'name=qmtest-dynamic_default', '--format', '{{.Name}}'),
      ).toBe('qmtest-dynamic_default');

      // audit trail
      const audit = (await a.call('GET', '/api/v1/audit?limit=100', undefined, a.admin)).body.entries as {
        action: string;
        outcome: string;
        params: string | null;
      }[];
      const rec = audit.find((e) => e.action === 'monitoring.stop' && e.outcome === 'success');
      expect(JSON.stringify(rec)).toContain('dockerResourcesTouched');
      expect(audit.some((e) => e.action === 'monitoring.stop' && e.outcome === 'denied')).toBe(true);
    });

    it('is listed, survives a restart of Quaymaster, and can be restored', async () => {
      const list = (await a.call('GET', '/api/v1/ignored', undefined, a.admin)).body.entries as {
        id: number;
        name: string;
      }[];
      expect(list.map((e) => e.name)).toEqual(['qmtest-dynamic']);

      const dataDir = a.config.dataDir;
      await a.close();
      a = await startApp({
        QM_STACK_PATHS: '',
        QM_DATA_DIR: dataDir,
        QM_HELPER_LABELS: 'quaymaster.test=true',
        ...(image ? { QM_HELPER_IMAGE: image } : {}),
      });
      expect(await project()).toBeUndefined();

      expect((await del(entryId)).status).toBe(200);
      expect((await del(entryId)).status).toBe(404);
      expect((await project())?.name).toBe('qmtest-dynamic');
      expect(
        (await a.call('GET', '/api/v1/compose/projects/qmtest-dynamic', undefined, a.admin)).status,
      ).toBe(200);
      expect(startedAt('qmtest-dynamic-app-1')).toBe(before);
      const audit = (await a.call('GET', '/api/v1/audit?limit=100', undefined, a.admin)).body.entries as {
        action: string;
      }[];
      expect(audit.some((e) => e.action === 'monitoring.restore')).toBe(true);
    });

    it('can ignore a single standalone container, but not a Compose container', async () => {
      const compose = await a.call(
        'POST',
        '/api/v1/ignored',
        { kind: 'container', name: 'qmtest-dynamic-app-1', confirm: 'qmtest-dynamic-app-1' },
        a.admin,
      );
      expect(compose.status).toBe(409);
      expect(compose.body.error.code).toBe('unsupported');

      const r = await a.call(
        'POST',
        '/api/v1/ignored',
        { kind: 'container', name: STANDALONE, confirm: STANDALONE },
        a.admin,
      );
      expect(r.status, r.raw).toBe(201);
      const names = (
        (await a.call('GET', '/api/v1/containers', undefined, a.admin)).body as { name: string }[]
      ).map((c) => c.name);
      expect(names).not.toContain(STANDALONE);
      expect(names).toContain('qmtest-dynamic-app-1');
      const x = await a.call('POST', `/api/v1/containers/${STANDALONE}/actions/restart`, {}, a.admin);
      expect(x.status).toBe(409);
      expect(x.body.error.code).toBe('ignored');
      expect(docker('inspect', '--format', '{{.State.Status}}', STANDALONE)).toBe('running');
      expect((await del(r.body.id)).status).toBe(200);
      const after = (
        (await a.call('GET', '/api/v1/containers', undefined, a.admin)).body as { name: string }[]
      ).map((c) => c.name);
      expect(after).toContain(STANDALONE);
    });
  });
});
