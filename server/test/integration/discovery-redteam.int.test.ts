import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STACKS_DIR, startApp, waitFor, type TestApp } from '../helpers/app.js';

/**
 * Red-team regressions for dynamic discovery, the read-only file helper and "stop monitoring"
 * (docs/reviews/04-discovery-redteam.md).
 * SAFETY (AGENTS.md): every Docker resource is named qmtest-* and labelled quaymaster.test=true; every instance is
 * scoped to `qmtest-rt-*`; containers are only CREATED (never started) from FROM-scratch images; no prune; afterAll
 * removes everything. Host directories used here are throw-away directories under $TMPDIR.
 */
const SUITE = 'discovery-redteam';
const P = 'qmtest-rt-';
const SCOPE = `${P}*`;
const IMG_FORGE = `${P}forge:1`;
const IMG_SHARE = `${P}share:1`;
const FORGED = `${P}forged`; // project name planted through IMAGE labels
const BOMB = `${P}bomb`;
const PLAN = `${P}plan`;
const HIDDEN = `${P}hidden`; // working dir inside a hidden directory
const OOS_SHARE = 'qmtest-oos-rtshare'; // qmtest-* named, but OUTSIDE the instances' scope
const SECRET_ENV = 'rt-env-secret-90417';
const HOST_ONLY = 'internal-cluster.example.invalid';

const dk = (...args: string[]): string =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  }).trim();
const dkTry = (...args: string[]): string | null => {
  try {
    return dk(...args);
  } catch {
    return null;
  }
};
const tmp = (prefix: string): string => {
  const d = mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), prefix));
  chmodSync(d, 0o755);
  return d;
};

function helperImage(): string | null {
  const fromEnv = process.env['QM_TEST_HELPER_IMAGE'];
  if (fromEnv) return fromEnv;
  const imgs = dk('images', '--format', '{{.Repository}}:{{.Tag}}').split('\n');
  return imgs.find((i) => /(^|\/)quaymaster:/.test(i)) ?? imgs.find((i) => /(^|\/)node:/.test(i)) ?? null;
}

function buildImage(tag: string, labels: Record<string, string>): void {
  const dir = tmp('qm-rt-img-');
  writeFileSync(path.join(dir, 'blob'), randomBytes(1024));
  const lab = Object.entries({ 'quaymaster.test': 'true', 'qmtest.suite': SUITE, ...labels })
    .map(([k, v]) => `LABEL ${k}=${JSON.stringify(v)}`)
    .join('\n');
  writeFileSync(path.join(dir, 'Dockerfile'), `FROM scratch\nCOPY blob /blob\n${lab}\n`);
  dk('build', '--quiet', '-t', tag, dir);
  rmSync(dir, { recursive: true, force: true });
}

const composeLabels = (project: string, dir: string, files: string): string[] => [
  '--label',
  `com.docker.compose.project=${project}`,
  '--label',
  'com.docker.compose.service=app',
  '--label',
  `com.docker.compose.project.working_dir=${dir}`,
  '--label',
  `com.docker.compose.project.config_files=${files}`,
  '--label',
  'com.docker.compose.container-number=1',
  '--label',
  'com.docker.compose.oneoff=False',
];

/** An alias "billion laughs": `levels` levels of 10 aliases each -> 10^levels strings from a few hundred bytes. */
function aliasBomb(levels: number): string {
  const L = 'abcdefghijklmnop';
  let s = `x-a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol","lol"]\n`;
  for (let i = 1; i < levels; i++)
    s += `x-${L[i]}: &${L[i]} [${Array(10)
      .fill(`*${L[i - 1]}`)
      .join(',')}]\n`;
  return `${s}services:\n  app:\n    image: busybox\n    command: *${L[levels - 1]}\n`;
}

