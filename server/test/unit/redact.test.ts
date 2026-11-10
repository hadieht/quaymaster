import { describe, expect, it } from 'vitest';
import {
  MASK,
  Scrubber,
  collectSecretValues,
  isSecretKey,
  looksLikeSecretValue,
  maskUrlToSchemeHost,
  redactArgv,
  redactDeep,
  redactEnvEntry,
  redactLabels,
  redactText,
  redactUrl,
} from '../../src/redaction/redact.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';

describe('isSecretKey', () => {
  it.each([
    'PASSWORD', 'db_pass', 'MYSQL_PWD', 'client_secret', 'API_TOKEN', 'api-key', 'X-Api-Key', 'credentials',
    'AUTHORIZATION', 'PRIVATE_KEY', 'tls.cert', 'SENTRY_DSN', 'connection_string', 'Cookie', 'SESSION_ID',
    'HASH_SALT', 'signature', 'DISCORD_WEBHOOK', 'WG_PSK', 'SEED', 'MNEMONIC', 'passphrase', 'TOTP_OTP',
    'bearer', 'APIKEY', 'ACCESS_KEY_ID', 'LICENSE_KEY', 'ENCRYPTION', 'HMAC_SECRET', 'traefik.tls.certresolver',
  ])('%s is secret', (k) => expect(isSecretKey(k)).toBe(true));

  it.each(['TZ', 'PUID', 'LANG', 'PATH', 'HOSTNAME', 'Image', 'Id', 'com.docker.compose.project', 'WORKDIR'])(
    '%s is not secret',
    (k) => expect(isSecretKey(k)).toBe(false),
  );

  it('allow-lists harmless keys that match the pattern', () => {
    expect(isSecretKey('com.docker.compose.config-hash')).toBe(false);
    expect(isSecretKey('SandboxKey')).toBe(false);
    expect(isSecretKey('org.opencontainers.image.licenses')).toBe(false);
  });
});

