import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, decodeSecretKey, loadConfig } from '../../src/config/env.js';
import {
  Guard,
  checkEngineRequest,
  globToRegExp,
  NO_SELF,
  type ContainerPermit,
} from '../../src/security/guard.js';
import { containerIdFromCgroup, containerIdFromMountinfo, detectSelf } from '../../src/security/self.js';
import { buildComposeArgv, assertSafeArgv } from '../../src/compose/argv.js';
import {
  buildGraph,
  dependentsOf,
  namespaceProviders,
  projectReferences,
  topoOrder,
} from '../../src/compose/graph.js';
import { PathPolicy } from '../../src/compose/paths.js';
import { buildProjects, usesRemoteResources } from '../../src/compose/discovery.js';
import { sanitizeEvent, diffInventories } from '../../src/docker/events.js';
import { toSample } from '../../src/docker/stats.js';
import { demuxBuffer } from '../../src/docker/logs.js';
import { negotiateApiVersion } from '../../src/docker/client.js';
import { SecretBox } from '../../src/crypto/secretbox.js';
import { PasswordService, parseHash } from '../../src/crypto/password.js';
import { LoginLimiter } from '../../src/auth/limiter.js';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations, MIGRATIONS } from '../../src/db/migrate.js';
import { AuthService, hashSessionToken } from '../../src/auth/service.js';
import { checkMutationRequest, allowedOrigins, parseCookies } from '../../src/app.js';
import { UsersRepo } from '../../src/db/users.js';
import { SessionsRepo } from '../../src/db/sessions.js';
import { AuditRepo } from '../../src/db/audit.js';
import { AuditService } from '../../src/audit/audit.js';

const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 13) % 251)).toString('base64');
const baseEnv = { NODE_ENV: 'test', QM_SECRET_KEY: KEY, QM_STACK_PATHS: '/srv/stacks' };
const ID = 'a'.repeat(64);
const hex = (n: string) => n.repeat(64).slice(0, 64);

describe('config', () => {
  it('loads defaults and requires QM_SECRET_KEY and QM_STACK_PATHS', () => {
    const c = loadConfig(baseEnv);
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(8787);
    expect(c.stackPaths).toEqual(['/srv/stacks']);
    expect(() => loadConfig({ NODE_ENV: 'test' })).toThrow(ConfigError);
    try {
      loadConfig({ NODE_ENV: 'test' });
    } catch (e) {
      expect((e as ConfigError).problems.join('\n')).toMatch(/QM_SECRET_KEY[\s\S]*QM_STACK_PATHS/);
    }
  });
  it('rejects weak keys, unknown variables, bad origins and open trust-proxy', () => {
    expect(() => decodeSecretKey('short')).toThrow();
    expect(() => decodeSecretKey('a'.repeat(64))).toThrow(/entropy/);
    expect(() => loadConfig({ ...baseEnv, QM_TYPO: '1' })).toThrow(/unknown variable/);
    expect(() => loadConfig({ ...baseEnv, QM_PUBLIC_ORIGIN: 'https://x.org/path' })).toThrow(/bare origin/);
    expect(() => loadConfig({ ...baseEnv, QM_TRUST_PROXY: 'true' })).toThrow(/explicit IP/);
    expect(() => loadConfig({ ...baseEnv, QM_STACK_PATHS: 'relative/dir' })).toThrow(/absolute/);
    expect(() => loadConfig({ ...baseEnv, QM_ADMIN_USER: 'a' })).toThrow(/QM_ADMIN_PASSWORD/);
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: 'production', QM_SCRYPT_LOG2_N: '12' })).toThrow(
      /NODE_ENV=test/,
    );
  });
  it('error messages never echo secret values', () => {
    try {
      loadConfig({ ...baseEnv, QM_SECRET_KEY: 'supersecretvalue-not-a-key' });
    } catch (e) {
      expect((e as Error).message).not.toContain('supersecretvalue');
    }
  });
});

