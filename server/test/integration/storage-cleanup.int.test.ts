import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from '../helpers/app.js';

/**
 * Removal of volumes / networks / images against the real daemon. SAFETY (AGENTS.md): every resource
 * is named qmtest-st-* and labelled quaymaster.test=true, the instance is scoped to `qmtest-st-*`, and
 * nothing here runs an unfiltered prune. Everything is removed again in afterAll.
 */
const L = ['--label', 'quaymaster.test=true', '--label', 'qmtest.suite=storage-cleanup'];
const P = 'qmtest-st-';
const BASE = `${P}base:1`;
const IMG1 = `${P}img:1`;
const IMG2 = `${P}img:2`;
const VOL_USED = `${P}used`;
const VOL_FREE = `${P}free`;
const VOL_FREE2 = `${P}free2`;
const VOL_OUT = 'qmtest-zz-outside'; // outside the instance scope `qmtest-st-*`
const NET_FREE = `${P}free-net`;
const NET_BUSY = `${P}busy-net`;
const HOLDER = `${P}holder`;
const BLOB = 4 * 1024 * 1024;

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
const volExists = (n: string): boolean => dkTry('volume', 'inspect', n) !== null;
const netExists = (n: string): boolean => dkTry('network', 'inspect', n) !== null;
const imgExists = (n: string): boolean => dkTry('image', 'inspect', n) !== null;
const anonVolumes: string[] = [];

function writeIntoVolume(name: string, bytes: number): void {
  const mp = dk('volume', 'inspect', '--format', '{{.Mountpoint}}', name);
  if (!existsSync(mp)) throw new Error(`volume mountpoint ${mp} not reachable from the test`);
  writeFileSync(path.join(mp, 'blob.bin'), randomBytes(bytes));
}

function buildImage(tag: string, extraTag?: string): void {
  const dir = mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'qm-st-img-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'blob'), randomBytes(BLOB));
  writeFileSync(
    path.join(dir, 'Dockerfile'),
    'FROM scratch\nCOPY blob /blob\nLABEL quaymaster.test=true\nLABEL qmtest.suite=storage-cleanup\n',
  );
  dk('build', '--quiet', '-t', tag, dir);
  if (extraTag) dk('tag', tag, extraTag);
  rmSync(dir, { recursive: true, force: true });
}

function cleanupAll(): void {
  dkTry('rm', '-f', HOLDER);
  for (const v of [VOL_USED, VOL_FREE, VOL_FREE2, VOL_OUT, ...anonVolumes]) dkTry('volume', 'rm', v);
  for (const n of [NET_FREE, NET_BUSY]) dkTry('network', 'rm', n);
  for (const i of [IMG1, IMG2, BASE]) dkTry('rmi', i);
}

