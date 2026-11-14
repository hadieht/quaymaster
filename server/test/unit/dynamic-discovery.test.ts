import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Dockerode from 'dockerode';
import { helperDeniedDirs, selfMountRoots } from '../../src/context.js';
import { buildProjects } from '../../src/compose/discovery.js';
import { FileHelper, HELPER_SCRIPT, helperUser, parseHelperOutput } from '../../src/compose/helper.js';
import {
  COMPOSE_FILE_RE,
  ENV_FILE_RE,
  filesUnderDir,
  helperDirAllowed,
  mountHintFor,
  validateLabelDir,
} from '../../src/compose/labelpath.js';
import { withinNodeBudget } from '../../src/compose/service.js';
import yaml from 'js-yaml';
import { PathPolicy } from '../../src/compose/paths.js';
import { openDatabase } from '../../src/db/connection.js';
import { IgnoreRepo } from '../../src/db/ignore.js';
import { IgnoreList } from '../../src/docker/ignore.js';
import { Guard } from '../../src/security/guard.js';

const tmp = mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'qm-dyn-'));

describe('label path validation (labels are untrusted)', () => {
  it('accepts absolute canonical directories', () => {
    expect(validateLabelDir('/srv/stacks/myapp')).toEqual({ ok: true, dir: '/srv/stacks/myapp' });
    expect(validateLabelDir('/a')).toMatchObject({ ok: true });
  });
  it.each([
    ['', /empty/],
    ['relative/dir', /absolute/],
    ['/srv/../etc', /\.\./],
    ['/srv/stacks/../../etc', /\.\./],
    ['/srv//stacks', /canonical/],
    ['/srv/./stacks', /canonical/],
    ['/srv/stacks/', /canonical/],
    ['/', /root/],
    ['/proc/1/root', /system directory/],
    ['/sys', /system directory/],
    ['/dev/shm', /system directory/],
    ['/srv/a\0b', /control/],
    ['/srv/a\nb', /control/],
  ])('rejects %j', (p, why) => {
    const r = validateLabelDir(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(why);
  });
  it('rejects non-strings and absurd lengths', () => {
    expect(validateLabelDir(undefined).ok).toBe(false);
    expect(validateLabelDir(42).ok).toBe(false);
    expect(validateLabelDir('/' + 'a'.repeat(5000)).ok).toBe(false);
  });

  it('only compose-like and .env-like names are candidates', () => {
    for (const ok of [
      'compose.yaml',
      'compose.yml',
      'docker-compose.yml',
      'compose.prod.yaml',
      'docker-compose.override.yml',
    ])
      expect(COMPOSE_FILE_RE.test(ok), ok).toBe(true);
    for (const bad of [
      'compose.yaml.bak',
      'mycompose.yaml',
      'compose.json',
      'docker-compose',
      '../compose.yaml',
      'compose/x.yaml',
      'id_rsa',
      'shadow',
    ])
      expect(COMPOSE_FILE_RE.test(bad), bad).toBe(false);
    for (const ok of ['.env', '.env.production', '.env.local']) expect(ENV_FILE_RE.test(ok), ok).toBe(true);
    for (const bad of ['env', '.environment', '.envrc', '.env/../../x', '.ssh'])
      expect(ENV_FILE_RE.test(bad), bad).toBe(false);
  });

  it('config_files entries must live strictly under the directory and have a compose file name (RT4-01)', () => {
    const r = filesUnderDir('/srv/stacks/myapp', [
      '/srv/stacks/myapp/compose.yaml',
      '/srv/stacks/myapp/deploy/stack.prod.yml',
      '/srv/stacks/myapp/deploy/compose.prod.yml',
      '/srv/stacks/myapp/cluster-admin.yaml',
      '/srv/stacks/other/compose.yaml',
      '/srv/stacks/myapp/../other/compose.yaml',
      '/srv/stacks/myapp/id_rsa',
      '/srv/stacks/myapp/compose.yaml/../../x.yaml',
      '/srv/stacks/myapp2/compose.yaml',
      '/etc/passwd',
      'compose.yaml',
      '/srv/stacks/myapp/-flag.yaml',
      '/srv/stacks/myapp/we ird;name.yaml',
      '/srv/stacks/myapp/a\nb.yaml',
    ]);
    expect(r.rel).toEqual(['compose.yaml', 'deploy/compose.prod.yml']);
    expect(r.rejected.map((x) => x.file)).toContain('/srv/stacks/myapp2/compose.yaml');
    expect(r.rejected.map((x) => x.file)).toContain('/etc/passwd');
    expect(r.rejected.map((x) => x.file)).toContain('/srv/stacks/myapp/cluster-admin.yaml');
    expect(r.rejected.map((x) => x.file)).toContain('/srv/stacks/myapp/deploy/stack.prod.yml');
    expect(r.rejected).toHaveLength(12);
  });

  it('RT4-01: the helper never mounts system, credential, data-root or top-level directories', () => {
    for (const ok of [
      '/srv/stacks/myapp',
      '/opt/app',
      '/home/alice/stacks/web',
      '/root/stacks/db',
      '/data/x',
    ])
      expect(helperDirAllowed(ok).ok, ok).toBe(true);
    for (const bad of [
      '/etc',
      '/etc/netplan',
      '/root',
      '/home',
      '/home/alice/.ssh',
      '/home/alice/.config/app',
      '/root/.kube',
      '/srv/.hidden/app',
      '/var/lib/docker/volumes/x/_data',
      '/var/lib/kubelet',
      '/run/secrets',
      '/var/run',
      '/tmp/x',
      '/var/tmp/x',
      '/usr/local/etc',
      '/boot',
      '/srv',
      '/opt',
      '/proc/1/root',
      '/',
    ])
      expect(helperDirAllowed(bad).ok, bad).toBe(false);
    // deployment-specific: the Docker data root and Quaymaster's data directory, below and above
    expect(helperDirAllowed('/mnt/docker/volumes/x', ['/mnt/docker']).ok).toBe(false);
    expect(helperDirAllowed('/srv/qm', ['/srv/qm/data']).ok).toBe(false);
    expect(helperDirAllowed('/srv/stacks/a', ['/srv/qm/data']).ok).toBe(true);
  });

  it('mount hints are generic and copy-pasteable', () => {
    expect(mountHintFor('/srv/stacks/myapp')).toEqual({
      path: '/srv/stacks/myapp',
      volume: '- /srv/stacks/myapp:/srv/stacks/myapp',
      stackPaths: 'QM_STACK_PATHS=/srv/stacks/myapp',
    });
  });
});

describe('PathPolicy reason codes and mount-derived roots', () => {
  const stacks = path.join(tmp, 'stacks');
  const mounted = path.join(tmp, 'mounted');
  const outside = path.join(tmp, 'outside');
  mkdirSync(path.join(stacks, 'app'), { recursive: true });
  mkdirSync(path.join(mounted, 'proj'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'c.yaml'), 'x: 1\n');
  symlinkSync(outside, path.join(stacks, 'app', 'escape'));
  const policy = new PathPolicy(
    [stacks],
    () => null,
    () => [mounted],
  );

  it('classifies failures', () => {
    expect(policy.check(path.join(tmp, 'nowhere'))).toMatchObject({ ok: false, code: 'not_mounted' });
    expect(policy.check(outside)).toMatchObject({ ok: false, code: 'path_not_allowed' });
    expect(policy.check(path.join(stacks, 'app', 'escape', 'c.yaml'))).toMatchObject({
      ok: false,
      code: 'untrusted',
    });
    expect(policy.check('relative')).toMatchObject({ ok: false, code: 'untrusted' });
    expect(policy.check(`${stacks}/app/../../outside`)).toMatchObject({
      ok: false,
      code: 'path_not_allowed',
    });
  });
  it('directories mounted into Quaymaster at the same path count as roots; others do not', () => {
    expect(policy.check(path.join(mounted, 'proj')).ok).toBe(true);
    expect(policy.allowedRoots).toContain(mounted);
    expect(new PathPolicy([stacks]).check(path.join(mounted, 'proj'))).toMatchObject({
      ok: false,
      code: 'path_not_allowed',
    });
  });
  it('unreadable (mode 000) directories are not_readable when running unprivileged', () => {
    if (process.getuid?.() === 0) return; // root reads everything
    const d = path.join(stacks, 'locked');
    mkdirSync(d);
    chmodSync(d, 0o000);
    try {
      expect(policy.check(path.join(d, 'compose.yaml'))).toMatchObject({ ok: false, code: 'not_readable' });
    } finally {
      chmodSync(d, 0o755);
    }
  });
});

describe('selfMountRoots', () => {
  const real = path.join(tmp, 'sm-real');
  const data = path.join(tmp, 'sm-data');
  mkdirSync(real);
  mkdirSync(data);
  const cfg = { dataDir: data, dockerSocket: '/var/run/docker.sock' };
  it('keeps identical-path bind mounts, drops the rest', () => {
    const roots = selfMountRoots(
      {
        Mounts: [
          { Type: 'bind', Source: real, Destination: real },
          { Type: 'bind', Source: real, Destination: '/elsewhere' },
          { Type: 'volume', Source: real, Destination: real },
          { Type: 'bind', Source: '/', Destination: '/' },
          { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' },
          { Type: 'bind', Source: '/etc', Destination: '/etc' },
          { Type: 'bind', Source: data, Destination: data },
          { Type: 'bind', Source: tmp, Destination: tmp }, // contains the data dir
          { Type: 'bind', Source: path.join(tmp, 'gone'), Destination: path.join(tmp, 'gone') },
        ],
      },
      cfg,
      null,
    );
    expect(roots).toEqual([real]);
    expect(selfMountRoots(null, cfg, null)).toEqual([]);
  });
});

describe('discovery without configuration', () => {
  const guard = new Guard({ readOnly: false, scope: [], protectedNames: [] });
  const policy = new PathPolicy([]); // no QM_STACK_PATHS at all
  const ctr = (labels: Record<string, string>, id = 'c1', state = 'running') =>
    ({
      Id: id.padEnd(64, '0'),
      Names: [`/${id}`],
      Image: 'alpine',
      ImageID: 'sha256:x',
      State: state,
      Status: state === 'running' ? 'Up' : 'Exited (0)',
      Created: 1,
      Ports: [],
      Labels: labels,
      Mounts: [],
    }) as unknown as Dockerode.ContainerInfo;
  const lab = (dir: string, file: string, project = 'myapp', service = 'web') => ({
    'com.docker.compose.project': project,
    'com.docker.compose.service': service,
    'com.docker.compose.project.working_dir': dir,
    'com.docker.compose.project.config_files': file,
  });

  it('lists every project Docker reports, including exited ones, with a precise reason and a mount hint', () => {
    const p = buildProjects({
      containers: [
        ctr(lab('/srv/stacks/myapp', '/srv/stacks/myapp/compose.yaml'), 'a', 'exited'),
        ctr(lab('/opt/other place/x', '/opt/other place/x/docker-compose.yml', 'second'), 'b'),
      ],
      ls: [],
      scanned: [],
      policy,
      guard,
    });
    expect(p.map((x) => x.name)).toEqual(['myapp', 'second']);
    const mine = p[0]!;
    expect(mine).toMatchObject({ level: 'limited', status: 'stopped', fileAccess: 'none' });
    expect(mine.reasonDetails[0]).toMatchObject({ code: 'not_mounted' });
    expect(mine.reasonDetails[0]?.hint).toContain('- /srv/stacks/myapp:/srv/stacks/myapp');
    expect(mine.mountHint).toEqual(mountHintFor('/srv/stacks/myapp'));
    expect(mine.reasons.join()).not.toMatch(/QM_STACK_PATHS is required/);
  });

  it('offers the read-only helper only when it is usable, the labels are sane and the project is in scope', () => {
    const labels = lab('/srv/stacks/myapp', '/srv/stacks/myapp/compose.yaml');
    const mk = (over: { helper?: boolean; g?: Guard; labels?: Record<string, string>; name?: string }) =>
      buildProjects({
        containers: [ctr(over.labels ?? labels)],
        ls: [],
        scanned: [],
        policy,
        guard: over.g ?? guard,
        helper: { usable: over.helper ?? true },
      })[0]!;
    expect(mk({}).fileAccess).toBe('helper');
    expect(mk({ helper: false }).fileAccess).toBe('none');
    // out of QM_MANAGED_SCOPE: never read
    const scoped = new Guard({ readOnly: false, scope: ['qmtest-*'], protectedNames: [] });
    expect(mk({ g: scoped }).fileAccess).toBe('none');
    // forged / odd labels never reach the helper
    expect(mk({ labels: lab('/srv/../etc', '/srv/../etc/compose.yaml') }).fileAccess).toBe('none');
    expect(mk({ labels: lab('/proc/1/root', '/proc/1/root/compose.yaml') }).fileAccess).toBe('none');
    expect(mk({ labels: lab('relative', 'relative/compose.yaml') }).fileAccess).toBe('none');
    expect(mk({ labels: lab('/', '/compose.yaml') }).fileAccess).toBe('none');
    expect(mk({ labels: lab('/srv/stacks/x', '/srv/stacks/x/compose.yaml', 'Bad_Name!') }).fileAccess).toBe(
      'none',
    );
  });

  it('separate reasons: not readable / file missing / outside / symlink escape', () => {
    const root = path.join(tmp, 'disc-root');
    const proj = path.join(root, 'p1');
    mkdirSync(proj, { recursive: true });
    writeFileSync(path.join(proj, 'compose.yaml'), 'services: {}\n');
    const esc = path.join(root, 'p2');
    mkdirSync(esc);
    symlinkSync(path.join(tmp, 'outside'), path.join(esc, 'link'));
    const pol = new PathPolicy([root]);
    const run = (dir: string, file: string, project: string) =>
      buildProjects({
        containers: [ctr(lab(dir, file, project, 's'), project)],
        ls: [],
        scanned: [],
        policy: pol,
        guard,
      })[0]!;
    expect(run(proj, path.join(proj, 'compose.yaml'), 'ok').level).toBe('full');
    expect(run(proj, path.join(proj, 'gone.yaml'), 'missing').reasonDetails.map((r) => r.code)).toEqual([
      'file_missing',
    ]);
    expect(
      run(path.join(tmp, 'nowhere'), path.join(tmp, 'nowhere', 'compose.yaml'), 'nm').reasonDetails[0]?.code,
    ).toBe('not_mounted');
    expect(
      run(path.join(tmp, 'outside'), path.join(tmp, 'outside', 'c.yaml'), 'out').reasonDetails[0]?.code,
    ).toBe('path_not_allowed');
    expect(run(path.join(esc, 'link'), path.join(esc, 'link', 'c.yaml'), 'esc').reasonDetails[0]?.code).toBe(
      'untrusted',
    );
    expect(run('relative', 'relative/c.yaml', 'rel').reasonDetails[0]?.code).toBe('untrusted');
  });

  it('read-only mode and scope do not stop listing', () => {
    const ro = new Guard({ readOnly: true, scope: ['qmtest-*'], protectedNames: [] });
    const p = buildProjects({
      containers: [ctr(lab('/srv/stacks/myapp', '/srv/stacks/myapp/compose.yaml'))],
      ls: [],
      scanned: [],
      policy,
      guard: ro,
      helper: { usable: true },
    });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ mutable: false, fileAccess: 'none' });
    expect(p[0]?.protectedReason).toMatch(/Read-only/);
  });
});