describe('guard: read-only, scope, self-protection (RT-03, RT-05)', () => {
  const c = (name: string, project: string | null = null, id = hex('b')) => ({ id, name, project });
  it('globs', () => {
    expect(globToRegExp('qmtest-*').test('qmtest-multi-db-1')).toBe(true);
    expect(globToRegExp('qmtest-*').test('real-qmtest-x')).toBe(false);
  });
  it('empty scope allows everything; non-empty requires name AND project to match', () => {
    expect(new Guard({ readOnly: false, scope: [], protectedNames: [] }).containerRefusal(c('x'))).toBeNull();
    const g = new Guard({ readOnly: false, scope: ['qmtest-*'], protectedNames: [] });
    expect(g.containerRefusal(c('qmtest-a'))).toBeNull();
    expect(g.containerRefusal(c('qmtest-a', 'qmtest-p'))).toBeNull();
    expect(g.containerRefusal(c('real'))?.code).toBe('out_of_scope');
    expect(g.containerRefusal(c('qmtest-a', 'real-project'))?.code).toBe('out_of_scope');
  });
  it('read-only refuses everything first; every mutation kind', () => {
    const g = new Guard({ readOnly: true, scope: [], protectedNames: [] });
    expect(g.containerRefusal(c('x'))?.code).toBe('read_only');
    expect(g.projectRefusal('p')?.code).toBe('read_only');
    expect(() => g.assertComposeSubcommand('up')).toThrow(/Read-only/);
    for (const ok of ['config', 'ls', 'ps', 'images', 'version'])
      expect(() => g.assertComposeSubcommand(ok)).not.toThrow();
    expect(() => g.assertComposeSubcommand('exec')).toThrow(/not permitted/);
    expect(() => g.assertComposeSubcommand('run')).toThrow(/not permitted/);
  });
  it('protects self, QM_PROTECTED, own project (project-level only), and fails closed in a container', () => {
    const self = {
      ...NO_SELF,
      inContainer: true,
      containerId: ID,
      containerName: 'quaymaster',
      project: 'qm',
      volumes: ['qm_data'],
      networks: ['qm_default'],
    };
    const g = new Guard({ readOnly: false, scope: [], protectedNames: ['socket-proxy'], self });
    expect(g.containerRefusal(c('quaymaster', 'qm', ID))?.code).toBe('self_protected');
    expect(g.containerRefusal(c('socket-proxy'))?.code).toBe('self_protected');
    expect(g.containerRefusal(c('other', 'qm'))).toBeNull();
    expect(g.projectRefusal('qm')?.code).toBe('self_protected');
    expect(g.projectRefusal('qm', undefined, { perService: true })).toBeNull();
    expect(g.projectRefusal('p', { volumes: ['qm_data'], networks: [], containers: [] })?.code).toBe(
      'self_protected',
    );
    const failing = new Guard({
      readOnly: false,
      scope: [],
      protectedNames: [],
      self: { ...NO_SELF, inContainer: true, failure: 'x' },
    });
    expect(failing.readOnly).toBe(true);
    expect(failing.containerRefusal(c('a'))?.code).toBe('read_only');
  });
  it('scope covers resources referenced by a project (external volumes, container_name, container: modes)', () => {
    const g = new Guard({ readOnly: false, scope: ['qmtest-*'], protectedNames: [] });
    expect(
      g.projectRefusal('qmtest-x', { volumes: ['real-data'], networks: [], containers: [] })?.message,
    ).toMatch(/volume real-data/);
    expect(
      g.projectRefusal('qmtest-x', { volumes: ['qmtest-v'], networks: [], containers: ['real'] })?.message,
    ).toMatch(/container real/);
    expect(
      g.projectRefusal('qmtest-x', { volumes: ['qmtest-v'], networks: ['qmtest-n'], containers: [] }),
    ).toBeNull();
  });
  it('transport allow-list: reads pass; mutations need read-write, a permit for that exact id and an allow-listed path', () => {
    const rw = { readOnlyReason: null };
    const permit = (action: ContainerPermit['action'], id = ID): ContainerPermit => ({
      action,
      containerId: id,
    });
    expect(() => checkEngineRequest('GET', '/v1.55/containers/json', rw, undefined)).not.toThrow();
    expect(() =>
      checkEngineRequest('POST', `/v1.55/containers/${ID}/stop?t=2`, rw, permit('stop')),
    ).not.toThrow();
    expect(() => checkEngineRequest('DELETE', `/containers/${ID}`, rw, permit('remove'))).not.toThrow();
    expect(() => checkEngineRequest('POST', `/containers/${ID}/stop`, rw, undefined)).toThrow(
      /not authorised/,
    );
    expect(() => checkEngineRequest('POST', `/containers/${ID}/stop`, rw, permit('start'))).toThrow(
      /not authorised/,
    );
    expect(() =>
      checkEngineRequest('POST', `/containers/${ID}/stop`, rw, permit('stop', 'c'.repeat(64))),
    ).toThrow(/not authorised/);
    expect(() => checkEngineRequest('POST', '/containers/web/stop', rw, permit('stop'))).toThrow(
      /allow-list/,
    ); // names are refused: full IDs only
    for (const p of [
      '/containers/prune',
      `/containers/${ID}/exec`,
      '/volumes/prune',
      '/networks/x',
      '/build',
    ]) {
      expect(() => checkEngineRequest('POST', p, rw, permit('stop'))).toThrow(/allow-list/);
    }
    // phase 2 operations exist, but only with a permit naming exactly that target
    for (const p of ['/containers/create?name=x', '/images/create?fromImage=x&tag=y']) {
      expect(() => checkEngineRequest('POST', p, rw, permit('stop'))).toThrow(/not authorised/);
    }
    expect(() =>
      checkEngineRequest('POST', '/images/create?fromImage=repo&tag=sha256%3Aabc', rw, {
        kind: 'image_pull',
        repo: 'repo',
        tag: 'sha256:abc',
      }),
    ).not.toThrow();
    expect(() =>
      checkEngineRequest('POST', '/images/create?fromImage=other&tag=sha256%3Aabc', rw, {
        kind: 'image_pull',
        repo: 'repo',
        tag: 'sha256:abc',
      }),
    ).toThrow(/not authorised/);
    expect(() =>
      checkEngineRequest('DELETE', '/images/repo%3Atag?force=true', rw, {
        kind: 'image_remove',
        name: 'repo:tag',
      }),
    ).toThrow(/not authorised/); // image removal is never forced
    expect(() =>
      checkEngineRequest('DELETE', '/images/repo%3Atag?force=false', rw, {
        kind: 'image_remove',
        name: 'repo:tag',
      }),
    ).not.toThrow();
    expect(() =>
      checkEngineRequest('POST', '/images/sha256:1/tag?repo=a&tag=b', rw, {
        kind: 'image_tag',
        imageId: 'sha256:1',
        repo: 'a',
        tag: 'b',
      }),
    ).not.toThrow();
    expect(() =>
      checkEngineRequest('POST', '/images/sha256:1/tag?repo=a&tag=OTHER', rw, {
        kind: 'image_tag',
        imageId: 'sha256:1',
        repo: 'a',
        tag: 'b',
      }),
    ).toThrow(/not authorised/);
    expect(() => checkEngineRequest('DELETE', '/images/x', rw, permit('remove'))).toThrow(/allow-list/);
    expect(() =>
      checkEngineRequest('POST', `/containers/${ID}/stop`, { readOnlyReason: 'ro' }, permit('stop')),
    ).toThrow(/Read-only/);
  });
});

