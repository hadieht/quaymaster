import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { NotificationEvent } from '@quaymaster/shared';
import { AuditRepo } from '../../src/db/audit.js';
import { openDatabase } from '../../src/db/connection.js';
import { SecretStore } from '../../src/db/stats.js';
import { SecretBox } from '../../src/crypto/secretbox.js';
import { AuditService } from '../../src/audit/audit.js';
import { MASK } from '../../src/redaction/redact.js';
import { AppError } from '../../src/util/errors.js';
import type {
  MailOptions,
  NotificationChannel,
  OutboundRequest,
  Transport,
} from '../../src/notifications/channel.js';
import {
  OutboundHttp,
  disallowedAddressReason,
  validateOutboundUrl,
} from '../../src/notifications/outbound.js';
import { ChannelRegistry, defaultRegistry } from '../../src/notifications/registry.js';
import { BACKOFF_MS, NotificationService } from '../../src/notifications/service.js';
import { discordChannel } from '../../src/notifications/channels/discord.js';
import { gotifyChannel } from '../../src/notifications/channels/gotify.js';
import { ntfyChannel } from '../../src/notifications/channels/ntfy.js';
import { slackChannel } from '../../src/notifications/channels/slack.js';
import { smtpChannel } from '../../src/notifications/channels/smtp.js';
import { telegramChannel } from '../../src/notifications/channels/telegram.js';
import { webhookChannel } from '../../src/notifications/channels/webhook.js';

const ACTOR = { name: 'tester', ip: '127.0.0.1' };
const EV: NotificationEvent = {
  type: 'container.died',
  severity: 'warning',
  title: 'Container web died',
  message: 'exit code 137',
  data: { container: 'web', code: 137 },
  ts: 1_700_000_000_000,
};

