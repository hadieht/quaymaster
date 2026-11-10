import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  STACKS_DIR,
  fixtures,
  startApp,
  waitFor,
  waitOperation,
  writeFixtureFile,
  type TestApp,
} from '../helpers/app.js';

const stateOf = async (t: TestApp, name: string): Promise<string> => {
  t.ctx.containers.invalidate();
  const r = await t.call('GET', '/api/v1/containers', undefined, t.admin);
  return (r.body as { name: string; state: string }[]).find((c) => c.name === name)?.state ?? 'missing';
};
const post = (t: TestApp, url: string, body: unknown = {}, who = t.admin) =>
  t.call('POST', `/api/v1${url}`, body, who);

describe('container actions (fixtures only)', () => {
  let t: TestApp;
  beforeAll(async () => {
    fixtures('up', 'multi', 'single', 'standalone');
    t = await startApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('stop / start / restart / pause / unpause a fixture container, each audited', async () => {
    const n = 'qmtest-single-solo-1';
    expect((await post(t, `/containers/${n}/actions/stop`)).status).toBe(200);
    expect(await stateOf(t, n)).toBe('exited');
    expect((await post(t, `/containers/${n}/actions/stop`)).body.note).toMatch(/already/); // 304 is not an error
    expect((await post(t, `/containers/${n}/actions/start`)).status).toBe(200);
    expect(await stateOf(t, n)).toBe('running');
    expect((await post(t, `/containers/${n}/actions/restart`, { timeoutSeconds: 2 })).status).toBe(200);
    expect((await post(t, `/containers/${n}/actions/pause`)).status).toBe(200);
    expect(await stateOf(t, n)).toBe('paused');
    expect((await post(t, `/containers/${n}/actions/unpause`)).status).toBe(200);
    expect(await stateOf(t, n)).toBe('running');
    const audit = (await t.call('GET', '/api/v1/audit?limit=50', undefined, t.admin)).body.entries as {
      action: string;
      outcome: string;
      target: string | null;
    }[];
    const mine = audit.filter((a) => a.target?.startsWith(n));
    expect(mine.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'container.stop',
        'container.start',
        'container.restart',
        'container.pause',
        'container.unpause',
      ]),
    );
    expect(mine.every((a) => a.outcome === 'success')).toBe(true);
    expect(mine[0]?.target).toMatch(/^qmtest-single-solo-1 \([0-9a-f]{12}\)$/); // real identity, not the typed ref
  });

  it('remove needs the target name as confirmation, never removes volumes, then fixture is restored', async () => {
    const n = 'qmtest-standalone';
    const no = await post(t, `/containers/${n}/actions/remove`);
    expect(no.status).toBe(409);
    expect(no.body.error.code).toBe('confirmation_required');
    const wrong = await post(t, `/containers/${n}/actions/remove`, { confirm: 'something-else' });
    expect(wrong.body.error.code).toBe('confirmation_required');
    // Docker refuses to remove a running container (we never force): stop it first
    const running = await post(t, `/containers/${n}/actions/remove`, { confirm: n });
    expect(running.status).toBe(409);
    expect(running.body.error.message).toMatch(/running/i);
    await post(t, `/containers/${n}/actions/stop`, { timeoutSeconds: 2 });
    const ok = await post(t, `/containers/${n}/actions/remove`, { confirm: n });
    expect(ok.status).toBe(200);
    expect(await stateOf(t, n)).toBe('missing');
    fixtures('up', 'standalone');
  });

  it('kill validates the signal', async () => {
    expect((await post(t, '/containers/qmtest-standalone/actions/kill', { signal: 'rm -rf' })).status).toBe(
      400,
    );
  });

  it('recreating a standalone container is not offered yet (RT-12) and says why', async () => {
    const r = await post(t, '/containers/qmtest-standalone/actions/recreate', {
      confirm: 'qmtest-standalone',
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('unsupported');
  });

  it('rejects malformed references and unknown actions', async () => {
    expect((await post(t, '/containers/--help/actions/stop')).status).toBe(400);
    expect((await post(t, '/containers/qmtest-standalone/actions/explode')).status).toBe(400);
    expect((await post(t, '/containers/does-not-exist-qm/actions/stop')).status).toBe(404);
  });

  it('refuses containers outside QM_MANAGED_SCOPE and audits the denial', async () => {
    const all = (await t.call('GET', '/api/v1/containers', undefined, t.admin)).body as {
      name: string;
      state: string;
      mutable: boolean;
    }[];
    // `start` on an already-running container is a daemon no-op, so this is safe even if the guard were broken
    const real = all.find((c) => !c.name.startsWith('qmtest-') && c.state === 'running');
    if (!real) return; // nothing else on this daemon
    expect(real.mutable).toBe(false);
    const r = await post(t, `/containers/${real.name}/actions/start`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('out_of_scope');
    const audit = (await t.call('GET', '/api/v1/audit?limit=20&action=container.start', undefined, t.admin))
      .body.entries as { outcome: string; target: string }[];
    expect(audit.some((a) => a.outcome === 'denied')).toBe(true);
  });

  it('viewers can read but not mutate; CSRF and Origin are enforced', async () => {
    await t.ctx.auth.createUser({ username: 'viewer1', password: 'viewer-password-123', role: 'viewer' });
    const v = await t.login('viewer1', 'viewer-password-123');
    expect((await t.call('GET', '/api/v1/containers', undefined, v)).status).toBe(200);
    expect((await post(t, '/containers/qmtest-standalone/actions/stop', {}, v)).status).toBe(403);
    expect((await t.call('GET', '/api/v1/audit', undefined, v)).status).toBe(403);
    // wrong CSRF token
    expect(
      (await post(t, '/containers/qmtest-standalone/actions/start', {}, { ...t.admin, csrf: 'nope' })).body
        .error.code,
    ).toBe('csrf');
    // wrong origin
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/containers/qmtest-standalone/actions/start',
      headers: {
        origin: 'https://evil.example',
        cookie: t.admin.cookie,
        'x-qm-csrf': t.admin.csrf,
        'content-type': 'application/json',
      },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('origin');
  });

  it('the Docker transport itself refuses mutations that the service layer did not authorise (RT-03)', async () => {
    const id = (await t.ctx.containers.resolve('qmtest-standalone')).id;
    await expect(t.ctx.docker.getContainer(id).stop()).rejects.toMatchObject({ code: 'internal' });
    await expect(t.ctx.docker.getContainer(id).stop()).rejects.toThrow(/not authorised/);
    expect(await stateOf(t, 'qmtest-standalone')).toBe('running');
  });
});

describe('read-only mode (RT-03)', () => {
  let t: TestApp;
  beforeAll(async () => {
    fixtures('up', 'single');
    t = await startApp({ QM_READ_ONLY: 'true' });
  });
  afterAll(async () => {
    await t.close();
  });

  it('refuses container and compose mutations at the service layer', async () => {
    const a = await post(t, '/containers/qmtest-single-solo-1/actions/stop');
    expect(a.status).toBe(409);
    expect(a.body.error.code).toBe('read_only');
    const b = await post(t, '/compose/projects/qmtest-single/actions/restart');
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('read_only');
    expect(await stateOf(t, 'qmtest-single-solo-1')).toBe('running');
  });

  it('refuses at the transport and the compose runner even when called directly', async () => {
    const id = (await t.ctx.containers.resolve('qmtest-single-solo-1')).id;
    await expect(t.ctx.docker.getContainer(id).stop()).rejects.toThrow(/Read-only/);
    await expect(t.ctx.runner.run(['compose', 'down'])).rejects.toThrow(/Read-only/);
    // reads keep working
    expect((await t.call('GET', '/api/v1/compose/projects', undefined, t.admin)).status).toBe(200);
    expect((await t.call('GET', '/api/v1/system/mode', undefined, t.admin)).body.readOnly).toBe(true);
  });
});

describe('compose operations (full level, fixtures only)', () => {
  let t: TestApp;
  const driftFile = path.join(STACKS_DIR, 'qmtest-drift', 'compose.yaml');
  let driftOriginal: string;

  beforeAll(async () => {
    driftOriginal = readFileSync(driftFile, 'utf8');
    fixtures('up', 'single');
    t = await startApp({}, { background: true });
  });
  afterAll(async () => {
    writeFixtureFile(driftFile, driftOriginal);
    await t.close();
    fixtures('down');
  });

  it('stop / start / restart a project through the single CLI runner, with streamed output and audit', async () => {
    const stop = await post(t, '/compose/projects/qmtest-single/actions/stop');
    expect(stop.status).toBe(202);
    const done = await waitOperation(t, stop.body.operationId);
    expect(done.status).toBe('succeeded');
    expect(done.output).toContain('$ docker compose --ansi=never');
    expect(done.output).toMatch(/Container qmtest-single-solo-1\s+Stopp/);
    expect(done.composeVersion).toMatch(/^\d+\.\d+/);
    expect(await stateOf(t, 'qmtest-single-solo-1')).toBe('exited');

    const start = await post(t, '/compose/projects/qmtest-single/actions/start', { service: 'solo' });
    expect((await waitOperation(t, start.body.operationId)).status).toBe('succeeded');
    expect(await stateOf(t, 'qmtest-single-solo-1')).toBe('running');

    const audit = (await t.call('GET', '/api/v1/audit?limit=20&action=compose.stop', undefined, t.admin)).body
      .entries;
    expect(audit[0]).toMatchObject({ outcome: 'success', target: 'qmtest-single' });
  });

  it('a second operation on the same project is rejected while one is running', async () => {
    const first = await post(t, '/compose/projects/qmtest-single/actions/restart');
    expect(first.status).toBe(202);
    const second = await post(t, '/compose/projects/qmtest-single/actions/restart');
    expect(second.status).toBe(409);
    await waitOperation(t, first.body.operationId);
  });

  it('down requires the project name as confirmation', async () => {
    const r = await post(t, '/compose/projects/qmtest-single/actions/down');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('confirmation_required');
  });

  it('refuses unknown services and bad names', async () => {
    expect(
      (await post(t, '/compose/projects/qmtest-single/actions/restart', { service: 'nope' })).status,
    ).toBe(404);
    expect(
      (await post(t, '/compose/projects/qmtest-single/actions/restart', { service: '--rmi' })).status,
    ).toBe(400);
    expect((await post(t, '/compose/projects/Not_Valid/actions/restart')).status).toBe(400);
    expect((await post(t, '/compose/projects/qmtest-single/actions/restart', { volumes: true })).status).toBe(
      400,
    ); // strict body
  });

  it('limited projects refuse file-level operations with an explanation (real projects, nothing is run)', async () => {
    const projects = (await t.call('GET', '/api/v1/compose/projects', undefined, t.admin)).body as {
      name: string;
      level: string;
    }[];
    const limited = projects.find((p) => p.level === 'limited');
    if (!limited) return;
    const r = await post(t, `/compose/projects/${limited.name}/actions/pull`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('limited_capability');
    expect(r.body.error.message).toMatch(/QM_STACK_PATHS/);
    const cfg = await t.call('GET', `/api/v1/compose/projects/${limited.name}/config`, undefined, t.admin);
    expect(cfg.status).toBe(409);
  });

  it('config-hash gate: drift blocks a redeploy until it is explicitly applied (RT-01)', async () => {
    // first deployment: nothing is running, so nothing can drift
    const up = await post(t, '/compose/projects/qmtest-drift/actions/up');
    expect(up.status, JSON.stringify(up.body)).toBe(202);
    expect((await waitOperation(t, up.body.operationId)).status).toBe('succeeded');
    await waitFor(
      async () => (await stateOf(t, 'qmtest-drift-web-1')) === 'running',
      'drift container running',
    );

    // same files again: hash matches what Compose recorded, so a redeploy is allowed
    const same = await post(t, '/compose/projects/qmtest-drift/actions/redeploy');
    expect(same.status, JSON.stringify(same.body)).toBe(202);
    expect((await waitOperation(t, same.body.operationId)).status).toBe('succeeded');

    // someone edits the file (e.g. in Dockge) without deploying
    writeFixtureFile(driftFile, driftOriginal.replace(/APP_VERSION: ["']1["']/, 'APP_VERSION: "2"'));
    t.ctx.compose.invalidate();
    const blocked = await post(t, '/compose/projects/qmtest-drift/actions/redeploy');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('blocked_drift');
    expect(blocked.body.error.details.services[0].service).toBe('web');
    expect(JSON.stringify(blocked.body.error.details.redactedConfig)).toContain('APP_VERSION');

    const applied = await post(t, '/compose/projects/qmtest-drift/actions/redeploy', { applyDrift: true });
    expect(applied.status, JSON.stringify(applied.body)).toBe(202);
    expect((await waitOperation(t, applied.body.operationId)).status).toBe('succeeded');
    const inspect = (await t.call('GET', '/api/v1/containers/qmtest-drift-web-1', undefined, t.admin)).body
      .inspect;
    expect(inspect.Config.Env).toContain('APP_VERSION=2');

    // recreate of a Compose container goes through Compose and the same gate
    const rec = await post(t, '/containers/qmtest-drift-web-1/actions/recreate', {
      confirm: 'qmtest-drift-web-1',
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(200);
    expect((await waitOperation(t, rec.body.operationId)).status).toBe('succeeded');

    const down = await post(t, '/compose/projects/qmtest-drift/actions/down', { confirm: 'qmtest-drift' });
    expect((await waitOperation(t, down.body.operationId)).status).toBe('succeeded');
  });

  it('recreating a namespace provider needs an explicit confirmation (RT-11)', async () => {
    const up = await post(t, '/compose/projects/qmtest-ns/actions/up');
    expect(up.status, JSON.stringify(up.body)).toBe(202);
    expect((await waitOperation(t, up.body.operationId)).status).toBe('succeeded');
    const detail = (await t.call('GET', '/api/v1/compose/projects/qmtest-ns', undefined, t.admin)).body;
    expect(detail.namespaceProviders).toEqual({ provider: ['consumer'] });
    expect(detail.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'consumer', to: 'provider', kind: 'shares_namespace' }),
      ]),
    );
    const refused = await post(t, '/compose/projects/qmtest-ns/actions/redeploy', { service: 'provider' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('confirmation_required');
    expect(refused.body.error.details.providerFor).toEqual(['consumer']);
    const down = await post(t, '/compose/projects/qmtest-ns/actions/down', { confirm: 'qmtest-ns' });
    expect((await waitOperation(t, down.body.operationId)).status).toBe('succeeded');
  });
});