describe('self detection (RT-05)', () => {
  const mountinfoV2 = `1020 1010 0:55 /docker/containers/${ID}/resolv.conf /etc/resolv.conf rw - ext4 /dev/sda1 rw\n`;
  it('extracts ids from cgroup v2 mountinfo and v1 cgroup paths', () => {
    expect(containerIdFromMountinfo(mountinfoV2)).toBe(ID);
    expect(containerIdFromMountinfo('0::/\n')).toBeNull();
    expect(containerIdFromCgroup(`12:cpu:/docker/${ID}\n`)).toBe(ID);
    expect(containerIdFromCgroup('0::/\n')).toBeNull();
  });
  const probe = (
    files: Record<string, string>,
    inspectOk: boolean,
    env: { QM_SELF_CONTAINER?: string } = {},
  ) => ({
    env,
    readFile: (p: string) => files[p] ?? null,
    hostname: () => ID.slice(0, 12),
    inspect: async () =>
      inspectOk
        ? {
            Id: ID,
            Name: '/qm',
            Config: { Labels: { 'com.docker.compose.project': 'qmproj' } },
            Mounts: [{ Type: 'volume', Name: 'qmdata' }],
            NetworkSettings: { Networks: { qmnet: {} } },
          }
        : null,
  });
  it('native host: no self; container: identified via mountinfo; failure fails closed', async () => {
    expect((await detectSelf(probe({}, true))).inContainer).toBe(false);
    const ok = await detectSelf(probe({ '/proc/self/mountinfo': mountinfoV2 }, true));
    expect(ok).toMatchObject({
      containerId: ID,
      project: 'qmproj',
      volumes: ['qmdata'],
      networks: ['qmnet'],
      failure: null,
    });
    const bad = await detectSelf(probe({ '/.dockerenv': '' }, false));
    expect(bad.failure).toBeTruthy();
    expect(new Guard({ readOnly: false, scope: [], protectedNames: [], self: bad }).readOnly).toBe(true);
    const explicit = await detectSelf(probe({}, true, { QM_SELF_CONTAINER: 'qm' }));
    expect(explicit.containerId).toBe(ID);
    const wrong = await detectSelf(probe({}, false, { QM_SELF_CONTAINER: 'nope' }));
    expect(wrong.failure).toMatch(/QM_SELF_CONTAINER/);
  });
});