class FakeTransport implements Transport {
  requests: OutboundRequest[] = [];
  mails: MailOptions[] = [];
  status = 200;
  throwError: Error | null = null;
  request(req: OutboundRequest): Promise<{ status: number }> {
    this.requests.push(req);
    if (this.throwError) return Promise.reject(this.throwError);
    return Promise.resolve({ status: this.status });
  }
  sendMail(opts: MailOptions): Promise<void> {
    this.mails.push(opts);
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------------------------
// Outbound policy
// ---------------------------------------------------------------------------------------------

describe('validateOutboundUrl', () => {
  const bad = (u: string, re: RegExp): void => {
    try {
      validateOutboundUrl(u);
      throw new Error('expected rejection');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(400);
      expect((e as AppError).message).toMatch(re);
      // the URL (a secret as a whole) is never echoed
      expect((e as AppError).message).not.toContain('SECRETPATH');
    }
  };

  it('rejects non-http(s) schemes and userinfo', () => {
    bad('ftp://example.com/SECRETPATH', /http/);
    bad('file:///etc/passwd', /http/);
    bad('javascript:alert(1)', /http/);
    bad('http://user:pw@example.com/SECRETPATH', /credentials/);
    bad('http://user@example.com/SECRETPATH', /credentials/);
    bad('not a url SECRETPATH', /Invalid URL/);
  });

  it('rejects cloud metadata, unspecified, link-local v6 and multicast literals', () => {
    bad('http://169.254.169.254/latest/meta-data/SECRETPATH', /not allowed/);
    bad('http://169.254.1.1/SECRETPATH', /link-local/);
    bad('http://0.0.0.0:8080/SECRETPATH', /unspecified/);
    bad('http://[::]/SECRETPATH', /unspecified/);
    bad('http://[fe80::1]/SECRETPATH', /link-local/);
    bad('http://[febf::1]/SECRETPATH', /link-local/);
    bad('http://224.0.0.1/SECRETPATH', /multicast/);
    bad('http://[ff02::1]/SECRETPATH', /multicast/);
    bad('http://[::ffff:169.254.169.254]/SECRETPATH', /not allowed/);
  });

  it('allows loopback, RFC1918 and public hosts', () => {
    for (const u of [
      'http://127.0.0.1:8080/x',
      'http://[::1]:8080/x',
      'http://localhost/x',
      'http://192.168.1.10:2586/topic',
      'http://10.0.0.5/x',
      'http://172.16.3.4/x',
      'https://ntfy.example.com/topic',
      'http://[::ffff:192.168.1.1]/x',
    ]) {
      expect(validateOutboundUrl(u)).toBeInstanceOf(URL);
    }
    expect(disallowedAddressReason('127.0.0.1')).toBeNull();
    expect(disallowedAddressReason('fd00::1')).toBeNull();
  });
});

describe('OutboundHttp', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  });
  async function serve(h: http.RequestListener): Promise<{ base: string; port: number }> {
    const s = http.createServer(h);
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as AddressInfo).port;
    return { base: `http://127.0.0.1:${port}`, port };
  }

  it('returns only the status code and posts the body', async () => {
    let got = '';
    let method = '';
    const { base } = await serve((req, res) => {
      method = req.method ?? '';
      req.on('data', (c: Buffer) => (got += c.toString()));
      req.on('end', () => {
        res.statusCode = 202;
        res.end('{"secret":"response-body-must-not-leak"}');
      });
    });
    const r = await new OutboundHttp().request({ url: `${base}/hook`, method: 'POST', body: '{"a":1}' });
    expect(method).toBe('POST');
    expect(got).toBe('{"a":1}');
    expect(r.status).toBe(202);
    expect(Object.keys(r).sort()).toEqual(['bytesRead', 'redirects', 'status', 'truncated']);
    expect(JSON.stringify(r)).not.toContain('response-body');
  });

  it('caps the response body at 64 KiB', async () => {
    const { base } = await serve((_req, res) => {
      res.statusCode = 200;
      const chunk = Buffer.alloc(16 * 1024, 120);
      let n = 0;
      const pump = (): void => {
        while (n < 200) {
          n++;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        res.end();
      };
      pump();
    });
    const r = await new OutboundHttp().request({ url: `${base}/big`, method: 'POST', body: 'x' });
    expect(r.status).toBe(200);
    expect(r.truncated).toBe(true);
    // stopped reading shortly after the cap, far below the 3.2 MB the server wanted to send
    expect(r.bytesRead).toBeGreaterThan(64 * 1024);
    expect(r.bytesRead).toBeLessThan(1024 * 1024);
  });

  it('follows same-host redirects (max 3) and refuses other hosts', async () => {
    let hits = 0;
    const { base, port } = await serve((req, res) => {
      if (req.url === '/a') {
        res.writeHead(302, { location: '/b' });
        return void res.end();
      }
      if (req.url === '/b') {
        hits++;
        res.statusCode = 200;
        return void res.end('ok');
      }
      if (req.url === '/other') {
        res.writeHead(302, { location: `http://localhost:${port}/b` }); // same IP, different host name
        return void res.end();
      }
      if (req.url?.startsWith('/loop')) {
        res.writeHead(302, { location: `/loop${Date.now()}${Math.random()}` });
        return void res.end();
      }
      res.statusCode = 404;
      res.end();
    });
    const c = new OutboundHttp();
    const ok = await c.request({ url: `${base}/a`, method: 'POST', body: '{}' });
    expect(ok.status).toBe(200);
    expect(ok.redirects).toBe(1);
    expect(hits).toBe(1);

    await expect(c.request({ url: `${base}/other`, method: 'POST', body: '{}' })).rejects.toThrow(
      /different host refused/,
    );
    await expect(c.request({ url: `${base}/loop`, method: 'GET' })).rejects.toThrow(/Too many redirects/);
  });

  it('errors never contain the full URL and unreachable ports fail cleanly', async () => {
    const { base } = await serve((_q, res) => res.end());
    const url = `${base}/TOKEN-abcdef-0123456789`;
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
    const err = await new OutboundHttp().request({ url, method: 'POST', body: '{}' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('TOKEN-abcdef');
    expect((err as Error).message).toContain('http://127.0.0.1');
  });

  it('times out', async () => {
    const { base } = await serve(() => {
      /* never answers */
    });
    const t0 = Date.now();
    const err = await new OutboundHttp({ timeoutMs: 200 })
      .request({ url: `${base}/SECRETTOKEN`, method: 'POST', body: '{}' })
      .catch((e: Error) => e);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect((err as Error).message).toMatch(/timed out/);
    expect((err as Error).message).not.toContain('SECRETTOKEN');
  });

  it('refuses a literal metadata IP before connecting', async () => {
    await expect(
      new OutboundHttp().request({ url: 'http://169.254.169.254/latest', method: 'GET' }),
    ).rejects.toThrow(/not allowed/);
  });
});

// ---------------------------------------------------------------------------------------------
// Channel request shapes
// ---------------------------------------------------------------------------------------------

describe('channels', () => {
  it('webhook: JSON body, HMAC over the exact body, timestamp, extra headers', async () => {
    const t = new FakeTransport();
    const cfg = webhookChannel.parseConfig({
      url: 'https://hooks.example.com/in/TOKEN123456',
      secret: 'shh-secret',
      headers: { 'X-Api-Key': 'k1' },
    });
    const res = await webhookChannel.send(cfg, EV, t);
    expect(res).toEqual({ ok: true, httpStatus: 200, error: null });
    const r = t.requests[0]!;
    expect(r.url).toBe('https://hooks.example.com/in/TOKEN123456');
    expect(r.method).toBe('POST');
    const body = JSON.parse(r.body!) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['data', 'message', 'severity', 'time', 'title', 'type']);
    expect(body).toMatchObject({
      type: 'container.died',
      severity: 'warning',
      title: EV.title,
      data: EV.data,
    });
    expect(body['time']).toBe(new Date(EV.ts!).toISOString());
    const expected = createHmac('sha256', 'shh-secret').update(r.body!).digest('hex');
    expect(r.headers!['X-Quaymaster-Signature']).toBe(`sha256=${expected}`);
    expect(r.headers!['X-Quaymaster-Timestamp']).toBe(String(Math.floor(EV.ts! / 1000)));
    expect(r.headers!['X-Api-Key']).toBe('k1');
    expect(r.headers!['content-type']).toBe('application/json');
  });

  it('webhook: no signature without secret; reserved headers and bad urls rejected; non-2xx is failure', async () => {
    const t = new FakeTransport();
    t.status = 500;
    const cfg = webhookChannel.parseConfig({ url: 'http://10.0.0.5/hook' });
    const res = await webhookChannel.send(cfg, EV, t);
    expect(res).toEqual({ ok: false, httpStatus: 500, error: 'HTTP 500' });
    expect(t.requests[0]!.headers!['X-Quaymaster-Signature']).toBeUndefined();
    expect(() =>
      webhookChannel.parseConfig({ url: 'http://x.example/', headers: { 'X-Quaymaster-Signature': 'a' } }),
    ).toThrow(AppError);
    try {
      webhookChannel.parseConfig({ url: 'http://169.254.169.254/' });
      throw new Error('expected rejection');
    } catch (e) {
      expect((e as AppError).status).toBe(400);
      expect(JSON.stringify((e as AppError).details)).toContain('not allowed');
    }
    expect(() => webhookChannel.parseConfig({ url: 'http://x.example/', bogus: 1 })).toThrow(AppError);
  });

  it('ntfy: topic URL, bearer token, priority 3/4/5, Title and Tags headers', async () => {
    const t = new FakeTransport();
    const cfg = ntfyChannel.parseConfig({
      serverUrl: 'http://192.168.1.5:2586/',
      topic: 'alerts',
      token: 'tk_abc',
    });
    for (const [severity, prio] of [
      ['info', '3'],
      ['warning', '4'],
      ['critical', '5'],
    ] as const) {
      await ntfyChannel.send(cfg, { ...EV, severity }, t);
      expect(t.requests.at(-1)!.headers!['Priority']).toBe(prio);
    }
    const r = t.requests[2]!;
    expect(r.url).toBe('http://192.168.1.5:2586/alerts');
    expect(r.headers!['Authorization']).toBe('Bearer tk_abc');
    expect(r.headers!['Title']).toBe(EV.title);
    expect(r.headers!['Tags']).toContain('rotating_light');
    expect(r.body).toBe(EV.message);
    // non-ASCII titles are encoded, never raw
    await ntfyChannel.send(cfg, { ...EV, title: 'Café ☕\r\nX-Evil: 1' }, t);
    expect(t.requests.at(-1)!.headers!['Title']).toMatch(/^=\?UTF-8\?B\?/);
    // no token -> no Authorization
    const anon = ntfyChannel.parseConfig({ serverUrl: 'https://ntfy.sh', topic: 'x' });
    await ntfyChannel.send(anon, EV, t);
    expect(t.requests.at(-1)!.headers!['Authorization']).toBeUndefined();
  });

  it('gotify: /message with key header and priority mapping', async () => {
    const t = new FakeTransport();
    const cfg = gotifyChannel.parseConfig({ serverUrl: 'http://gotify.lan:8080', appToken: 'AppTok123' });
    await gotifyChannel.send(cfg, { ...EV, severity: 'critical' }, t);
    const r = t.requests[0]!;
    expect(r.url).toBe('http://gotify.lan:8080/message');
    expect(r.url).not.toContain('AppTok123');
    expect(r.headers!['X-Gotify-Key']).toBe('AppTok123');
    expect(JSON.parse(r.body!)).toMatchObject({ title: EV.title, message: EV.message, priority: 8 });
    await gotifyChannel.send(cfg, { ...EV, severity: 'info' }, t);
    expect((JSON.parse(t.requests[1]!.body!) as { priority: number }).priority).toBe(3);
  });

  it('discord: embed with severity colour and no mention parsing', async () => {
    const t = new FakeTransport();
    const cfg = discordChannel.parseConfig({ url: 'https://discord.com/api/webhooks/1/tok' });
    const colors: number[] = [];
    for (const severity of ['info', 'warning', 'critical'] as const) {
      await discordChannel.send(cfg, { ...EV, severity }, t);
      const b = JSON.parse(t.requests.at(-1)!.body!) as {
        embeds: {
          color: number;
          title: string;
          description: string;
          fields: { name: string; value: string }[];
        }[];
        allowed_mentions: { parse: string[] };
      };
      colors.push(b.embeds[0]!.color);
      expect(b.allowed_mentions.parse).toEqual([]);
      expect(b.embeds[0]!.title).toBe(EV.title);
      expect(b.embeds[0]!.fields).toContainEqual(expect.objectContaining({ name: 'code', value: '137' }));
    }
    expect(new Set(colors).size).toBe(3);
  });

  it('slack: attachment colour + blocks, mrkdwn escaped', async () => {
    const t = new FakeTransport();
    const cfg = slackChannel.parseConfig({ url: 'https://hooks.slack.com/services/T0/B0/XXXX' });
    await slackChannel.send(cfg, { ...EV, severity: 'critical', message: '<!channel> a & b' }, t);
    const b = JSON.parse(t.requests[0]!.body!) as {
      text: string;
      attachments: { color: string; blocks: { type: string; text?: { text: string } }[] }[];
    };
    expect(b.attachments[0]!.color).toBe('#e01e5a');
    expect(b.attachments[0]!.blocks.map((x) => x.type)).toEqual(['header', 'section', 'section', 'context']);
    expect(b.attachments[0]!.blocks[1]!.text!.text).toBe('&lt;!channel&gt; a &amp; b');
  });

  it('telegram: token in the URL path, apiBase override, chat id in body', async () => {
    const t = new FakeTransport();
    const cfg = telegramChannel.parseConfig({ botToken: '123:ABC-def', chatId: '-100123' });
    await telegramChannel.send(cfg, EV, t);
    expect(t.requests[0]!.url).toBe('https://api.telegram.org/bot123:ABC-def/sendMessage');
    expect(JSON.parse(t.requests[0]!.body!)).toMatchObject({ chat_id: '-100123' });
    const local = telegramChannel.parseConfig({
      botToken: '1:x',
      chatId: '5',
      apiBase: 'http://127.0.0.1:9999/',
    });
    await telegramChannel.send(local, EV, t);
    expect(t.requests[1]!.url).toBe('http://127.0.0.1:9999/bot1:x/sendMessage');
    expect(() => telegramChannel.parseConfig({ botToken: 'a/b', chatId: '5' })).toThrow(AppError);
  });

  it('smtp: builds the mail through the transport facade', async () => {
    const t = new FakeTransport();
    const cfg = smtpChannel.parseConfig({
      host: 'mail.lan',
      port: 587,
      username: 'u',
      password: 'p',
      from: 'qm@example.com',
      to: ['a@example.com', 'b@example.com'],
    });
    expect(cfg.secure).toBe(false);
    const res = await smtpChannel.send(cfg, EV, t);
    expect(res.ok).toBe(true);
    expect(t.mails[0]).toMatchObject({
      host: 'mail.lan',
      port: 587,
      secure: false,
      username: 'u',
      password: 'p',
      from: 'qm@example.com',
      to: ['a@example.com', 'b@example.com'],
      subject: '[WARNING] Container web died',
    });
    expect(t.mails[0]!.text).toContain('container: web');
    expect(() => smtpChannel.parseConfig({ host: 'h', port: 25, from: 'bad', to: [] })).toThrow(AppError);
  });

  it('smtp: a failing mailer yields a failed SendResult, not an exception', async () => {
    const t = new FakeTransport();
    t.sendMail = () => Promise.reject(new Error('connection refused'));
    const cfg = smtpChannel.parseConfig({ host: 'h', port: 25, from: 'a@b.co', to: ['c@d.co'] });
    expect(await smtpChannel.send(cfg, EV, t)).toEqual({
      ok: false,
      httpStatus: null,
      error: 'connection refused',
    });
  });

  it('registry has all seven types with secret flags on URL/token fields', () => {
    const reg = defaultRegistry();
    expect(
      reg
        .list()
        .map((c) => c.type)
        .sort(),
    ).toEqual(['discord', 'gotify', 'ntfy', 'slack', 'smtp', 'telegram', 'webhook'].sort());
    expect(() => reg.register(webhookChannel)).toThrow(/already registered/);
    const secret = (type: string): string[] =>
      reg
        .get(type)!
        .fields.filter((f) => f.secret)
        .map((f) => f.name);
    expect(secret('webhook')).toContain('url');
    expect(secret('discord')).toEqual(['url']);
    expect(secret('telegram')).toEqual(['botToken']);
    expect(secret('smtp')).toEqual(['password']);
  });
});