describe('read-only helper', () => {
  const ok = (name: string, content: string) => ({ name, content, uid: 1, mode: 0o644 });

  it('parseHelperOutput re-validates what the helper printed', () => {
    const good = JSON.stringify({
      dirMode: 0o755,
      dirUid: 0,
      files: [ok('compose.yaml', 'a: 1'), ok('.env', 'K=v'), { name: 'sub/compose.x.yml', error: 'missing' }],
    });
    const r = parseHelperOutput(good, ['sub/compose.x.yml']);
    expect(r.ok && r.files.map((f) => f.name)).toEqual(['compose.yaml', '.env', 'sub/compose.x.yml']);
    // RT4-02: .env CONTENT is dropped even if a (modified) helper image printed it; only keys pass
    expect(r.ok && r.files[1]?.content).toBeUndefined();
    const withKeys = parseHelperOutput(
      JSON.stringify({ files: [{ name: '.env', keys: ['GOOD_KEY', 'bad key', 42] }] }),
      [],
    );
    expect(withKeys.ok && withKeys.files[0]?.keys).toEqual(['GOOD_KEY']);
    // RT4-01: a requested name that is not a compose file name is dropped
    expect(
      parseHelperOutput(JSON.stringify({ files: [ok('sub/x.yml', 'k: v')] }), ['sub/x.yml']).ok &&
        (
          parseHelperOutput(JSON.stringify({ files: [ok('sub/x.yml', 'k: v')] }), ['sub/x.yml']) as {
            files: unknown[];
          }
        ).files,
    ).toEqual([]);
    // names that were not requested and are not compose/.env files in the directory itself are dropped
    const sneaky = JSON.stringify({
      files: [
        ok('/etc/shadow', 'root:x'),
        ok('../../etc/passwd', 'x'),
        ok('id_rsa', 'k'),
        ok('deep/dir/compose.yaml', 'x'),
        ok('compose.yaml', 'a'),
      ],
    });
    const s = parseHelperOutput(sneaky, []);
    expect(s.ok && s.files.map((f) => f.name)).toEqual(['compose.yaml']);
    expect(parseHelperOutput('garbage', []).ok).toBe(false);
    expect(parseHelperOutput('{"files":"x"}', []).ok).toBe(false);
    // oversized content is withheld
    const big = parseHelperOutput(
      JSON.stringify({ files: [ok('compose.yaml', 'x'.repeat(2 * 1024 * 1024))] }),
      [],
    );
    expect(big.ok && big.files[0]).toMatchObject({ error: 'too_large' });
    expect(big.ok && big.files[0]?.content).toBeUndefined();
  });

  it('the in-container script reads compose/.env files, refuses symlinks, world-writable and non-files', () => {
    const dir = path.join(tmp, 'helper-root');
    mkdirSync(path.join(dir, 'sub'), { recursive: true });
    writeFileSync(path.join(dir, 'compose.yaml'), 'services: {}\n');
    writeFileSync(path.join(dir, '.env'), 'SECRET=hunter22\n');
    writeFileSync(path.join(dir, 'notes.txt'), 'not listed\n');
    writeFileSync(path.join(dir, 'sub', 'compose.prod.yml'), 'services: {}\n');
    writeFileSync(path.join(dir, 'sub', 'stack.yml'), 'services: {}\n');
    writeFileSync(path.join(tmp, 'secret.txt'), 'top secret\n');
    symlinkSync(path.join(tmp, 'secret.txt'), path.join(dir, 'compose.override.yaml'));
    writeFileSync(path.join(dir, 'compose.ww.yaml'), 'x: 1\n');
    chmodSync(path.join(dir, 'compose.ww.yaml'), 0o666);
    mkdirSync(path.join(dir, 'compose.dir.yaml'));
    symlinkSync(path.join(tmp, 'outside'), path.join(dir, 'linkdir'));
    const script = HELPER_SCRIPT.replace("const ROOT = '/project';", `const ROOT = ${JSON.stringify(dir)};`);
    expect(script).not.toBe(HELPER_SCRIPT);
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        script,
        '--',
        'sub/compose.prod.yml',
        'sub/stack.yml',
        'linkdir/compose.yaml',
        '../secret.txt',
        'missing.yml',
        'compose.missing.yml',
      ],
      {
        encoding: 'utf8',
      },
    );
    // RT4-02: stdout is what the Docker log driver stores; .env values must never be in it
    expect(out).not.toContain('hunter22');
    const parsed = parseHelperOutput(out, [
      'sub/compose.prod.yml',
      'sub/stack.yml',
      'linkdir/compose.yaml',
      '../secret.txt',
      'missing.yml',
      'compose.missing.yml',
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const by = Object.fromEntries(parsed.files.map((f) => [f.name, f]));
    expect(by['compose.yaml']?.content).toBe('services: {}\n');
    expect(by['.env']?.content).toBeUndefined();
    expect(by['.env']?.keys).toEqual(['SECRET']);
    expect(by['sub/compose.prod.yml']?.content).toBe('services: {}\n');
    expect(by['sub/stack.yml']).toBeUndefined(); // not a compose file name: not even read (RT4-01)
    expect(by['compose.override.yaml']).toMatchObject({ error: 'symlink' });
    expect(by['compose.ww.yaml']).toMatchObject({ error: 'world_writable' });
    expect(by['compose.dir.yaml']).toMatchObject({ error: 'not_file' });
    expect(by['linkdir/compose.yaml']).toMatchObject({ error: 'symlink' });
    expect(by['compose.missing.yml']).toMatchObject({ error: 'missing' });
    expect(by['missing.yml']).toBeUndefined();
    expect(by['notes.txt']).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain('top secret');
    expect(out).not.toContain('top secret');
    expect(by['../secret.txt']).toBeUndefined(); // refused by the script, then dropped by the validator
  });

  const fakeDocker = (calls: string[]) =>
    ({
      getImage: () => ({
        inspect: async () => {
          calls.push('image.inspect');
          return {};
        },
      }),
    }) as unknown as Dockerode;
  const mk = (
    over: { ro?: boolean; scope?: string[]; image?: string | null; enabled?: boolean },
    calls: string[] = [],
  ) =>
    new FileHelper({
      docker: fakeDocker(calls),
      guard: new Guard({ readOnly: over.ro ?? false, scope: over.scope ?? [], protectedNames: [] }),
      config: {
        helper: {
          enabled: over.enabled ?? true,
          image: 'image' in over ? (over.image ?? null) : 'img:1',
          labels: {},
        },
        managedScope: over.scope ?? [],
      },
      selfImage: async () => null,
      log: { warn: () => undefined } as never,
    });

  it('is unavailable in read-only mode, when disabled, or without an image; never creates anything then', async () => {
    const calls: string[] = [];
    expect((await mk({ ro: true }, calls).status()).reason).toMatch(/read-only/i);
    expect((await mk({ enabled: false }, calls).status()).reason).toMatch(/disabled/);
    expect((await mk({ image: null }, calls).status()).reason).toMatch(/no helper image/);
    expect((await mk({ ro: true }).read('/srv/x', [])).ok).toBe(false);
    expect((await mk({}).status()).usable).toBe(true);
  });

  it('names the helper so that it stays inside QM_MANAGED_SCOPE', () => {
    expect(mk({}).helperName()).toMatch(/^quaymaster-helper-[0-9a-f]{10}$/);
    expect(mk({ scope: ['qmtest-*'] }).helperName()).toMatch(/^qmtest-quaymaster-helper-[0-9a-f]{10}$/);
    expect(mk({ scope: ['exact-name'] }).helperName()).toBeNull();
  });
});