describe('compose argv templates (RT-01, RT-28)', () => {
  const t = {
    projectName: 'qmtest-x',
    workingDir: '/srv/stacks/x',
    files: ['/srv/stacks/x/compose.yaml', '/srv/stacks/x/override.yaml'],
  };
  const anchor = [
    'compose',
    '--ansi=never',
    '--progress=plain',
    '--project-name=qmtest-x',
    '--project-directory=/srv/stacks/x',
    '--file=/srv/stacks/x/compose.yaml',
    '--file=/srv/stacks/x/override.yaml',
  ];
  it('passes every input explicitly, in recorded order', () => {
    expect(buildComposeArgv(t, { sub: 'config', format: 'json' })).toEqual([
      ...anchor,
      'config',
      '--format=json',
    ]);
    expect(buildComposeArgv(t, { sub: 'config', hash: ['a', 'b'] })).toEqual([
      ...anchor,
      'config',
      '--hash=a,b',
    ]);
    expect(buildComposeArgv(t, { sub: 'config', hash: [] })).toEqual([...anchor, 'config', '--hash=*']);
  });
  it('up never builds or pulls, uses -- before services, force-recreate only when asked', () => {
    expect(buildComposeArgv(t, { sub: 'up', services: ['web'], noDeps: true, forceRecreate: false })).toEqual(
      [...anchor, 'up', '--detach', '--no-build', '--pull=never', '--no-deps', '--', 'web'],
    );
    expect(buildComposeArgv(t, { sub: 'up', services: [], noDeps: false, forceRecreate: true })).toContain(
      '--force-recreate',
    );
    expect(
      buildComposeArgv(t, { sub: 'up', services: [], noDeps: false, forceRecreate: false }),
    ).not.toContain('--force-recreate');
  });
  it('down has no -v / --rmi / --remove-orphans; stop/start/restart/pull take services after --', () => {
    expect(buildComposeArgv(t, { sub: 'down' })).toEqual([...anchor, 'down']);
    expect(buildComposeArgv(t, { sub: 'stop', services: ['a'] }).slice(-3)).toEqual(['stop', '--', 'a']);
    expect(buildComposeArgv(t, { sub: 'pull', services: [] }).slice(-1)).toEqual(['pull']);
  });
  it('rejects injection through names and paths; deny-list holds for every built command', () => {
    expect(() => buildComposeArgv(t, { sub: 'stop', services: ['--rmi'] })).toThrow();
    expect(() => buildComposeArgv(t, { sub: 'stop', services: ['a b'] })).toThrow();
    expect(() => buildComposeArgv({ ...t, projectName: '--x' }, { sub: 'down' })).toThrow();
    expect(() => buildComposeArgv({ ...t, files: ['rel.yaml'] }, { sub: 'down' })).toThrow();
    for (const f of [
      '--remove-orphans',
      '-v',
      '--volumes',
      '--rmi',
      '--build',
      '--always-recreate-deps',
      '--force-recreate',
    ]) {
      expect(() => assertSafeArgv(['compose', 'up', f])).toThrow(/Forbidden/);
    }
    expect(() => assertSafeArgv(['compose', 'up', '--', '-v'])).not.toThrow(); // after `--` it is a service name, validated elsewhere
  });
});

describe('dependency graph (RT-11)', () => {
  const cfg = {
    services: {
      db: {},
      app: { depends_on: { db: { condition: 'service_healthy' } } },
      worker: { depends_on: ['app'] },
      vpn: {},
      torrent: { network_mode: 'service:vpn', volumes_from: ['app:ro'] },
      ext: {
        network_mode: 'container:real-box',
        container_name: 'real-name',
        volumes_from: ['container:other'],
      },
    },
    volumes: { data: {}, shared: { name: 'real-vol', external: true } },
    networks: { net: { external: true } },
  };
  it('orders dependencies first and records edge kinds', () => {
    const g = buildGraph(cfg);
    expect(g.order.indexOf('db')).toBeLessThan(g.order.indexOf('app'));
    expect(g.order.indexOf('app')).toBeLessThan(g.order.indexOf('worker'));
    expect(g.order.indexOf('vpn')).toBeLessThan(g.order.indexOf('torrent'));
    expect(g.edges).toContainEqual(
      expect.objectContaining({ from: 'app', to: 'db', condition: 'service_healthy' }),
    );
    expect(g.edges).toContainEqual(
      expect.objectContaining({ from: 'torrent', to: 'vpn', kind: 'shares_namespace' }),
    );
    expect(g.edges).toContainEqual(
      expect.objectContaining({ from: 'torrent', to: 'app', kind: 'volumes_from' }),
    );
    expect(dependentsOf(g, 'db')).toEqual(expect.arrayContaining(['app', 'worker', 'torrent']));
    expect(Object.fromEntries(namespaceProviders(g))).toEqual({ vpn: ['torrent'], app: ['torrent'] });
  });
  it('detects cycles', () => {
    const r = topoOrder(
      ['a', 'b'],
      [
        { from: 'a', to: 'b', kind: 'depends_on' },
        { from: 'b', to: 'a', kind: 'depends_on' },
      ],
    );
    expect(r.cycle).toEqual(expect.arrayContaining(['a', 'b']));
    expect(r.order).toEqual([]);
  });
  it('extracts out-of-project references for scope checks', () => {
    expect(projectReferences(cfg)).toEqual({
      volumes: ['real-vol'],
      networks: ['net'],
      containers: ['real-name', 'real-box', 'other'],
    });
  });
});