describe('discovery red-team (real daemon)', () => {
  const image = helperImage();
  // a host directory that is NOT a stack and not mounted into Quaymaster (in-repo so that it has no hidden segment)
  const hostDir = path.join(STACKS_DIR, `${P}hostdir`);
  const hiddenDir = tmp('qmtest-rt-hidden-'); // under $TMPDIR: stands for ~/.ssh, ~/.kube, ...
  const bombDir = path.join(STACKS_DIR, `${BOMB}`);
  const planDir = path.join(STACKS_DIR, PLAN);
  let t: TestApp;
  let viewer: Awaited<ReturnType<TestApp['login']>>;
  const helpers = (): string[] =>
    dk('ps', '-a', '--filter', 'label=quaymaster.helper=true', '--format', '{{.Names}}')
      .split('\n')
      .filter(Boolean);

  beforeAll(async () => {
    for (const d of [hostDir, bombDir]) mkdirSync(d, { recursive: true });
    writeFileSync(path.join(hiddenDir, 'compose.yaml'), `x-cred: https://${HOST_ONLY}\nservices: {}\n`);
    // a host directory with a non-compose YAML file (think k3s.yaml / netplan) and an .env
    writeFileSync(
      path.join(hostDir, 'cluster-admin.yaml'),
      `clusters:\n  - server: https://${HOST_ONLY}:6443\n`,
    );
    writeFileSync(path.join(hostDir, 'compose.yaml'), 'services:\n  app:\n    image: busybox\n');
    writeFileSync(path.join(hostDir, '.env'), `API_TOKEN=${SECRET_ENV}\n`);
    writeFileSync(path.join(bombDir, 'compose.yaml'), aliasBomb(6));
    // F-04 fixture: a full project (files under QM_STACK_PATHS) whose image tag an out-of-scope container also uses
    mkdirSync(planDir, { recursive: true });
    writeFileSync(
      path.join(planDir, 'compose.yaml'),
      `name: ${PLAN}\nservices:\n  app:\n    image: ${IMG_SHARE}\n    pull_policy: never\n    labels:\n      quaymaster.test: "true"\n`,
    );

    // the forged labels come from the IMAGE: a plain `docker create <image>` inherits them
    buildImage(IMG_FORGE, {
      'com.docker.compose.project': FORGED,
      'com.docker.compose.service': 'app',
      'com.docker.compose.project.working_dir': hostDir,
      'com.docker.compose.project.config_files': `${hostDir}/cluster-admin.yaml`,
    });
    buildImage(IMG_SHARE, {});
    dk('create', '--name', `${FORGED}-app-1`, '--pull', 'never', IMG_FORGE, '/blob');
    dk(
      'create',
      '--name',
      `${BOMB}-app-1`,
      '--pull',
      'never',
      ...composeLabels(BOMB, bombDir, `${bombDir}/compose.yaml`),
      IMG_SHARE,
      '/blob',
    );
    dk(
      'create',
      '--name',
      `${PLAN}-app-1`,
      '--pull',
      'never',
      '--label',
      'quaymaster.test=true',
      ...composeLabels(PLAN, planDir, `${planDir}/compose.yaml`),
      IMG_SHARE,
      '/blob',
    );
    dk(
      'create',
      '--name',
      OOS_SHARE,
      '--pull',
      'never',
      '--label',
      'quaymaster.test=true',
      IMG_SHARE,
      '/blob',
    );
    dk(
      'create',
      '--name',
      `${HIDDEN}-app-1`,
      '--pull',
      'never',
      '--label',
      'quaymaster.test=true',
      ...composeLabels(HIDDEN, hiddenDir, `${hiddenDir}/compose.yaml`),
      IMG_SHARE,
      '/blob',
    );

    t = await startApp({
      QM_MANAGED_SCOPE: SCOPE,
      QM_STACK_PATHS: planDir, // the other qmtest-rt-* dirs are NOT stack paths: only the helper can read them
      QM_HELPER_LABELS: 'quaymaster.test=true',
      ...(image ? { QM_HELPER_IMAGE: image } : {}),
    });
    await t.ctx.auth.createUser({ username: 'rtviewer', password: 'viewer-password-123', role: 'viewer' });
    viewer = await t.login('rtviewer', 'viewer-password-123');
  }, 120_000);

  afterAll(async () => {
    await t?.close();
    for (const c of [`${FORGED}-app-1`, `${BOMB}-app-1`, `${PLAN}-app-1`, `${HIDDEN}-app-1`, OOS_SHARE])
      dkTry('rm', '-f', c);
    for (const h of helpers().filter((n) => n.startsWith(P))) dkTry('rm', '-f', h);
    for (const i of [IMG_FORGE, IMG_SHARE]) dkTry('image', 'rm', i);
    for (const d of [hostDir, hiddenDir, bombDir, planDir]) rmSync(d, { recursive: true, force: true });
  });

  it('precondition: a container inherits forged Compose labels from its image', () => {
    expect(
      dk(
        'inspect',
        '--format',
        '{{index .Config.Labels "com.docker.compose.project.working_dir"}}',
        `${FORGED}-app-1`,
      ),
    ).toBe(hostDir);
  });

  it.skipIf(!image)(
    'RT4-01: forged labels never make the helper read non-compose files, and viewers never trigger the helper',
    async () => {
      const v = await t.call('GET', `/api/v1/compose/projects/${FORGED}/config`, undefined, viewer);
      console.log('RT4-01 viewer', v.status, v.raw.slice(0, 300));
      expect(v.raw).not.toContain(HOST_ONLY);
      expect(v.status).toBe(403);
      const a = await t.call('GET', `/api/v1/compose/projects/${FORGED}/config`, undefined, t.admin);
      console.log('RT4-01 admin', a.status, a.raw.slice(0, 300));
      expect(a.raw).not.toContain(HOST_ONLY);
      if (a.status === 200) {
        expect(Object.keys(a.body.config)).not.toContain('cluster-admin.yaml');
        expect(a.body.warnings.join(' ')).toMatch(/cluster-admin\.yaml: not read/);
      }
      // a working directory inside a hidden directory (~/.ssh, ~/.kube ...) is never mounted into a helper
      const hp = (await t.call('GET', '/api/v1/compose/projects', undefined, t.admin)).body.find(
        (p: { name: string }) => p.name === HIDDEN,
      );
      expect(hp?.fileAccess).toBe('none');
      const h = await t.call('GET', `/api/v1/compose/projects/${HIDDEN}/config`, undefined, t.admin);
      expect(h.status).toBe(409);
      expect(h.raw).not.toContain(HOST_ONLY);
      // the helper read is audited
      const audit = await t.call('GET', '/api/v1/audit?limit=50', undefined, t.admin);
      expect(audit.raw).toContain('compose.files_read');
    },
  );

  it.skipIf(!image)('RT4-02: .env values never reach the helper output (Docker log driver)', async () => {
    const realGet = t.ctx.docker.getContainer.bind(t.ctx.docker);
    const kept: string[] = [];
    // keep the helper container after the read so its logs can be inspected
    (t.ctx.docker as unknown as { getContainer: (id: string) => unknown }).getContainer = (id: string) => {
      const c = realGet(id);
      (c as unknown as { remove: () => Promise<void> }).remove = async () => {
        kept.push(id);
      };
      return c;
    };
    try {
      t.ctx.compose.invalidate();
      const r = await t.call('GET', `/api/v1/compose/projects/${FORGED}/config`, undefined, t.admin);
      expect(r.raw).not.toContain(SECRET_ENV);
    } finally {
      (t.ctx.docker as unknown as { getContainer: unknown }).getContainer = realGet;
    }
    expect(kept.length).toBe(1);
    const id = kept[0] as string;
    const logs = dk('logs', id);
    const logType = dk('inspect', '--format', '{{.HostConfig.LogConfig.Type}}', id);
    const user = dk('inspect', '--format', '{{.Config.User}}', id);
    dk('rm', '-f', id);
    console.log(
      'RT4-02',
      `logContainsEnvValue=${logs.includes(SECRET_ENV)}`,
      `logType=${logType}`,
      `user=${user}`,
    );
    expect(logs).not.toContain(SECRET_ENV);
    expect(logType).toBe('json-file');
    expect(user).not.toBe('');
    expect(user.split(':')[0]).not.toBe('0');
  });

  it.skipIf(!image)('RT4-03: a YAML alias bomb is refused instead of being expanded', async () => {
    const t0 = Date.now();
    const r = await t.call('GET', `/api/v1/compose/projects/${BOMB}/config`, undefined, t.admin);
    console.log('RT4-03', r.status, `bytes=${r.raw.length}`, `ms=${Date.now() - t0}`);
    expect(r.raw.length).toBeLessThan(20_000);
    expect(r.raw).toMatch(/too many|alias/i);
  });

  it('RT4-04: ignoring an out-of-scope container does not silence the shared-tag scope fence', async () => {
    const check = async (): Promise<{ ok: boolean; detail: string } | undefined> => {
      const r = await t.call('POST', '/api/v1/maintenance/plan', { project: PLAN }, t.admin);
      expect(r.status, r.raw).toBe(200);
      const checks = (r.body.plan?.preflight?.checks ?? []) as {
        name: string;
        ok: boolean;
        detail: string;
      }[];
      if (checks.length === 0) console.log('RT4-04 plan', r.raw.slice(0, 1500));
      return checks.find((c) => c.name.startsWith('containers sharing the image tag'));
    };
    // there is no registry here: pretend the registry has a newer digest for the shared tag (read-only dry run)
    const upd = t.ctx.updates as unknown as { statusFor: (...a: unknown[]) => Promise<unknown> };
    const realStatus = upd.statusFor.bind(upd);
    upd.statusFor = async (...a: unknown[]) => ({
      ...((await realStatus(...a)) as object),
      state: 'update_available',
      reason: null,
      remoteDigest: `sha256:${'a'.repeat(64)}`,
    });
    const before = await check();
    const ig = await t.call(
      'POST',
      '/api/v1/ignored',
      { kind: 'container', name: OOS_SHARE, confirm: OOS_SHARE },
      t.admin,
    );
    expect(ig.status, ig.raw).toBe(201);
    const after = await check();
    console.log('RT4-04', JSON.stringify({ before, after }));
    await t.call('DELETE', `/api/v1/ignored/${ig.body.id}`, undefined, t.admin);
    upd.statusFor = realStatus;
    expect(before?.ok).toBe(false);
    expect(after?.ok).toBe(false);
    expect(after?.detail).toContain(OOS_SHARE);
  });

  it('RT4-05: the ignore list needs CSRF, admin, and is not readable by viewers', async () => {
    const body = { kind: 'container', name: OOS_SHARE, confirm: OOS_SHARE };
    const noCsrf = await t.app.inject({
      method: 'POST',
      url: '/api/v1/ignored',
      headers: {
        cookie: t.admin.cookie,
        origin: 'http://127.0.0.1:8799',
        'content-type': 'application/json',
      },
      payload: JSON.stringify(body),
    });
    expect(noCsrf.statusCode).toBe(403);
    expect((await t.call('POST', '/api/v1/ignored', body, viewer)).status).toBe(403);
    const list = await t.call('GET', '/api/v1/ignored', undefined, viewer);
    console.log('RT4-05 viewer list', list.status);
    expect(list.status).toBe(403);
  });

  it('no helper container is left behind', async () => {
    await waitFor(() => helpers().filter((n) => n.startsWith(P)).length === 0, 'helpers removed', 10_000);
  });
});
