import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from '../helpers/app.js';

/**
 * Red-team regressions for the storage cleanup feature (docs/reviews/03-cleanup-redteam.md).
 * SAFETY (AGENTS.md): every resource is named qmtest-rt-* / qmtest-zz-rt* and labelled
 * quaymaster.test=true; every instance is scoped to `qmtest-rt-*`; no prune; afterAll removes everything.
 */
const SUITE = 'storage-redteam';
const L = ['--label', 'quaymaster.test=true', '--label', `qmtest.suite=${SUITE}`];
const P = 'qmtest-rt-';
const SCOPE = `${P}*`;

// RT3-01: a Compose project that still exists on disk but that Quaymaster does not discover
// (no containers left after `docker compose down`, directory outside QM_STACK_PATHS)
const GHOST_PROJECT = `${P}ghost`;
const VOL_GHOST = `${GHOST_PROJECT}_db`;
// RT3-02: visibility
const VOL_HIDDEN = `${P}hidvol`;
const VIS = `${P}vis-*`;
const IMG_VIS = `${P}vis-img`;
const HIDDEN_CONT = `${P}hidden`;
// RT3-03: scope TOCTOU in image cleanup
const IMG_TT = `${P}tt:1`;
const IMG_TT_OUT = 'qmtest-zz-rtout:1'; // outside the instance scope
// RT3-05: short image reference
const IMG_SHORT = `${P}short`;
const SHORT_CONT = `${P}shortc`;

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
const imgExists = (n: string): boolean => dkTry('image', 'inspect', n) !== null;

function buildImage(testCase: string, tag: string, ...extra: string[]): void {
  const dir = mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'qm-rt-img-'));
  writeFileSync(path.join(dir, 'blob'), randomBytes(64 * 1024));
  writeFileSync(
    path.join(dir, 'Dockerfile'),
    `FROM scratch\nCOPY blob /blob\nLABEL quaymaster.test=true\nLABEL qmtest.suite=${SUITE}\nLABEL qmtest.case=${testCase}\n`,
  );
  dk('build', '--quiet', '-t', tag, dir);
  for (const t of extra) dk('tag', tag, t);
  rmSync(dir, { recursive: true, force: true });
}

function cleanupAll(): void {
  for (const c of [HIDDEN_CONT, SHORT_CONT]) dkTry('rm', '-f', c);
  for (const v of [VOL_GHOST, VOL_HIDDEN]) dkTry('volume', 'rm', v);
  for (const i of [
    `${IMG_VIS}:1`,
    `${IMG_VIS}:2`,
    IMG_TT,
    IMG_TT_OUT,
    `${IMG_SHORT}:latest`,
    `${IMG_SHORT}:2`,
  ])
    dkTry('rmi', i);
}