describe('path policy and discovery trust (RT-02)', () => {
  const tmp = mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'qm-paths-'));
  const stacks = path.join(tmp, 'stacks');
  const dockerRoot = path.join(tmp, 'docker-root');
  mkdirSync(path.join(stacks, 'app'), { recursive: true });
  mkdirSync(path.join(dockerRoot, 'volumes'), { recursive: true });
  writeFileSync(path.join(stacks, 'app', 'compose.yaml'), 'services: {}\n');
  writeFileSync(path.join(dockerRoot, 'volumes', 'evil.yaml'), 'services: {}\n');
  mkdirSync(path.join(tmp, 'outside'));
  writeFileSync(path.join(tmp, 'outside', 'c.yaml'), 'x: 1\n');
  symlinkSync(path.join(tmp, 'outside', 'c.yaml'), path.join(stacks, 'app', 'link.yaml'));
  const policy = new PathPolicy([stacks], () => dockerRoot);

  it('accepts files under a root; rejects outside, traversal, symlink escapes and the Docker root', () => {
    expect(policy.check(path.join(stacks, 'app', 'compose.yaml'), { requireReadable: true }).ok).toBe(true);
    expect(policy.check(path.join(tmp, 'outside', 'c.yaml')).ok).toBe(false);
    expect(policy.check(`${stacks}/app/../../outside/c.yaml`).ok).toBe(false);
    expect(policy.check(path.join(stacks, 'app', 'link.yaml')).ok).toBe(false);
    expect(policy.check(path.join(dockerRoot, 'volumes', 'evil.yaml')).ok).toBe(false);
    expect(policy.check('relative.yaml').ok).toBe(false);
    expect(policy.check(path.join(stacks, 'missing.yaml')).ok).toBe(false);
    expect(
      new PathPolicy([tmp], () => dockerRoot).check(path.join(dockerRoot, 'volumes', 'evil.yaml')),
    ).toMatchObject({ ok: false });
  });

  const guard = new Guard({ readOnly: false, scope: [], protectedNames: [] });
  const ctr = (labels: Record<string, string>, id = 'c1') =>
    ({
      Id: id,
      Names: [`/${id}`],
      Image: 'alpine',
      ImageID: 'sha256:x',
      State: 'running',
      Status: 'Up',
      Created: 1,
      Ports: [],
      Labels: labels,
      Mounts: [],
    }) as never;
  const lab = (dir: string, file: string, project = 'app') => ({
    'com.docker.compose.project': project,
    'com.docker.compose.service': 's',
    'com.docker.compose.project.working_dir': dir,
    'com.docker.compose.project.config_files': file,
  });
  it('labels pointing into the allow-list make a project full; anything else is limited with a reason', () => {
    const good = buildProjects({
      containers: [ctr(lab(path.join(stacks, 'app'), path.join(stacks, 'app', 'compose.yaml')))],
      ls: [],
      scanned: [],
      policy,
      guard,
    });
    expect(good[0]).toMatchObject({ name: 'app', level: 'full', reasons: [] });
    const evil = buildProjects({
      containers: [ctr(lab(path.join(dockerRoot, 'volumes'), path.join(dockerRoot, 'volumes', 'evil.yaml')))],
      ls: [],
      scanned: [],
      policy,
      guard,
    });
    expect(evil[0]?.level).toBe('limited');
    expect(evil[0]?.reasons.join()).toMatch(/Docker data root|outside/);
    const conflict = buildProjects({
      containers: [
        ctr(lab(path.join(stacks, 'app'), path.join(stacks, 'app', 'compose.yaml')), 'c1'),
        ctr(lab('/elsewhere', '/elsewhere/c.yaml'), 'c2'),
      ],
      ls: [],
      scanned: [],
      policy,
      guard,
    });
    expect(conflict[0]?.reasons.join()).toMatch(/conflicting labels/);
    const lsMismatch = buildProjects({
      containers: [ctr(lab(path.join(stacks, 'app'), path.join(stacks, 'app', 'compose.yaml')))],
      ls: [{ Name: 'app', Status: 'running(1)', ConfigFiles: '/other.yaml' }],
      scanned: [],
      policy,
      guard,
    });
    expect(lsMismatch[0]?.level).toBe('limited');
    const noLabels = buildProjects({
      containers: [ctr({ 'com.docker.compose.project': 'p', 'com.docker.compose.service': 's' })],
      ls: [],
      scanned: [],
      policy,
      guard,
    });
    expect(noLabels[0]?.level).toBe('limited');
  });
  it('projects only on disk are listed as down; remote include/extends makes a project limited', () => {
    const p = buildProjects({
      containers: [],
      ls: [],
      scanned: [
        { name: 'app', dir: path.join(stacks, 'app'), files: [path.join(stacks, 'app', 'compose.yaml')] },
      ],
      policy,
      guard,
    });
    expect(p[0]).toMatchObject({ source: 'scan', status: 'down', level: 'full' });
    expect(usesRemoteResources('include:\n  - git://example.org/x.git\n')).toBe(true);
    expect(usesRemoteResources('include:\n  - ./other.yaml\nservices: {}\n')).toBe(false);
  });
});