describe('ignore list semantics', () => {
  const open = () => openDatabase(path.join(mkdtempSync(path.join(tmp, 'ign-')), 'q.db'));
  it('keys projects by name AND working directory, containers by name; restore reverses it', () => {
    const { db } = open();
    const repo = new IgnoreRepo(db);
    const list = new IgnoreList(repo);
    const a = repo.add('project', 'myapp', '/srv/stacks/myapp', 'admin');
    expect(repo.add('project', 'myapp', '/srv/stacks/myapp', 'other').id).toBe(a.id); // idempotent
    repo.add('container', 'standalone-1', '', 'admin');
    list.reload();
    expect(list.all()).toHaveLength(2);
    const L = (dir: string | null, project = 'myapp') => ({
      'com.docker.compose.project': project,
      ...(dir ? { 'com.docker.compose.project.working_dir': dir } : {}),
    });
    expect(list.isProjectIgnored('myapp', '/srv/stacks/myapp')).toBe(true);
    expect(list.isProjectIgnored('myapp', '/srv/stacks/other')).toBe(false); // same name, different place
    expect(list.isProjectIgnored('myapp', null)).toBe(false);
    expect(list.isProjectIgnored('other', '/srv/stacks/myapp')).toBe(false);
    expect(list.isContainerIgnored('/myapp-web-1', L('/srv/stacks/myapp'))).toBe(true);
    expect(list.isContainerIgnored('myapp-web-1', L('/srv/stacks/elsewhere'))).toBe(false);
    expect(list.isContainerIgnored('/standalone-1', {})).toBe(true);
    expect(list.isContainerIgnored('standalone-2', {})).toBe(false);
    // a container entry never hides a Compose container that merely shares its name
    expect(list.isContainerIgnored('standalone-1', L('/x', 'proj'))).toBe(false);
    expect(list.hidesRecord('myapp', null)).toBe(true);
    expect(list.hidesRecord(null, 'standalone-1')).toBe(true);
    expect(list.hidesRecord('nope', 'nope')).toBe(false);
    expect(repo.remove(a.id)).toBe(true);
    expect(repo.remove(a.id)).toBe(false);
    list.reload();
    expect(list.isProjectIgnored('myapp', '/srv/stacks/myapp')).toBe(false);
    expect(list.all().map((e) => e.kind)).toEqual(['container']);
  });

  it('survives a reopen (persisted in SQLite)', () => {
    const dir = mkdtempSync(path.join(tmp, 'ign-persist-'));
    const first = openDatabase(path.join(dir, 'q.db'));
    new IgnoreRepo(first.db).add('project', 'p', '/d', 'admin');
    first.close();
    const second = openDatabase(path.join(dir, 'q.db'));
    expect(new IgnoreRepo(second.db).list()).toMatchObject([
      { kind: 'project', name: 'p', workingDir: '/d', ignoredBy: 'admin' },
    ]);
    second.close();
  });
});

