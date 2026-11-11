import { describe, expect, it } from 'vitest';
import type { DockerEventRecord, NotificationEvent } from '@quaymaster/shared';
import { assertCloneable, buildCloneSpec } from '../../src/maintenance/clone.js';
import { AdjustableClock } from '../../src/maintenance/clock.js';
import { DEFAULT_MONITOR_SETTINGS, Monitors } from '../../src/monitor/monitors.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- hand-built partial inspect documents */

const ID = 'a'.repeat(64);
const oldImage: any = {
  Config: {
    Env: ['PATH=/usr/bin', 'APP_VERSION=1.2'],
    Cmd: ['serve'],
    Entrypoint: ['/entry.sh'],
    WorkingDir: '/app',
    User: '',
    Labels: { 'org.example.version': '1.2' },
    ExposedPorts: { '80/tcp': {} },
  },
};
const container = (over: any = {}): any => ({
  Id: ID,
  Name: '/web',
  Config: {
    Hostname: ID.slice(0, 12),
    Env: ['PATH=/usr/bin', 'APP_VERSION=1.2', 'TOKEN_X=abc', 'MODE=prod'],
    Cmd: ['serve'],
    Entrypoint: ['/entry.sh'],
    WorkingDir: '/app',
    User: '',
    Labels: { 'org.example.version': '1.2', owner: 'me' },
    ExposedPorts: { '80/tcp': {}, '9000/tcp': {} },
    Tty: false,
    ...over.Config,
  },
  HostConfig: {
    NetworkMode: 'appnet',
    Binds: ['/srv/conf:/conf:ro'],
    PortBindings: { '80/tcp': [{ HostPort: '8080' }] },
    RestartPolicy: { Name: 'unless-stopped' },
    AutoRemove: false,
    ...over.HostConfig,
  },
  Mounts: [
    { Type: 'bind', Source: '/srv/conf', Destination: '/conf', RW: false },
    {
      Type: 'volume',
      Name: 'anon123',
      Source: '/var/lib/docker/volumes/anon123/_data',
      Destination: '/data',
      RW: true,
    },
    { Type: 'volume', Name: 'named', Destination: '/named', RW: true },
  ],
  NetworkSettings: {
    Networks: {
      appnet: { Aliases: ['web', ID.slice(0, 12), 'api'], IPAMConfig: { IPv4Address: '172.30.0.10' } },
      other: { Aliases: [ID.slice(0, 12)] },
    },
  },
  ...over.top,
});

describe('standalone config clone (RT-12)', () => {
  it('keeps only what differs from the OLD image and lets the new image supply its defaults', () => {
    const spec = buildCloneSpec(container(), oldImage, 'repo/web:latest');
    const b = spec.body as any;
    expect(b.Image).toBe('repo/web:latest');
    expect(b.Env).toEqual(['TOKEN_X=abc', 'MODE=prod']); // image Env (PATH, APP_VERSION) NOT copied
    expect(b.Cmd).toBeUndefined();
    expect(b.Entrypoint).toBeUndefined();
    expect(b.WorkingDir).toBeUndefined();
    expect(b.Labels).toEqual({ owner: 'me' });
    expect(b.ExposedPorts).toEqual({ '9000/tcp': {} });
    expect(b.Hostname).toBeUndefined(); // auto-generated hostname is the short ID
  });

  it('re-attaches anonymous and named volumes by name, keeps explicit binds once', () => {
    const spec = buildCloneSpec(container(), oldImage, 'repo/web:latest');
    const hc = spec.body['HostConfig'] as any;
    expect(hc.Binds).toEqual(['/srv/conf:/conf:ro']);
    const mounts = hc.Mounts as { Type: string; Source: string; Target: string }[];
    expect(mounts.map((m) => `${m.Type}:${m.Source}:${m.Target}`).sort()).toEqual([
      'volume:anon123:/data',
      'volume:named:/named',
    ]);
    expect(hc.AutoRemove).toBeUndefined();
    expect(hc.PortBindings).toEqual({ '80/tcp': [{ HostPort: '8080' }] });
    expect(spec.notes.join()).toMatch(/anon123/);
  });

  it('keeps static IPs and aliases (minus the auto alias) and connects further networks later', () => {
    const spec = buildCloneSpec(container(), oldImage, 'repo/web:latest');
    const ep = (spec.body['NetworkingConfig'] as any).EndpointsConfig.appnet;
    expect(ep.Aliases).toEqual(['api']);
    expect(ep.IPAMConfig).toEqual({ IPv4Address: '172.30.0.10' });
    expect(spec.extraNetworks.map((n) => n.network)).toEqual(['other']);
  });

  it('keeps an overridden entrypoint together with its command', () => {
    const spec = buildCloneSpec(container({ Config: { Entrypoint: ['/custom'] } }), oldImage, 'r:1');
    expect((spec.body as any).Entrypoint).toEqual(['/custom']);
    expect((spec.body as any).Cmd).toEqual(['serve']);
  });

  it('refuses containers that cannot be cloned safely', () => {
    expect(() => assertCloneable(container({ HostConfig: { NetworkMode: 'container:abc' } }))).toThrow(
      /namespace/,
    );
    expect(() => assertCloneable(container({ HostConfig: { AutoRemove: true } }))).toThrow(/--rm/);
    expect(() =>
      assertCloneable(container({ Config: { Labels: { 'com.docker.compose.project': 'p' } } })),
    ).toThrow(/Compose/);
  });
});