describe('events, stats, logs, api version', () => {
  it('sanitizeEvent keeps an allow-list and drops exec noise and label dumps', () => {
    expect(
      sanitizeEvent({
        Type: 'container',
        Action: 'exec_start: /bin/sh -c curl -u a:b x',
        Actor: { ID: ID, Attributes: {} },
      }),
    ).toBeNull();
    expect(sanitizeEvent({ Type: 'container', Action: 'exec_die', Actor: { ID: ID } })).toBeNull();
    expect(sanitizeEvent({ Type: 'container', Action: 'attach', Actor: { ID: ID } })).toBeNull();
    const e = sanitizeEvent({
      Type: 'container',
      Action: 'die',
      time: 1700000000,
      Actor: {
        ID: ID,
        Attributes: {
          name: 'web',
          image: 'nginx',
          exitCode: '1',
          'app.secret': 'hunter2',
          'com.docker.compose.project': 'p',
          'com.docker.compose.service': 's',
        },
      },
    });
    expect(e).toMatchObject({
      action: 'die',
      name: 'web',
      project: 'p',
      service: 's',
      attributes: { exitCode: '1' },
    });
    expect(JSON.stringify(e)).not.toContain('hunter2');
    expect(
      sanitizeEvent({
        Type: 'container',
        Action: 'health_status: healthy',
        Actor: { ID: ID, Attributes: {} },
      })?.attributes,
    ).toEqual({ health: 'healthy' });
  });
  it('diffInventories synthesises missed events after a reconnect (RT-25)', () => {
    const k = (state: string) => ({ state, name: 'n', project: null, service: null, image: 'i' });
    const ev = diffInventories(
      new Map([
        ['a', k('running')],
        ['b', k('running')],
        ['c', k('exited')],
      ]),
      new Map([
        ['a', k('exited')],
        ['c', k('running')],
        ['d', k('running')],
      ]),
      5,
    );
    expect(ev.map((e) => `${e.actorId}:${e.action}`).sort()).toEqual([
      'a:die',
      'b:destroy',
      'c:start',
      'd:create',
    ]);
    expect(ev.every((e) => e.synthetic && e.attributes['missed'] === 'true')).toBe(true);
  });
  it('stats: CPU from our own previous sample; memory excludes inactive file cache', () => {
    const s = (read: string, cpu: number) => ({
      read,
      cpu_stats: { cpu_usage: { total_usage: cpu } },
      memory_stats: { usage: 1000, limit: 5000, stats: { inactive_file: 300 } },
      networks: { eth0: { rx_bytes: 5, tx_bytes: 7 }, eth1: { rx_bytes: 1, tx_bytes: 1 } },
      blkio_stats: {
        io_service_bytes_recursive: [
          { op: 'Read', value: 10 },
          { op: 'Write', value: 20 },
        ],
      },
    });
    const a = toSample(s('2026-01-01T00:00:00.000Z', 0), undefined);
    const b = toSample(s('2026-01-01T00:00:02.000Z', 1_000_000_000), a);
    expect(b.cpu).toBe(50);
    expect(b.memUsage).toBe(700);
    expect(b).toMatchObject({ netRx: 6, netTx: 8, blkRead: 10, blkWrite: 20, memLimit: 5000 });
  });
  it('log demux handles split frames, stderr, timestamps, TTY', () => {
    const frame = (type: number, s: string) => {
      const h = Buffer.alloc(8);
      h[0] = type;
      h.writeUInt32BE(Buffer.byteLength(s), 4);
      return Buffer.concat([h, Buffer.from(s)]);
    };
    const buf = Buffer.concat([
      frame(1, '2026-01-01T00:00:00.000000000Z hello\n'),
      frame(2, '2026-01-01T00:00:01.000000000Z oops\npart'),
      frame(2, 'ial\n'),
    ]);
    expect(
      demuxBuffer(buf, false, true).map((l) => `${l.stream}|${String(l.ts?.slice(0, 19) ?? null)}|${l.text}`),
    ).toEqual(['stdout|2026-01-01T00:00:00|hello', 'stderr|2026-01-01T00:00:01|oops', 'stderr|null|partial']);
    expect(demuxBuffer(Buffer.from('tty line\n'), true, false)[0]?.text).toBe('tty line');
  });
  it('API version negotiation: min(daemon, tested); refuse too old / too new minimum', () => {
    expect(negotiateApiVersion({ ApiVersion: '1.55', MinAPIVersion: '1.40' })).toBe('1.55');
    expect(negotiateApiVersion({ ApiVersion: '1.60', MinAPIVersion: '1.44' })).toBe('1.55');
    expect(negotiateApiVersion({ ApiVersion: '1.45' })).toBe('1.45');
    expect(() => negotiateApiVersion({ ApiVersion: '1.30' })).toThrow(/older/);
    expect(() => negotiateApiVersion({ ApiVersion: '1.70', MinAPIVersion: '1.60' })).toThrow(/newer than/);
  });
});

