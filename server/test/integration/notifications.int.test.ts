import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from '../helpers/app.js';
import type { NotificationService } from '../../src/notifications/service.js';

/** Runs only once the parent has wired `ctx.notifications` and registered the routes. */
let t: TestApp;
let wired = false;
let server: http.Server;
let port = 0;
const received: { headers: http.IncomingHttpHeaders; body: string; url: string }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push({ headers: req.headers, body, url: req.url ?? '' });
      res.statusCode = 200;
      res.end('{"leak":"receiver-response-body"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  t = await startApp();
  wired = Boolean((t.ctx as unknown as { notifications?: NotificationService }).notifications);
});

afterAll(async () => {
  await t?.close();
  await new Promise((r) => server?.close(r));
});

describe('notifications API', () => {
  it('create -> test -> signed delivery; secrets never returned', async (ctx) => {
    if (!wired) return ctx.skip();
    const url = `http://127.0.0.1:${port}/hook/SECRET-PATH-TOKEN-0123456789`;
    const created = await t.call(
      'POST',
      '/api/v1/notifications/channels',
      { type: 'webhook', name: 'itest', config: { url, secret: 'int-signing-secret' } },
      t.admin,
    );
    expect(created.status).toBe(201);
    expect(created.raw).not.toContain('SECRET-PATH-TOKEN');
    expect(created.raw).not.toContain('int-signing-secret');
    const id = created.body.id as string;

    const test = await t.call('POST', `/api/v1/notifications/channels/${id}/test`, undefined, t.admin);
    expect(test.status).toBe(200);
    expect(test.body).toEqual({ ok: true, httpStatus: 200, error: null });
    expect(test.raw).not.toContain('receiver-response-body');

    expect(received).toHaveLength(1);
    const r = received[0]!;
    expect(r.url).toBe('/hook/SECRET-PATH-TOKEN-0123456789');
    expect(JSON.parse(r.body)).toMatchObject({ type: 'test', severity: 'info' });
    expect(r.headers['x-quaymaster-signature']).toBe(
      `sha256=${createHmac('sha256', 'int-signing-secret').update(r.body).digest('hex')}`,
    );

    for (const path of ['/api/v1/notifications/channels', `/api/v1/notifications/channels/${id}`]) {
      const g = await t.call('GET', path, undefined, t.admin);
      expect(g.status).toBe(200);
      expect(g.raw).not.toContain('SECRET-PATH-TOKEN');
      expect(g.raw).not.toContain('int-signing-secret');
      expect(g.raw).toContain('http://127.0.0.1');
    }

    const d = await t.call(
      'GET',
      `/api/v1/notifications/deliveries?channelId=${id}&limit=5`,
      undefined,
      t.admin,
    );
    expect(d.status).toBe(200);
    expect(d.body[0]).toMatchObject({ eventType: 'test', status: 'sent', httpStatus: 200 });

    const types = await t.call('GET', '/api/v1/notifications/types', undefined, t.admin);
    expect(types.body).toHaveLength(7);

    const bad = await t.call(
      'POST',
      '/api/v1/notifications/channels',
      { type: 'webhook', name: 'meta', config: { url: 'http://169.254.169.254/latest' } },
      t.admin,
    );
    expect(bad.status).toBe(400);

    const del = await t.call('DELETE', `/api/v1/notifications/channels/${id}`, undefined, t.admin);
    expect(del.status).toBe(204);
  });
});