describe('looksLikeSecretValue', () => {
  it('detects JWT, PEM, known prefixes', () => {
    expect(looksLikeSecretValue(JWT)).toBe(true);
    expect(looksLikeSecretValue(PEM)).toBe(true);
    expect(looksLikeSecretValue('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe(true);
    expect(looksLikeSecretValue('AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(looksLikeSecretValue('xoxb-1234567890-abcdefghij')).toBe(true);
    expect(looksLikeSecretValue('sk-abcdefghijklmnopqrstuvwx')).toBe(true);
  });
  it('detects long high-entropy strings', () => {
    expect(looksLikeSecretValue('aZ3kQ9xLp2Wd7VbN4mTr8YcHs1UfEjGo')).toBe(true);
    expect(looksLikeSecretValue('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')).toBe(true);
  });
  it('does not flag ordinary values, digests, UUIDs', () => {
    expect(looksLikeSecretValue('Europe/Berlin')).toBe(false);
    expect(looksLikeSecretValue('/var/lib/some/very/long/path/name')).toBe(false);
    expect(looksLikeSecretValue('sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')).toBe(false);
    expect(looksLikeSecretValue('123e4567-e89b-12d3-a456-426614174000')).toBe(false);
    expect(looksLikeSecretValue('short')).toBe(false);
    expect(looksLikeSecretValue('this-is-a-normal-hostname-value')).toBe(false);
    expect(looksLikeSecretValue(MASK)).toBe(false);
  });
});

describe('redactUrl', () => {
  it('masks userinfo only', () => {
    expect(redactUrl('postgres://admin:hunter2@db:5432/app')).toBe(`postgres://${MASK}@db:5432/app`);
    expect(redactUrl('https://token@example.org/x')).toBe(`https://${MASK}@example.org/x`);
  });
  it('masks secret query parameters but keeps the rest', () => {
    expect(redactUrl('https://x.org/a?user=bob&password=p1&token=t2&page=3')).toBe(
      `https://x.org/a?user=bob&password=${MASK}&token=${MASK}&page=3`,
    );
    expect(redactUrl('mysql://h/db?sslkey=abc&sig=zzz')).toBe(`mysql://h/db?sslkey=${MASK}&sig=${MASK}`);
  });
  it('masks webhook tokens held in the path', () => {
    expect(redactUrl('https://discord.com/api/webhooks/123456/AbCdEf_tok-en')).toBe(
      `https://discord.com/api/webhooks/123456/${MASK}`,
    );
    expect(redactUrl('https://hooks.slack.com/services/T000/B000/XXXXXXXX')).toBe(
      `https://hooks.slack.com/services/${MASK}/${MASK}/${MASK}`,
    );
    expect(redactUrl('https://api.telegram.org/bot123456:ABCdefGhIJKlmNoPQRsTUVwxyZ123456789/sendMessage')).toBe(
      `https://api.telegram.org/bot${MASK}/sendMessage`,
    );
    expect(redactUrl('https://hooks.example.org/in/aZ3kQ9xLp2Wd7VbN4mTr8YcHs1UfEjGo')).toBe(
      `https://hooks.example.org/in/${MASK}`,
    );
  });
  it('leaves plain URLs alone and is idempotent', () => {
    expect(redactUrl('https://example.org/path?a=1')).toBe('https://example.org/path?a=1');
    const once = redactUrl('postgres://a:b@h/db?password=x');
    expect(redactUrl(once)).toBe(once);
  });
  it('maskUrlToSchemeHost shows only scheme and host', () => {
    expect(maskUrlToSchemeHost('https://user:pw@ntfy.example.org/secret-topic?auth=1')).toBe(
      `https://ntfy.example.org/${MASK}`,
    );
    expect(maskUrlToSchemeHost('not a url')).toBe(MASK);
  });
  it('reports secrets to the sink', () => {
    const seen: string[] = [];
    redactUrl('postgres://admin:hunter2@db/x?token=abc', (s) => seen.push(s));
    expect(seen).toContain('hunter2');
    expect(seen).toContain('abc');
  });
});

describe('redactText', () => {
  it('masks PEM blocks, JWTs and token prefixes', () => {
    expect(redactText(`key follows ${PEM} end`)).not.toContain('MIIEvQ');
    expect(redactText(`auth ${JWT}`)).not.toContain('eyJhbGci');
    expect(redactText('token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok')).not.toContain('ghp_abc');
    expect(redactText('Authorization: Bearer abcdef0123456789xyz')).toBe(`Authorization: Bearer ${MASK}`);
  });
  it('masks secret-named flags in both forms (RT-04 command strings)', () => {
    expect(redactText('/app --password=hunter2 --port=80')).toBe(`/app --password=${MASK} --port=80`);
    expect(redactText('/app --password hunter2 --port 80')).toBe(`/app --password ${MASK} --port 80`);
    expect(redactText('mysql -uroot --password="a b" db')).toContain(MASK);
    expect(redactText('mysql -uroot --password="a b" db')).not.toContain('a b');
  });
  it('masks NAME=value assignments, including exec command lines of events', () => {
    expect(redactText('/bin/sh -c curl -u user:pass http://x -H X=1')).toBeTypeOf('string');
    expect(redactText('/bin/sh -c MYSQL_PWD=sekrit mysqladmin ping')).toBe(`/bin/sh -c MYSQL_PWD=${MASK} mysqladmin ping`);
    expect(redactText('DATABASE_URL=postgres://u:p@h/db?password=zz')).not.toMatch(/zz|:p@/);
  });
  it('masks JSON-ish key/value pairs', () => {
    expect(redactText('{"apiKey": "abc123def", "name": "x"}')).toBe(`{"apiKey": "${MASK}", "name": "x"}`);
  });
  it('masks URLs in prose and keeps trailing punctuation', () => {
    expect(redactText('see https://u:p@host/x.')).toBe(`see https://${MASK}@host/x.`);
  });
  it('is idempotent and leaves harmless text alone', () => {
    const t = 'container started on port 8080 at /srv/data';
    expect(redactText(t)).toBe(t);
    const r = redactText('password=abc');
    expect(redactText(r)).toBe(r);
  });
});

describe('env entries and argv', () => {
  it('redactEnvEntry masks by key, by value shape, and with redactAllEnv', () => {
    expect(redactEnvEntry('DB_PASSWORD=pw')).toBe(`DB_PASSWORD=${MASK}`);
    expect(redactEnvEntry('TZ=Europe/Berlin')).toBe('TZ=Europe/Berlin');
    expect(redactEnvEntry(`BLOB=${JWT}`)).toBe(`BLOB=${MASK}`);
    expect(redactEnvEntry('TZ=UTC', { redactAllEnv: true })).toBe(`TZ=${MASK}`);
    expect(redactEnvEntry('EMPTY_PASSWORD=')).toBe('EMPTY_PASSWORD=');
    expect(redactEnvEntry('not-an-assignment')).toBe('not-an-assignment');
  });
  it('redactArgv masks the token after a secret-named flag', () => {
    expect(redactArgv(['--user', 'bob', '--password', 'x', '--port', '80'])).toEqual([
      '--user', 'bob', '--password', MASK, '--port', '80',
    ]);
    expect(redactArgv(['--api-key=abc'])).toEqual([`--api-key=${MASK}`]);
    expect(redactArgv(['--token', '--verbose'])).toEqual(['--token', '--verbose']);
    expect(redactArgv(['run', 'SECRET_X=1'])).toEqual(['run', `SECRET_X=${MASK}`]);
    expect(redactArgv(['x', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'])).toEqual(['x', MASK]);
  });
  it('redactLabels masks secret keys and secret-shaped values', () => {
    const out = redactLabels({
      'traefik.http.middlewares.auth.basicauth.users': 'admin:$apr1$xyz',
      'com.docker.compose.config-hash': 'aaaabbbbccccdddd',
      'com.example.note': 'hello',
      'x.y': 'aZ3kQ9xLp2Wd7VbN4mTr8YcHs1UfEjGo',
    });
    expect(out['traefik.http.middlewares.auth.basicauth.users']).toBe(MASK);
    expect(out['com.docker.compose.config-hash']).toBe('aaaabbbbccccdddd');
    expect(out['com.example.note']).toBe('hello');
    expect(out['x.y']).toBe(MASK);
  });
});

describe('redactDeep (whole-object walk)', () => {
  it('redacts at every depth, regardless of section', () => {
    const input = {
      Id: 'a'.repeat(64),
      Config: {
        Env: ['TZ=UTC', 'DB_PASSWORD=s3cret', `TOKEN2=${JWT}`],
        Cmd: ['serve', '--password', 'hunter2'],
        Labels: { 'app.secret': 'v', 'app.note': 'ok' },
        Healthcheck: { Test: ['CMD-SHELL', 'curl -u admin:pw123 http://localhost/ || exit 1'] },
      },
      HostConfig: { LogConfig: { Type: 'splunk', Config: { 'splunk-token': 'tok-123', 'splunk-url': 'https://u:p@s/' } } },
      NetworkSettings: { SandboxKey: '/var/run/docker/netns/abc' },
      deep: { a: { b: { c: { dsn: 'https://k@o1.ingest.sentry.io/1' } } } },
    };
    const out = redactDeep(input);
    const s = JSON.stringify(out);
    for (const leak of ['s3cret', 'hunter2', 'tok-123', 'pw123', ':p@', JWT, 'k@o1']) expect(s).not.toContain(leak);
    expect(out.Config.Env[0]).toBe('TZ=UTC');
    expect(out.Config.Labels['app.note']).toBe('ok');
    expect(out.Id).toBe('a'.repeat(64));
    expect(out.NetworkSettings.SandboxKey).toBe('/var/run/docker/netns/abc');
  });
  it('does not mutate its input, keeps numbers/booleans/null', () => {
    const input = { password: 'x', n: 5, b: true, z: null, PrivatePort: 80, nested: { token: 1234 } };
    const copy = JSON.parse(JSON.stringify(input));
    const out = redactDeep(input) as typeof input;
    expect(input).toEqual(copy);
    expect(out.n).toBe(5);
    expect(out.b).toBe(true);
    expect(out.z).toBeNull();
    expect(out.PrivatePort).toBe(80);
    expect(out.nested.token).toBe(MASK);
  });
  it('masks everything below a secret-named container', () => {
    const out = redactDeep({ credentials: { user: 'a', list: ['b', 'c'] } });
    expect(JSON.stringify(out)).not.toMatch(/"a"|"b"|"c"/);
  });
  it('handles Compose-style config: environment maps, build args, extension fields, inline content', () => {
    const cfg = {
      'x-common': { environment: { API_KEY: 'k-123', MODE: 'prod' } },
      services: {
        app: {
          environment: { DATABASE_URL: 'postgres://u:pw@db/app?sslmode=require&password=qq', MODE: 'prod', BLOB: JWT },
          build: { args: { NPM_TOKEN: 'npm-abc', NODE_VERSION: '22' } },
          command: 'serve --password=hunter2 --port 80',
          healthcheck: { test: ['CMD', 'curl', '-u', 'a:b', '--header', 'X-Token: t0k3n', 'http://x'] },
          labels: ['note=ok', 'secret.label=zzz'],
          secrets: ['db_password'],
        },
      },
      secrets: { db_password: { file: './pw.txt' }, inline: { content: 'inline-secret-body' } },
      configs: { c: { content: 'api_key: abc' } },
    };
    const out = redactDeep(cfg);
    const s = JSON.stringify(out);
    for (const leak of ['k-123', 'pw@', 'qq', 'npm-abc', 'hunter2', 't0k3n', 'zzz', 'inline-secret-body', 'abc"', JWT]) {
      expect(s, leak).not.toContain(leak);
    }
    expect(out.services.app.environment.MODE).toBe('prod');
    expect(out.services.app.build.args.NODE_VERSION).toBe('22');
    expect(out.services.app.secrets).toEqual(['db_password']);
    expect(out.secrets.db_password.file).toBe('./pw.txt');
  });
  it('QM_REDACT_ALL_ENV masks every env value but not labels', () => {
    const out = redactDeep(
      { Env: ['A=1', 'B=two'], environment: { C: 'three' }, Labels: { l: 'keep' } },
      { redactAllEnv: true },
    );
    expect(out.Env).toEqual([`A=${MASK}`, `B=${MASK}`]);
    expect(out.environment.C).toBe(MASK);
    expect(out.Labels.l).toBe('keep');
  });
  it('is bounded for cyclic-depth input', () => {
    let o: Record<string, unknown> = { v: 'x' };
    for (let i = 0; i < 100; i++) o = { n: o };
    expect(() => redactDeep(o)).not.toThrow();
  });
  it('is idempotent', () => {
    const once = redactDeep({ Env: ['A_SECRET=1'], x: 'https://u:p@h/' });
    expect(redactDeep(once)).toEqual(once);
  });
});

describe('Docker event shaped data (RT-04)', () => {
  it('masks exec command lines and secret labels in actor attributes', () => {
    const ev = {
      Type: 'container',
      Action: 'exec_start: /bin/sh -c curl -u user:pass1 --header "Authorization: Bearer abcdefgh12345678" http://x',
      Actor: { ID: 'f'.repeat(64), Attributes: { name: 'web', 'app.token': 'tok-999', image: 'nginx' } },
    };
    const s = JSON.stringify(redactDeep(ev));
    expect(s).not.toContain('abcdefgh12345678');
    expect(s).not.toContain('tok-999');
  });
});

describe('collectSecretValues and Scrubber (known-value scrubbing)', () => {
  const doc = {
    Env: ['DB_PASSWORD=Sup3r@S3cret', 'TZ=UTC'],
    Cmd: ['--api-key', 'k_9876543210'],
    url: 'postgres://u:pw-in-url@h/x',
  };
  it('collects literal secret values', () => {
    const v = collectSecretValues(doc);
    expect(v).toEqual(expect.arrayContaining(['Sup3r@S3cret', 'k_9876543210', 'pw-in-url']));
    expect(v).not.toContain('UTC');
  });
  it('scrubs literals, url-encoded and JSON-escaped forms from free text', () => {
    const sc = new Scrubber();
    sc.addAll(collectSecretValues(doc));
    const text = 'error: auth failed for Sup3r@S3cret / Sup3r%40S3cret / "k_9876543210" ok TZ=UTC';
    const out = sc.scrub(text);
    expect(out).not.toMatch(/Sup3r(@|%40)S3cret/);
    expect(out).not.toContain('k_9876543210');
    expect(out).toContain('TZ=UTC');
  });
  it('ignores trivial and short values, longest match first', () => {
    const sc = new Scrubber();
    sc.add('1');
    sc.add('true');
    sc.add('ab');
    expect(sc.size).toBe(0);
    sc.add('hunter');
    sc.add('hunter2');
    expect(sc.scrub('x hunter2 y')).toBe(`x ${MASK} y`);
  });
  it('clean() applies both scrubbing and text rules', () => {
    const sc = new Scrubber();
    sc.add('plainvalue');
    expect(sc.clean('plainvalue and --token=abc')).toBe(`${MASK} and --token=${MASK}`);
  });
});