describe('storage cleanup (real Docker, qmtest-st-* only)', () => {
  let t: TestApp;
  const realVolumesBefore: string[] = [];
  const realNetworksBefore: string[] = [];
  const notOurs = (l: string): string[] =>
    l.split('\n').filter((n) => n && !n.startsWith('qmtest-') && !anonVolumes.includes(n));

  beforeAll(async () => {
    cleanupAll();
    realVolumesBefore.push(...notOurs(dk('volume', 'ls', '-q')));
    realNetworksBefore.push(...notOurs(dk('network', 'ls', '--format', '{{.Name}}')));
    buildImage(BASE);
    buildImage(IMG1, IMG2);
    for (const v of [VOL_USED, VOL_FREE, VOL_FREE2, VOL_OUT]) dk('volume', 'create', ...L, v);
    writeIntoVolume(VOL_FREE, BLOB);
    writeIntoVolume(VOL_FREE2, BLOB);
    writeIntoVolume(VOL_USED, 1024);
    anonVolumes.push(dk('volume', 'create', ...L)); // anonymous: a 64-hex name
    for (const n of [NET_FREE, NET_BUSY]) dk('network', 'create', ...L, n);
    // a STOPPED container that references a volume and a network
    dk(
      'create',
      '--name',
      HOLDER,
      ...L,
      '-v',
      `${VOL_USED}:/data`,
      '--network',
      NET_BUSY,
      BASE,
      '/nonexistent',
    );
    t = await startApp({ QM_MANAGED_SCOPE: `${P}*` });
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    cleanupAll();
  });

  const post = (url: string, body: unknown) => t.call('POST', `/api/v1${url}`, body, t.admin);

  it('refuses to remove a volume that a STOPPED container references, and the volume survives', async () => {
    const r = await post(`/volumes/${VOL_USED}/remove`, { confirm: VOL_USED });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('conflict');
    expect(r.body.error.message).toMatch(
      new RegExp(`${HOLDER}.*stopped container counts|stopped container counts`),
    );
    expect(volExists(VOL_USED)).toBe(true);
  });

  it('refuses a network with an attached container and a volume outside the managed scope', async () => {
    const n = await post(`/networks/${NET_BUSY}/remove`, { confirm: NET_BUSY });
    expect(n.status).toBe(409);
    expect(n.body.error.message).toMatch(/attached/);
    expect(netExists(NET_BUSY)).toBe(true);
    const o = await post(`/volumes/${VOL_OUT}/remove`, { confirm: VOL_OUT });
    expect(o.status).toBe(409);
    expect(o.body.error.code).toBe('out_of_scope');
    expect(volExists(VOL_OUT)).toBe(true);
    // predefined networks are never removable, whatever the scope
    for (const name of ['bridge', 'host', 'none']) {
      expect((await post(`/networks/${name}/remove`, { confirm: name })).status).toBe(409);
    }
  });

  it('single volume removal needs the exact name; on success it frees the data and reports bytes', async () => {
    const wrong = await post(`/volumes/${VOL_FREE2}/remove`, { confirm: 'nope' });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('confirmation_required');
    expect(volExists(VOL_FREE2)).toBe(true);
    const ok = await post(`/volumes/${VOL_FREE2}/remove`, { confirm: VOL_FREE2 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ kind: 'volume', name: VOL_FREE2, action: 'deleted' });
    expect(ok.body.reclaim.estimatedBytes).toBeGreaterThanOrEqual(BLOB);
    console.log('single volume reclaim:', JSON.stringify(ok.body.reclaim));
    expect(volExists(VOL_FREE2)).toBe(false);
    // bytes were measured through /system/df around the removal
    expect(['df', 'statfs']).toContain(ok.body.reclaim.basis);
    expect(ok.body.reclaim.reclaimedBytes).toBeGreaterThan(BLOB / 2);
  });

  it('bulk: preview lists only unused, in-scope volumes with sizes; typed phrase required; actual bytes reported', async () => {
    const pv = await post('/storage/cleanup/preview', { categories: ['named_volumes'], minAgeHours: 0 });
    expect(pv.status).toBe(200);
    const p = pv.body;
    expect(p.candidates.map((c: { name: string }) => c.name)).toEqual([VOL_FREE]);
    expect(p.candidates[0].size).toBeGreaterThanOrEqual(BLOB);
    expect(p.candidates[0].anonymous).toBe(false);
    expect(p.deletesData).toBe(true);
    expect(p.confirmPhrase).toBe('delete 1 volume');
    const prot = Object.fromEntries(
      p.protected.map((x: { name: string; reason: string }) => [x.name, x.reason]),
    );
    expect(prot[VOL_USED]).toMatch(/in use/);
    expect(prot[VOL_OUT]).toMatch(/outside QM_MANAGED_SCOPE/);

    // a preview id alone (what image cleanup uses) is not enough for data deletion
    const weak = await post('/storage/cleanup/execute', { previewId: p.previewId, confirm: p.previewId });
    expect(weak.status).toBe(409);
    expect(weak.body.error.code).toBe('confirmation_required');
    expect(volExists(VOL_FREE)).toBe(true);

    const ex = await post('/storage/cleanup/execute', { previewId: p.previewId, confirm: p.confirmPhrase });
    expect(ex.status).toBe(200);
    expect(ex.body.removed.map((r: { name: string }) => r.name)).toEqual([VOL_FREE]);
    expect(ex.body.skipped).toEqual([]);
    console.log('bulk volume reclaim:', JSON.stringify(ex.body.reclaim));
    expect(ex.body.reclaim.estimatedBytes).toBeGreaterThanOrEqual(BLOB);
    expect(ex.body.reclaim.reclaimedBytes).toBeGreaterThan(BLOB / 2);
    expect(volExists(VOL_FREE)).toBe(false);
    expect(volExists(VOL_USED)).toBe(true);
    // replaying a used preview is refused
    expect(
      (await post('/storage/cleanup/execute', { previewId: p.previewId, confirm: p.confirmPhrase })).status,
    ).toBe(409);
  });

  it('anonymous (hash-named) volumes are never removed when they cannot be attributed to the managed scope', async () => {
    const pv = await post('/storage/cleanup/preview', { categories: ['anonymous_volumes'], minAgeHours: 0 });
    expect(pv.status).toBe(200);
    expect(pv.body.candidates).toEqual([]);
    expect(volExists(anonVolumes[0] as string)).toBe(true);
    expect(JSON.stringify(pv.body.protected)).toMatch(/outside QM_MANAGED_SCOPE/);
  });

  it('bulk networks: only the unused in-scope network is removed; the attached one is kept', async () => {
    const pv = await post('/storage/cleanup/preview', { categories: ['unused_networks'], minAgeHours: 0 });
    expect(pv.body.candidates.map((c: { name: string }) => c.name)).toEqual([NET_FREE]);
    expect(pv.body.confirmPhrase).toBeNull();
    expect(pv.body.deletesData).toBe(false);
    const ex = await post('/storage/cleanup/execute', {
      previewId: pv.body.previewId,
      confirm: pv.body.previewId,
    });
    expect(ex.status).toBe(200);
    expect(ex.body.removed).toHaveLength(1);
    expect(netExists(NET_FREE)).toBe(false);
    expect(netExists(NET_BUSY)).toBe(true);
  });

  it('TOCTOU: a container created on a previewed volume after the preview keeps it', async () => {
    dk('volume', 'create', ...L, `${P}race`);
    try {
      writeIntoVolume(`${P}race`, 1024);
      const pv = await post('/storage/cleanup/preview', { categories: ['named_volumes'], minAgeHours: 0 });
      expect(pv.body.candidates.map((c: { name: string }) => c.name)).toContain(`${P}race`);
      dk('create', '--name', `${P}racer`, ...L, '-v', `${P}race:/d`, BASE, '/nonexistent');
      const ex = await post('/storage/cleanup/execute', {
        previewId: pv.body.previewId,
        confirm: pv.body.confirmPhrase,
      });
      expect(ex.status).toBe(200);
      expect(ex.body.removed.map((r: { name: string }) => r.name)).not.toContain(`${P}race`);
      expect(ex.body.skipped.find((s: { name: string }) => s.name === `${P}race`)?.reason).toMatch(/in use/);
      expect(volExists(`${P}race`)).toBe(true);
    } finally {
      dkTry('rm', '-f', `${P}racer`);
      dkTry('volume', 'rm', `${P}race`);
    }
  });

  it('images: untag one of two tags keeps the image; removing the image is refused while a container uses it', async () => {
    const untag = await post(`/images/${encodeURIComponent(IMG2)}/remove`, { confirm: IMG2, tag: IMG2 });
    expect(untag.status).toBe(200);
    expect(untag.body).toMatchObject({ action: 'untagged', removedTags: [IMG2], remainingTags: [IMG1] });
    expect(imgExists(IMG2)).toBe(false);
    expect(imgExists(IMG1)).toBe(true);

    const used = await post(`/images/${encodeURIComponent(BASE)}/remove`, { confirm: BASE });
    expect(used.status).toBe(409);
    expect(used.body.error.message).toMatch(/used by container/);
    expect(imgExists(BASE)).toBe(true);
  });

  it('images: bulk preview/execute removes only the filtered, unused image and reports estimate vs actual bytes', async () => {
    const pv = await post('/images/cleanup/preview', {
      categories: ['unused_images', 'dangling_images'],
      minAgeHours: 0,
      labelFilter: 'qmtest.suite=storage-cleanup',
    });
    expect(pv.status).toBe(200);
    const names = pv.body.candidates.map((c: { name: string }) => c.name);
    expect(names).toEqual([IMG1]);
    expect(pv.body.candidates[0].size).toBeGreaterThanOrEqual(BLOB);
    expect(
      pv.body.protected.some(
        (x: { name: string; reason: string }) => x.name === BASE && /in use/.test(x.reason),
      ),
    ).toBe(true);
    const ex = await post('/images/cleanup/execute', {
      previewId: pv.body.previewId,
      confirm: pv.body.previewId,
    });
    expect(ex.status).toBe(200);
    expect(ex.body.removed).toHaveLength(1);
    console.log('image reclaim:', JSON.stringify(ex.body.reclaim));
    expect(ex.body.reclaim.estimatedBytes).toBeGreaterThanOrEqual(BLOB);
    expect(ex.body.reclaim.reclaimedBytes).toBeGreaterThan(BLOB / 2);
    expect(imgExists(IMG1)).toBe(false);
    expect(imgExists(BASE)).toBe(true);
  });

  it('writes an audit record for every removal and leaves non-qmtest resources untouched', async () => {
    const rows = t.ctx.audit.list({ limit: 200 });
    const removals = rows.filter((r) => /^(volume|network|image)\.remove$/.test(r.action));
    const ok = removals.filter((r) => r.outcome === 'success').map((r) => `${r.action}:${r.target}`);
    expect(ok).toEqual(
      expect.arrayContaining([
        `volume.remove:${VOL_FREE2}`,
        `volume.remove:${VOL_FREE}`,
        `image.remove:${IMG1}`,
      ]),
    );
    expect(ok.some((x) => x.startsWith('network.remove:'))).toBe(true);
    expect(removals.some((r) => r.outcome === 'denied' && r.target === VOL_USED)).toBe(true);
    expect(removals.every((r) => r.actor === 'tester')).toBe(true);
    expect(notOurs(dk('volume', 'ls', '-q')).sort()).toEqual([...realVolumesBefore].sort());
    expect(notOurs(dk('network', 'ls', '--format', '{{.Name}}')).sort()).toEqual(
      [...realNetworksBefore].sort(),
    );
  });

  it('read-only mode refuses every removal route server-side', async () => {
    const ro = await startApp({ QM_MANAGED_SCOPE: `${P}*`, QM_READ_ONLY: 'true' });
    try {
      const c = (url: string, body: unknown) => ro.call('POST', `/api/v1${url}`, body, ro.admin);
      expect((await c(`/volumes/${VOL_USED}/remove`, { confirm: VOL_USED })).body.error.code).toBe(
        'read_only',
      );
      expect((await c(`/networks/${NET_BUSY}/remove`, { confirm: NET_BUSY })).body.error.code).toBe(
        'read_only',
      );
      expect((await c(`/images/${encodeURIComponent(BASE)}/remove`, { confirm: BASE })).body.error.code).toBe(
        'read_only',
      );
      expect(volExists(VOL_USED) && netExists(NET_BUSY) && imgExists(BASE)).toBe(true);
    } finally {
      await ro.close();
    }
  });
});