describe('crypto', () => {
  it('SecretBox: round-trip, random IVs, AAD binds the row, tamper and wrong key fail', () => {
    const box = new SecretBox(Buffer.from(KEY, 'base64'));
    const a = box.encrypt('hello', 't:c:1');
    expect(box.decrypt(a, 't:c:1')).toBe('hello');
    expect(box.encrypt('hello', 't:c:1')).not.toBe(a);
    expect(() => box.decrypt(a, 't:c:2')).toThrow();
    const parts = a.split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => box.decrypt(parts.join('.'), 't:c:1')).toThrow();
    expect(() => new SecretBox(Buffer.alloc(32, 9)).decrypt(a, 't:c:1')).toThrow(/different/);
    expect(a).not.toContain('hello');
  });
  it('scrypt hashes carry parameters, verify in constant time, reject malformed and oversized parameter sets', async () => {
    const p = new PasswordService(10);
    const h = await p.hash('correct horse battery');
    expect(h).toMatch(/^scrypt\$1024\$8\$1\$/);
    expect(await p.verify('correct horse battery', h)).toBe(true);
    expect(await p.verify('wrong', h)).toBe(false);
    expect(await p.verify('x', 'garbage')).toBe(false);
    expect(parseHash(h.replace('$1024$', '$4294967296$'))).toBeNull();
    expect(() => PasswordService.validateStrength('short')).toThrow(/12/);
  });
});