describe('monitors', () => {
  const ev = (over: Partial<DockerEventRecord>): DockerEventRecord => ({
    id: 1,
    time: new Date().toISOString(),
    type: 'container',
    action: 'die',
    actorId: 'c1'.padEnd(64, '0'),
    name: 'web',
    image: null,
    project: null,
    service: null,
    attributes: { exitCode: '1' },
    synthetic: false,
    ...over,
  });
  const make = (
    opts: { busy?: boolean; host?: any; schedules?: any[]; avail?: any[]; kv?: Map<string, string> } = {},
  ) => {
    const sent: NotificationEvent[] = [];
    const kv = opts.kv ?? new Map<string, string>();
    const clock = new AdjustableClock();
    const announced: number[] = [];
    const m = new Monitors({
      kv: { get: (k: string) => kv.get(k) ?? null, set: (k: string, v: string) => void kv.set(k, v) } as any,
      system: { host: async () => opts.host ?? null } as any,
      schedules: { list: () => opts.schedules ?? [] } as any,
      updates: { statuses: async () => opts.avail ?? [] } as any,
      maintenance: { announceUpdates: (a: unknown[]) => announced.push(a.length) } as any,
      notify: (e) => void sent.push(e),
      maintenanceBusy: () => opts.busy === true,
      clock,
      log: { error: () => undefined } as any,
    });
    return { m, sent, clock, announced };
  };

  it('reports a container that died unexpectedly, but not a deliberate stop or a clean exit', () => {
    const { m, sent } = make();
    m.onDockerEvent(ev({ action: 'die', attributes: { exitCode: '0' } }));
    m.onDockerEvent(ev({ action: 'stop', actorId: 'd'.repeat(64) }));
    m.onDockerEvent(ev({ action: 'die', actorId: 'd'.repeat(64) }));
    expect(sent).toEqual([]);
    m.onDockerEvent(ev({ action: 'die' }));
    expect(sent.map((s) => s.type)).toEqual(['container.died']);
  });

  it('detects restart loops and unhealthy containers; stays quiet while a maintenance run owns the lock', () => {
    const { m, sent } = make();
    for (let i = 0; i < DEFAULT_MONITOR_SETTINGS.restartLoopCount; i++)
      m.onDockerEvent(ev({ action: 'die' }));
    expect(sent.at(-1)?.type).toBe('container.restart_loop');
    m.onDockerEvent(ev({ action: 'health_status', attributes: { health: 'unhealthy' } }));
    expect(sent.at(-1)?.type).toBe('container.unhealthy');
    const busy = make({ busy: true });
    busy.m.onDockerEvent(ev({ action: 'die' }));
    expect(busy.sent).toEqual([]);
  });

  it('flags sustained high CPU only after the sustain period', () => {
    const { m, sent, clock } = make();
    const point = { cpu: 99, memUsage: 1, memLimit: 100 } as any;
    m.onSample({ id: 'x', name: 'web', point });
    expect(sent).toEqual([]);
    clock.advance((DEFAULT_MONITOR_SETTINGS.sustainSeconds + 1) * 1000);
    m.onSample({ id: 'x', name: 'web', point });
    expect(sent.map((s) => s.type)).toEqual(['host.cpu_high']);
  });

  it('poll: low disk, upcoming maintenance and available updates (once per interval)', async () => {
    const { m, sent, announced } = make({
      host: {
        dockerRoot: { free: 1024 ** 3, total: 100 * 1024 ** 3 },
        memAvailable: 50,
        memTotal: 100,
        cpuPercent: 1,
      },
      schedules: [
        {
          id: 's1',
          name: 'nightly',
          cron: '* * * * *',
          timezone: 'UTC',
          jobType: 'update',
          mode: 'auto',
          selector: { project: 'p' },
          enabled: true,
        },
      ],
      avail: [{ ref: 'r', state: 'update_available', remoteDigest: 'sha256:1', usedBy: [] }],
    });
    await m.poll();
    const types = sent.map((s) => s.type);
    expect(types).toContain('host.disk_low');
    expect(types).toContain('maintenance.upcoming');
    expect(announced).toEqual([1]);
    await m.poll();
    expect(announced).toEqual([1]); // not re-announced inside the interval
  });
});