describe('discovery red-team regressions (docs/reviews/04-discovery-redteam.md)', () => {
  it('RT4-03: an alias bomb or a cycle exceeds the node budget; a normal compose file does not', () => {
    const L = 'abcdefgh';
    let bomb = 'x-a: &a ["l","l","l","l","l","l","l","l","l","l"]\n';
    for (let i = 1; i < 8; i++)
      bomb += `x-${L[i]}: &${L[i]} [${Array(10)
        .fill(`*${L[i - 1]}`)
        .join(',')}]\n`;
    bomb += `services:\n  app:\n    command: *h\n`;
    expect(bomb.length).toBeLessThan(500);
    const t0 = Date.now();
    expect(withinNodeBudget(yaml.load(bomb), 50_000)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(withinNodeBudget(yaml.load('a: &a\n  b: *a\n'), 50_000)).toBe(false); // cycle
    const normal = yaml.load(
      'x-common: &c\n  restart: unless-stopped\n  env_file: .env\nservices:\n  web:\n    <<: *c\n    image: nginx\n  db:\n    <<: *c\n    image: postgres\n',
    );
    expect(withinNodeBudget(normal, 50_000)).toBe(true);
  });

  it('RT4-01: the helper never runs as root, whatever the image says', () => {
    expect(helperUser(0, 0)).toBe('65534:65534');
    expect(helperUser(undefined, undefined)).toBe('65534:65534');
    expect(helperUser(10001, 10001)).toBe('10001:10001');
  });

  it('RT4-01: denied dirs cover the Docker root and the host source of the data directory', () => {
    const d = helperDeniedDirs(
      {
        Mounts: [
          { Type: 'volume', Source: '/var/lib/docker/volumes/qm_data/_data', Destination: '/data' },
          { Type: 'bind', Source: '/srv/stacks', Destination: '/srv/stacks' },
        ],
      },
      { dataDir: '/data' },
      '/var/lib/docker',
    );
    expect(d).toEqual(
      expect.arrayContaining(['/var/lib/docker', '/data', '/var/lib/docker/volumes/qm_data/_data']),
    );
    expect(d).not.toContain('/srv/stacks');
  });

  /** A fake daemon: records create options, runs "containers" that print `out`, counts concurrency. */
  function fakeDaemon(out: string, delayMs = 30) {
    const created: Record<string, unknown>[] = [];
    let live = 0;
    let maxLive = 0;
    const frame = (s: string): Buffer => {
      const b = Buffer.from(s);
      const h = Buffer.alloc(8);
      h[0] = 1;
      h.writeUInt32BE(b.length, 4);
      return Buffer.concat([h, b]);
    };
    const docker = {
      getImage: () => ({ inspect: async () => ({}) }),
      createContainer: async (o: Record<string, unknown>) => {
        created.push(o);
        live++;
        maxLive = Math.max(maxLive, live);
        let done = false;
        return {
          id: String(created.length).padStart(64, 'a'),
          start: async () => {
            setTimeout(() => (done = true), delayMs);
          },
          inspect: async () => ({ State: { Status: done ? 'exited' : 'running', ExitCode: 0 } }),
          logs: async () => frame(out),
        };
      },
      getContainer: () => ({
        remove: async () => {
          live--;
        },
      }),
    } as unknown as Dockerode;
    return { docker, created, max: () => maxLive };
  }
  const helperWith = (docker: Dockerode) =>
    new FileHelper({
      docker,
      guard: new Guard({ readOnly: false, scope: [], protectedNames: [] }),
      config: {
        helper: { enabled: true, image: 'img:1', labels: { 'quaymaster.helper': 'false', x: 'y' } },
        managedScope: [],
      },
      selfImage: async () => null,
      log: { warn: () => undefined } as never,
      deniedDirs: () => ['/srv/qm-data'],
    });

  it('RT4-01/02/05: helper containers are non-root, json-file logged, labelled, bounded, and refuse denied dirs', async () => {
    const f = fakeDaemon(JSON.stringify({ dirMode: 0o755, dirUid: 0, files: [] }));
    const h = helperWith(f.docker);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => h.read(`/srv/stacks/p${i}`, ['compose.yaml', 'secrets.yaml'])),
    );
    expect(
      results.every((r) => r.ok),
      JSON.stringify(results[0]),
    ).toBe(true);
    expect(f.created).toHaveLength(6);
    expect(f.max()).toBeLessThanOrEqual(2);
    const o = f.created[0] as {
      User: string;
      Cmd: string[];
      Labels: Record<string, string>;
      HostConfig: {
        LogConfig: { Type: string };
        NetworkMode: string;
        ReadonlyRootfs: boolean;
        CapDrop: string[];
      };
    };
    expect(o.User).not.toMatch(/^0(:|$)/);
    expect(o.User).not.toBe('');
    expect(o.HostConfig.LogConfig.Type).toBe('json-file');
    expect(o.Labels['quaymaster.helper']).toBe('true'); // QM_HELPER_LABELS cannot override the marker
    expect(o.Cmd).toEqual(['compose.yaml']); // non-compose names are never passed to the helper
    expect(o.HostConfig).toMatchObject({ NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'] });
    for (const bad of ['/etc', '/root/.ssh', '/srv/qm-data/db', '/var/lib/docker/volumes/x/_data']) {
      const r = await h.read(bad, []);
      expect(r.ok, bad).toBe(false);
    }
    expect(f.created).toHaveLength(6); // nothing was created for the refused directories
  });
});