describe('database', () => {
  it('migrates, is idempotent, refuses a newer schema, audit log is append-only', () => {
    const { db, close } = openDatabase(':memory:');
    expect(runMigrations(db)).toEqual([]);
    db.prepare('INSERT INTO schema_migrations VALUES (999, ?, 0)').run('future');
    expect(() => runMigrations(db)).toThrow(/newer than this build/);
    db.prepare('DELETE FROM schema_migrations WHERE version = 999').run();
    const audit = new AuditService(new AuditRepo(db));
    audit.record({
      actor: 'a',
      action: 'x',
      outcome: 'success',
      params: { password: 'p4ssw0rd-secret', note: 'ok' },
    });
    const row = db.prepare('SELECT * FROM audit_log').get() as { params: string };
    expect(row.params).not.toContain('p4ssw0rd-secret');
    expect(() => db.prepare("UPDATE audit_log SET actor='b'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(/younger than 30 days/);
    expect(MIGRATIONS.map((m) => m.version)).toEqual(
      [...MIGRATIONS.map((m) => m.version)].sort((a, b) => a - b),
    );
    close();
  });
});

describe('auth: sessions, CSRF, throttling', () => {
  const make = (now = { t: 1_000_000 }) => {
    const { db } = openDatabase(':memory:');
    const users = new UsersRepo(db);
    const passwords = new PasswordService(10);
    const limiter = new LoginLimiter(() => now.t);
    const slept: number[] = [];
    const auth = new AuthService({
      users,
      sessions: new SessionsRepo(db),
      passwords,
      limiter,
      audit: new AuditService(new AuditRepo(db)),
      config: { session: { idleMs: 30 * 60_000, absoluteMs: 12 * 3_600_000 } },
      clock: () => now.t,
      sleep: async (ms) => void slept.push(ms),
    });
    return { auth, users, now, slept, db };
  };
  it('login creates a hashed server-side session; idle and absolute timeouts; logout; rotation', async () => {
    const { auth, now, db } = make();
    await auth.createUser({ username: 'bob', password: 'a-long-password-1', role: 'admin' });
    const a = await auth.login({
      username: 'BOB',
      password: 'a-long-password-1',
      ip: '1.1.1.1',
      userAgent: null,
    });
    const stored = db.prepare('SELECT id_hash FROM sessions').get() as { id_hash: string };
    expect(stored.id_hash).toBe(hashSessionToken(a.token));
    expect(stored.id_hash).not.toBe(a.token);
    expect(auth.authenticate(a.token)?.user.username).toBe('bob');
    const b = await auth.login({
      username: 'bob',
      password: 'a-long-password-1',
      ip: '1.1.1.1',
      userAgent: null,
    });
    expect(b.token).not.toBe(a.token); // new session id on every login
    now.t += 29 * 60_000;
    expect(auth.authenticate(a.token)).not.toBeNull(); // touched
    now.t += 31 * 60_000;
    expect(auth.authenticate(a.token)).toBeNull(); // idle timeout
    const c = await auth.login({
      username: 'bob',
      password: 'a-long-password-1',
      ip: '1.1.1.1',
      userAgent: null,
    });
    for (let i = 0; i < 6; i++) {
      now.t += 20 * 60_000;
      expect(auth.authenticate(c.token)).not.toBeNull();
    }
    now.t += 8 * 3_600_000;
    expect(auth.authenticate(c.token)).toBeNull(); // absolute timeout
    const d = await auth.login({
      username: 'bob',
      password: 'a-long-password-1',
      ip: '1.1.1.1',
      userAgent: null,
    });
    auth.logout(d.ctx);
    expect(auth.authenticate(d.token)).toBeNull();
  });
  it('CSRF token is bound to the session; Origin must match exactly; GET is exempt', async () => {
    const { auth } = make();
    await auth.createUser({ username: 'bob', password: 'a-long-password-1', role: 'admin' });
    const a = await auth.login({
      username: 'bob',
      password: 'a-long-password-1',
      ip: '1.1.1.1',
      userAgent: null,
    });
    const b = await auth.login({
      username: 'bob',
      password: 'a-long-password-1',
      ip: '1.1.1.1',
      userAgent: null,
    });
    const tok = auth.csrfToken(a.ctx);
    expect(auth.verifyCsrf(a.ctx, tok)).toBe(true);
    expect(auth.verifyCsrf(b.ctx, tok)).toBe(false);
    expect(auth.verifyCsrf(a.ctx, undefined)).toBe(false);
    const allowed = allowedOrigins({ publicOrigins: ['https://qm.example.org'], host: '127.0.0.1', port: 1 });
    const run = (o: Partial<Parameters<typeof checkMutationRequest>[0]>) =>
      checkMutationRequest({
        method: 'POST',
        origin: 'https://qm.example.org',
        allowed,
        csrfHeader: tok,
        auth: a.ctx,
        verifyCsrf: (c, t) => auth.verifyCsrf(c, t),
        ...o,
      });
    expect(() => run({})).not.toThrow();
    expect(() => run({ origin: undefined })).toThrow(/Origin/);
    expect(() => run({ origin: 'https://qm.example.org.evil.io' })).toThrow(/Origin/);
    expect(() => run({ csrfHeader: undefined })).toThrow(/CSRF/);
    expect(() => run({ method: 'GET', origin: undefined, csrfHeader: undefined })).not.toThrow();
    expect(() => run({ method: 'DELETE', origin: 'null' })).toThrow();
    expect([...allowedOrigins({ publicOrigins: [], host: '127.0.0.1', port: 8787 })]).toContain(
      'http://localhost:8787',
    );
    expect(parseCookies('a=1; qm_session=abc%20d; b=2')['qm_session']).toBe('abc d');
  });
  it('failed logins: progressive delay (never a hard lock for the account), pair lock, per-IP budget before hashing; audit never stores raw usernames', async () => {
    const { auth, slept, db } = make();
    await auth.createUser({ username: 'bob', password: 'a-long-password-1', role: 'admin' });
    const bad = (ip: string, user = 'bob') =>
      auth.login({ username: user, password: 'nope-nope-nope', ip, userAgent: null });
    for (let i = 0; i < 5; i++) await expect(bad('9.9.9.9')).rejects.toMatchObject({ status: 401 });
    expect(slept.length).toBeGreaterThan(0);
    expect(Math.max(...slept)).toBeLessThanOrEqual(30_000);
    await expect(bad('9.9.9.9')).rejects.toMatchObject({ status: 429 }); // (bob, 9.9.9.9) is locked
    // an attacker from one IP cannot lock the real admin out elsewhere
    const ok = await auth.login({
      username: 'bob',
      password: 'a-long-password-1',
      ip: '2.2.2.2',
      userAgent: null,
    });
    expect(ok.token).toBeTruthy();
    await expect(bad('3.3.3.3', 'typed-my-password-here')).rejects.toMatchObject({ status: 401 });
    const actors = (db.prepare('SELECT actor FROM audit_log').all() as { actor: string }[]).map(
      (r) => r.actor,
    );
    expect(actors.some((a) => a.includes('typed-my-password-here'))).toBe(false);
    expect(actors.some((a) => a.startsWith('unknown:'))).toBe(true);
    for (let i = 0; i < 25; i++) await bad('4.4.4.4', `u${i}`).catch(() => undefined);
    await expect(bad('4.4.4.4', 'u99')).rejects.toMatchObject({
      status: 429,
      headers: expect.objectContaining({ 'Retry-After': expect.any(String) }),
    });
  });
  it('role/disable/password changes revoke sessions; the last admin cannot be demoted', async () => {
    const { auth, users } = make();
    const admin = await auth.createUser({ username: 'root1', password: 'a-long-password-1', role: 'admin' });
    const v = await auth.createUser({ username: 'view', password: 'a-long-password-2', role: 'viewer' });
    const s = await auth.login({ username: 'view', password: 'a-long-password-2', ip: 'i', userAgent: null });
    const revoked: unknown[] = [];
    auth.onRevoked((e) => revoked.push(e));
    auth.updateUser(v.id, { role: 'admin' });
    expect(auth.authenticate(s.token)).toBeNull();
    expect(revoked).toContainEqual({ userId: v.id });
    auth.updateUser(v.id, { role: 'viewer' });
    expect(() => auth.updateUser(admin.id, { role: 'viewer' })).toThrow(/last active admin/);
    expect(users.countActiveAdmins()).toBe(1);
  });
});