describe('storage cleanup red-team regressions (real Docker, qmtest-rt-* only)', () => {
  let t: TestApp;
  let vis: TestApp;
  const realVolumesBefore: string[] = [];
  const notOurs = (l: string): string[] => l.split('\n').filter((n) => n && !n.startsWith('qmtest-'));

  beforeAll(async () => {
    cleanupAll();
    realVolumesBefore.push(...notOurs(dk('volume', 'ls', '-q')));
    // exactly the labels `docker compose` puts on a named volume
    dk(
      'volume',
      'create',
      ...L,
      '--label',
      `com.docker.compose.project=${GHOST_PROJECT}`,
      '--label',
      'com.docker.compose.volume=db',
      '--label',
      'com.docker.compose.version=2.29.0',
      VOL_GHOST,
    );
    dk('volume', 'create', ...L, VOL_HIDDEN);
    buildImage('vis', `${IMG_VIS}:1`, `${IMG_VIS}:2`);
    // a STOPPED container that is outside QM_VISIBLE_SCOPE uses the (visible) image
    dk('create', '--name', HIDDEN_CONT, ...L, `${IMG_VIS}:1`, '/nonexistent');
    buildImage('tt', IMG_TT);
    buildImage('short', `${IMG_SHORT}:latest`, `${IMG_SHORT}:2`);
    // created by the short reference (no tag): Docker stores Config.Image / .Image = "qmtest-rt-short"
    dk('create', '--name', SHORT_CONT, ...L, IMG_SHORT, '/nonexistent');
    t = await startApp({ QM_MANAGED_SCOPE: SCOPE });
    vis = await startApp({ QM_MANAGED_SCOPE: SCOPE, QM_VISIBLE_SCOPE: VIS });
  }, 240_000);

  afterAll(async () => {
    await t?.close();
    await vis?.close();
    cleanupAll();
    // nothing outside qmtest-* was touched
    expect(notOurs(dk('volume', 'ls', '-q')).sort()).toEqual([...realVolumesBefore].sort());
  });

  const post = (app: TestApp, url: string, body: unknown) =>
    app.call('POST', `/api/v1${url}`, body, app.admin);

  it('RT3-01: a volume of a Compose project Quaymaster cannot see is not offered without the Compose opt-in', async () => {
    const pv = await post(t, '/storage/cleanup/preview', { categories: ['named_volumes'], minAgeHours: 0 });
    expect(pv.status).toBe(200);
    const names = pv.body.candidates.map((c: { name: string }) => c.name);
    expect(names).not.toContain(VOL_GHOST);
    const prot = pv.body.protected.find((p: { name: string }) => p.name === VOL_GHOST);
    expect(prot?.reason).toMatch(/Compose project/);

    // single removal without the acknowledgement is refused as well
    const single = await post(t, `/volumes/${VOL_GHOST}/remove`, { confirm: VOL_GHOST });
    expect(single.status).toBe(409);
    expect(single.body.error.details?.requires).toBe('acknowledgeComposeProject');
    expect(volExists(VOL_GHOST)).toBe(true);

    // with the explicit opt-in it is offered (the owner decided)
    const opt = await post(t, '/storage/cleanup/preview', {
      categories: ['named_volumes'],
      minAgeHours: 0,
      includeComposeProjectVolumes: true,
    });
    expect(opt.body.candidates.map((c: { name: string }) => c.name)).toContain(VOL_GHOST);
    expect(volExists(VOL_GHOST)).toBe(true);
  });

  it('RT3-02: QM_VISIBLE_SCOPE hides volumes/networks from the storage preview and from single removal', async () => {
    const pv = await post(vis, '/storage/cleanup/preview', {
      categories: ['named_volumes', 'anonymous_volumes', 'unused_networks'],
      minAgeHours: 0,
    });
    expect(pv.status).toBe(200);
    const seen = [
      ...pv.body.candidates.map((c: { name: string }) => c.name),
      ...pv.body.protected.map((c: { name: string }) => c.name),
    ];
    // no name outside the visible scope may leak through the preview (real user volumes included)
    expect(seen.filter((n: string) => !n.startsWith(`${P}vis-`))).toEqual([]);
    const single = await post(vis, `/volumes/${VOL_HIDDEN}/remove`, { confirm: VOL_HIDDEN });
    expect(single.status).toBe(404);
    expect(volExists(VOL_HIDDEN)).toBe(true);
  });

  it('RT3-03: image cleanup never treats an image used by an INVISIBLE stopped container as unused', async () => {
    const pv = await post(vis, '/images/cleanup/preview', {
      categories: ['unused_images'],
      minAgeHours: 0,
      labelFilter: 'qmtest.case=vis',
    });
    expect(pv.status).toBe(200);
    const cand = pv.body.candidates.map((c: { name: string }) => c.name).join(' ');
    const ex = await post(vis, '/images/cleanup/execute', {
      previewId: pv.body.previewId,
      confirm: pv.body.previewId,
    });
    expect(ex.status).toBe(200);
    // both tags of the in-use image survive (before the fix the first tag was removed, the second refused)
    expect({
      tag1: imgExists(`${IMG_VIS}:1`),
      tag2: imgExists(`${IMG_VIS}:2`),
      skipped: ex.body.skipped,
    }).toEqual({
      tag1: true,
      tag2: true,
      skipped: [],
    });
    expect(cand).not.toContain(IMG_VIS);
  });

  it('RT3-04: image cleanup execute re-checks scope: a tag added outside the scope after the preview is kept', async () => {
    const pv = await post(t, '/images/cleanup/preview', {
      categories: ['unused_images'],
      minAgeHours: 0,
      labelFilter: 'qmtest.case=tt',
    });
    expect(pv.body.candidates.map((c: { name: string }) => c.name)).toContain(IMG_TT);
    dk('tag', IMG_TT, IMG_TT_OUT); // someone tags the image outside QM_MANAGED_SCOPE meanwhile
    const ex = await post(t, '/images/cleanup/execute', {
      previewId: pv.body.previewId,
      confirm: pv.body.previewId,
    });
    expect(ex.status).toBe(200);
    expect(imgExists(IMG_TT_OUT)).toBe(true);
    expect(ex.body.skipped.find((s: { name: string }) => s.name === IMG_TT)?.reason).toMatch(
      /QM_MANAGED_SCOPE/,
    );
  });

  it('RT3-05: the tag a container was created from is kept even when the container used the short reference', async () => {
    const tag = `${IMG_SHORT}:latest`;
    const r = await post(t, `/images/${encodeURIComponent(tag)}/remove`, { confirm: tag, tag });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(new RegExp(SHORT_CONT));
    expect(imgExists(tag)).toBe(true);
    // the other tag can still go
    const other = `${IMG_SHORT}:2`;
    const ok = await post(t, `/images/${encodeURIComponent(other)}/remove`, { confirm: other, tag: other });
    expect(ok.status).toBe(200);
    expect(ok.body.action).toBe('untagged');
  });

  it('identifier / flag injection on the removal routes is rejected before Docker is called', async () => {
    for (const bad of ['-rf', '..', '%2e%2e%2fcontainers', 'a%3Fforce%3Dtrue', 'a%2Fb', ' x']) {
      const v = await post(t, `/volumes/${bad}/remove`, { confirm: bad });
      expect([400, 404]).toContain(v.status);
      const n = await post(t, `/networks/${bad}/remove`, { confirm: bad });
      expect([400, 404]).toContain(n.status);
    }
    const img = await post(t, `/images/${encodeURIComponent('a/../../version')}/remove`, { confirm: 'x' });
    expect(img.status).toBe(400);
    const tagInj = await post(t, `/images/${encodeURIComponent(IMG_TT)}/remove`, { confirm: 'x', tag: '-f' });
    expect(tagInj.status).toBe(400);
  });

  it('CSRF / auth: the removal routes need a session, the CSRF token and an allowed Origin', async () => {
    const noAuth = await t.app.inject({
      method: 'POST',
      url: `/api/v1/volumes/${VOL_HIDDEN}/remove`,
      headers: { origin: 'http://127.0.0.1:8799', 'content-type': 'application/json' },
      payload: JSON.stringify({ confirm: VOL_HIDDEN }),
    });
    expect([401, 403]).toContain(noAuth.statusCode);
    const evil = await t.app.inject({
      method: 'POST',
      url: '/api/v1/storage/cleanup/preview',
      headers: {
        origin: 'http://evil.example',
        cookie: t.admin.cookie,
        'x-qm-csrf': t.admin.csrf,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ categories: ['named_volumes'] }),
    });
    expect(evil.statusCode).toBe(403);
    const noCsrf = await t.app.inject({
      method: 'POST',
      url: `/api/v1/volumes/${VOL_HIDDEN}/remove`,
      headers: {
        origin: 'http://127.0.0.1:8799',
        cookie: t.admin.cookie,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ confirm: VOL_HIDDEN }),
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(volExists(VOL_HIDDEN)).toBe(true);
  });
});