// ---------------------------------------------------------------------------------------------
// Service (DB-backed)
// ---------------------------------------------------------------------------------------------

function harness(opts: { registry?: ChannelRegistry } = {}) {
  const opened = openDatabase(':memory:');
  const db = opened.db;
  const secrets = new SecretStore(db, new SecretBox(Buffer.alloc(32, 7)));
  const audit = new AuditService(new AuditRepo(db));
  const transport = new FakeTransport();
  const clock = { now: 1_700_000_000_000 };
  const svc = new NotificationService({
    db,
    secrets,
    audit,
    log: pino({ level: 'silent' }),
    transport,
    clock: () => clock.now,
    ...(opts.registry ? { registry: opts.registry } : {}),
  });
  const mkWebhook = (name = 'hook', extra: Record<string, unknown> = {}) =>
    svc.createChannel(
      {
        type: 'webhook',
        name,
        config: { url: `https://hooks.example.com/${name}/TOKEN-SECRET-123456`, secret: 'sig-secret' },
        ...extra,
      },
      ACTOR,
    );
  return { db, secrets, audit, transport, clock, svc, mkWebhook, close: () => opened.close() };
}

describe('NotificationService', () => {
  it('stores config encrypted and masks secrets in API output', () => {
    const h = harness();
    const ch = h.mkWebhook('main');
    const row = h.db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(ch.id) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(row)).not.toContain('TOKEN-SECRET');
    expect(row['secret_name']).toBe(`notify:${ch.id}`);
    const ct = (
      h.db.prepare('SELECT ciphertext FROM secret_store WHERE name = ?').get(`notify:${ch.id}`) as {
        ciphertext: string;
      }
    ).ciphertext;
    expect(ct).not.toContain('TOKEN-SECRET');
    expect(h.secrets.get(`notify:${ch.id}`)).toContain('TOKEN-SECRET');

    const listed = JSON.stringify(h.svc.listChannels());
    expect(listed).not.toContain('TOKEN-SECRET');
    expect(listed).not.toContain('sig-secret');
    expect(h.svc.getChannel(ch.id).config).toEqual({
      url: 'https://hooks.example.com/••••••',
      secret: MASK,
    });
    h.close();
  });

  it('masks non-secret fields as-is and secret ones fully (smtp, telegram)', () => {
    const h = harness();
    const smtp = h.svc.createChannel(
      {
        type: 'smtp',
        name: 'mail',
        config: {
          host: 'mail.lan',
          port: 25,
          username: 'u',
          password: 'pw-123456',
          from: 'a@b.co',
          to: ['c@d.co'],
        },
      },
      ACTOR,
    );
    expect(smtp.config).toMatchObject({
      host: 'mail.lan',
      port: 25,
      username: 'u',
      password: MASK,
      to: ['c@d.co'],
    });
    const tg = h.svc.createChannel(
      { type: 'telegram', name: 'tg', config: { botToken: '123:BOTSECRET', chatId: '42' } },
      ACTOR,
    );
    expect(JSON.stringify(tg)).not.toContain('BOTSECRET');
    expect(tg.config['chatId']).toBe('42');
    h.close();
  });

  it('update keeps omitted secret fields, accepts masked echo, null removes optional keys', async () => {
    const h = harness();
    const ch = h.mkWebhook('u');
    h.svc.updateChannel(ch.id, { name: 'renamed', config: { url: ch.config['url'], secret: MASK } }, ACTOR);
    // masked echo of url would be invalid (not a secret-masked skip for url?) -> url is a secret field, so kept
    expect(h.secrets.get(`notify:${ch.id}`)).toContain('TOKEN-SECRET-123456');
    expect(h.secrets.get(`notify:${ch.id}`)).toContain('sig-secret');
    expect(h.svc.getChannel(ch.id).name).toBe('renamed');

    h.svc.updateChannel(ch.id, { config: { headers: { 'X-A': 'b' } } }, ACTOR);
    h.svc.updateChannel(ch.id, { config: { secret: null } }, ACTOR);
    const stored = JSON.parse(h.secrets.get(`notify:${ch.id}`)!) as Record<string, unknown>;
    expect(stored['secret']).toBeUndefined();
    expect(stored['headers']).toEqual({ 'X-A': 'b' });
    expect(stored['url']).toContain('TOKEN-SECRET-123456');

    // invalid patch is rejected and leaves the old value
    expect(() => h.svc.updateChannel(ch.id, { config: { url: 'http://169.254.169.254/x' } }, ACTOR)).toThrow(
      AppError,
    );
    expect(h.secrets.get(`notify:${ch.id}`)).toContain('TOKEN-SECRET-123456');

    await h.svc.testChannel(ch.id, ACTOR);
    expect(h.transport.requests.at(-1)!.url).toContain('TOKEN-SECRET-123456');
    h.close();
  });

  it('create validates (type, name unique, events, severity) and delete removes the secret', () => {
    const h = harness();
    const ch = h.mkWebhook('dup');
    expect(() => h.mkWebhook('dup')).toThrow(/already exists/);
    expect(() => h.svc.createChannel({ type: 'nope' as 'webhook', name: 'x', config: {} }, ACTOR)).toThrow(
      /Unknown channel type/,
    );
    expect(() => h.mkWebhook('e', { events: ['bogus'] })).toThrow(/Unknown event/);
    expect(() => h.mkWebhook('s', { minSeverity: 'loud' })).toThrow(/severity/);
    h.svc.deleteChannel(ch.id, ACTOR);
    expect(h.secrets.get(`notify:${ch.id}`)).toBeUndefined();
    expect(() => h.svc.getChannel(ch.id)).toThrow(/not found/);
    h.close();
  });

  it('audits create/update/delete/test without config values', async () => {
    const h = harness();
    const ch = h.mkWebhook('aud');
    h.svc.updateChannel(ch.id, { enabled: false }, ACTOR);
    await h.svc.testChannel(ch.id, ACTOR);
    h.svc.deleteChannel(ch.id, ACTOR);
    const rows = h.audit.list({ limit: 50 });
    const actions = rows.map((r) => r.action).filter((a) => a.startsWith('notifications.'));
    expect(actions.sort()).toEqual(
      [
        'notifications.channel.create',
        'notifications.channel.delete',
        'notifications.channel.test',
        'notifications.channel.update',
      ].sort(),
    );
    expect(JSON.stringify(rows)).not.toContain('TOKEN-SECRET');
    expect(JSON.stringify(rows)).not.toContain('sig-secret');
    h.close();
  });

  it('testChannel returns ok/status/short error only and logs a delivery', async () => {
    const h = harness();
    const ch = h.mkWebhook('t');
    expect(await h.svc.testChannel(ch.id, ACTOR)).toEqual({ ok: true, httpStatus: 200, error: null });
    expect(h.transport.requests[0]!.body).toContain('"type":"test"');
    h.transport.status = 502;
    expect(await h.svc.testChannel(ch.id, ACTOR)).toEqual({ ok: false, httpStatus: 502, error: 'HTTP 502' });
    h.transport.throwError = new Error('boom https://hooks.example.com/t/TOKEN-SECRET-123456 failed');
    const r = await h.svc.testChannel(ch.id, ACTOR);
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain('TOKEN-SECRET');
    expect(h.svc.listDeliveries({ channelId: ch.id }).map((d) => d.status)).toEqual([
      'failed',
      'failed',
      'sent',
    ]);
    h.close();
  });

  it('delivers to enabled channels filtered by event type and min severity', async () => {
    const h = harness();
    const all = h.mkWebhook('all');
    const some = h.mkWebhook('some', { events: ['run.failed'] });
    const crit = h.mkWebhook('crit', { minSeverity: 'critical' });
    const off = h.mkWebhook('off', { enabled: false });
    h.svc.emit({ ...EV, type: 'container.died', severity: 'warning' });
    await h.svc.flush();
    const sent = (id: string): number => h.svc.listDeliveries({ channelId: id }).length;
    expect([sent(all.id), sent(some.id), sent(crit.id), sent(off.id)]).toEqual([1, 0, 0, 0]);
    expect(h.transport.requests).toHaveLength(1);

    h.svc.emit({ ...EV, type: 'run.failed', severity: 'critical', title: 'other' });
    await h.svc.flush();
    expect([sent(all.id), sent(some.id), sent(crit.id), sent(off.id)]).toEqual([2, 1, 1, 0]);
    h.close();
  });

  it('de-duplicates within the cool-down, per channel, per key; sends again afterwards', async () => {
    const h = harness();
    const a = h.mkWebhook('a');
    const b = h.mkWebhook('b', { events: ['run.failed'] });
    const emit = async (e: Partial<NotificationEvent> = {}): Promise<void> => {
      h.svc.emit({ ...EV, ...e });
      await h.svc.flush();
    };
    await emit();
    expect(h.transport.requests).toHaveLength(1);
    h.clock.now += 60_000;
    await emit(); // same key within 15 min -> suppressed
    expect(h.transport.requests).toHaveLength(1);
    const rows = h.svc.listDeliveries({ channelId: a.id });
    expect(rows.map((r) => r.status)).toEqual(['suppressed', 'sent']);
    expect(h.svc.suppressedCount(a.id, `${EV.type}:${EV.title}`)).toBe(1);

    await emit({ title: 'different title' }); // different key
    expect(h.transport.requests).toHaveLength(2);
    await emit({ dedupeKey: 'custom' });
    await emit({ dedupeKey: 'custom' });
    expect(h.transport.requests).toHaveLength(3);

    // per channel: b only subscribes to run.failed, and has its own dedupe state
    await emit({ type: 'run.failed', title: 'F' });
    expect(h.transport.requests).toHaveLength(5); // a and b
    await emit({ type: 'run.failed', title: 'F' });
    expect(h.transport.requests).toHaveLength(5);
    expect(h.svc.listDeliveries({ channelId: b.id }).map((r) => r.status)).toEqual(['suppressed', 'sent']);

    // after the cool-down it is sent again
    h.clock.now += 15 * 60_000 + 1;
    await emit();
    expect(h.transport.requests).toHaveLength(6);
    h.close();
  });

  it('critical events use a 5 min default cool-down; event cooldownMs overrides', async () => {
    const h = harness();
    h.mkWebhook('c');
    const emit = async (e: Partial<NotificationEvent>): Promise<void> => {
      h.svc.emit({ ...EV, severity: 'critical', ...e });
      await h.svc.flush();
    };
    await emit({});
    h.clock.now += 5 * 60_000 + 1;
    await emit({});
    expect(h.transport.requests).toHaveLength(2);
    h.clock.now += 1000;
    await emit({});
    expect(h.transport.requests).toHaveLength(2);
    h.clock.now += 2000;
    await emit({ cooldownMs: 1000 });
    expect(h.transport.requests).toHaveLength(3);
    h.close();
  });

  it('retries with exponential backoff + jitter and ends in dead after 5 attempts', async () => {
    const h = harness();
    const ch = h.mkWebhook('r');
    h.transport.status = 500;
    h.svc.emit(EV);
    await h.svc.flush();
    let d = h.svc.listDeliveries({ channelId: ch.id })[0]!;
    expect(d).toMatchObject({ status: 'failed', attempts: 1, httpStatus: 500, lastError: 'HTTP 500' });

    for (let attempt = 1; attempt <= 4; attempt++) {
      d = h.svc.listDeliveries({ channelId: ch.id })[0]!;
      const delay = new Date(d.nextAttemptAt!).getTime() - h.clock.now;
      const base = BACKOFF_MS[attempt - 1]!;
      expect(delay).toBeGreaterThanOrEqual(base * 0.8 - 1);
      expect(delay).toBeLessThanOrEqual(base * 1.2 + 1);
      // not due yet
      expect(await h.svc.processRetries()).toBe(0);
      h.clock.now = new Date(d.nextAttemptAt!).getTime();
      expect(await h.svc.processRetries()).toBe(1);
      d = h.svc.listDeliveries({ channelId: ch.id })[0]!;
      expect(d.attempts).toBe(attempt + 1);
    }
    expect(d.status).toBe('dead');
    expect(d.nextAttemptAt).toBeNull();
    expect(h.transport.requests).toHaveLength(5);
    expect(await h.svc.processRetries()).toBe(0);
    h.close();
  });

  it('a retry that succeeds ends in sent', async () => {
    const h = harness();
    const ch = h.mkWebhook('ok');
    h.transport.status = 503;
    h.svc.emit(EV);
    await h.svc.flush();
    h.transport.status = 200;
    h.clock.now += 3_600_000;
    expect(await h.svc.processRetries()).toBe(1);
    expect(h.svc.listDeliveries({ channelId: ch.id })[0]).toMatchObject({
      status: 'sent',
      attempts: 2,
      nextAttemptAt: null,
      lastError: null,
    });
    h.close();
  });

  it('emit() never throws and never blocks, even when channels or the DB blow up', async () => {
    const boom: NotificationChannel<unknown> = {
      type: 'webhook',
      label: 'boom',
      fields: [],
      parseConfig: (raw) => raw,
      send: () => {
        throw new Error('channel exploded with TOKEN-SECRET-123456');
      },
    };
    const reg = new ChannelRegistry().register(boom);
    const h = harness({ registry: reg });
    const ch = h.mkWebhook('boom');
    let returned: unknown = 'unset';
    expect(() => {
      returned = h.svc.emit(EV);
    }).not.toThrow();
    expect(returned).toBeUndefined();
    expect(h.transport.requests).toHaveLength(0); // nothing happened synchronously
    await h.svc.flush();
    const d = h.svc.listDeliveries({ channelId: ch.id })[0]!;
    expect(d.status).toBe('failed');
    expect(d.lastError).toContain('channel exploded');
    expect(d.lastError).not.toContain('TOKEN-SECRET');

    h.db.exec('DROP TABLE notification_deliveries');
    expect(() => h.svc.emit({ ...EV, title: 'again' })).not.toThrow();
    await expect(h.svc.flush()).resolves.toBeUndefined();
    h.close();
  });

  it('persists a redacted event_json and sends redacted text', async () => {
    const h = harness();
    const ch = h.mkWebhook('red');
    h.svc.emit({
      type: 'app.error',
      severity: 'critical',
      title: 'Pull failed for registry password=hunter2hunter2',
      message:
        'curl -u admin:s3cretPass https://x.example/?token=abcdef123456 failed; DB_PASSWORD=topsecretvalue',
      data: { password: 'datapass-9999', image: 'nginx', note: 'uses TOKEN-SECRET-123456' },
    });
    await h.svc.flush();
    const row = h.db.prepare('SELECT event_json, title FROM notification_deliveries').get() as {
      event_json: string;
      title: string;
    };
    for (const leak of [
      'hunter2hunter2',
      's3cretPass',
      'abcdef123456',
      'topsecretvalue',
      'datapass-9999',
      'TOKEN-SECRET',
    ]) {
      expect(row.event_json).not.toContain(leak);
      expect(row.title).not.toContain(leak);
      expect(h.transport.requests[0]!.body).not.toContain(leak);
    }
    expect(row.event_json).toContain('nginx');
    expect(ch.id).toBeTruthy();
    h.close();
  });

  it('listDeliveries paginates with beforeId and reports channel names', async () => {
    const h = harness();
    const ch = h.mkWebhook('p');
    for (let i = 0; i < 3; i++) {
      h.svc.emit({ ...EV, title: `t${i}` });
      await h.svc.flush();
    }
    const page1 = h.svc.listDeliveries({ limit: 2 });
    expect(page1.map((d) => d.title)).toEqual(['t2', 't1']);
    expect(page1[0]!.channelName).toBe('p');
    const page2 = h.svc.listDeliveries({ limit: 2, beforeId: page1[1]!.id });
    expect(page2.map((d) => d.title)).toEqual(['t0']);
    h.svc.deleteChannel(ch.id, ACTOR);
    expect(h.svc.listDeliveries({})[0]!.channelName).toBeNull();
    h.close();
  });

  it("start/stop manage an unref'd timer", () => {
    const h = harness();
    h.svc.start(10_000);
    h.svc.start(10_000);
    h.svc.stop();
    h.svc.stop();
    expect(h.svc.types()).toHaveLength(7);
    h.close();
  });
});
