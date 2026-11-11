import type Dockerode from 'dockerode';
import { AppError } from '../util/errors.js';

/**
 * Config clone for a standalone container (RT-12). `docker inspect` merges the image's defaults into
 * `Config`, so copying it verbatim would pin the OLD image's Env/Cmd/Entrypoint/... onto the new one.
 * Only what differs from the old image's own config is carried over; the new image supplies its defaults.
 * Every mount (anonymous volumes included) is re-attached by volume name so no data is orphaned.
 */

type Inspect = Dockerode.ContainerInspectInfo;
type ImageInspect = Dockerode.ImageInspectInfo;

export interface NetworkAttachment {
  network: string;
  aliases: string[];
  ipv4: string | null;
  ipv6: string | null;
  linkLocalIPs: string[];
  macAddress: string | null;
}

export interface CloneSpec {
  /** Body for `POST /containers/create` (without the name). */
  body: Record<string, unknown>;
  /** Networks other than the one given at create time; connected before start. */
  extraNetworks: NetworkAttachment[];
  /** Human-readable notes for the run record (what was carried over / re-attached). */
  notes: string[];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Throws when the container cannot be cloned safely. */
export function assertCloneable(c: Inspect): void {
  const mode = c.HostConfig?.NetworkMode ?? '';
  if (mode.startsWith('container:'))
    throw new AppError(
      409,
      'unsupported',
      'The container shares another container’s network namespace (container:...); it cannot be cloned safely.',
    );
  if (c.HostConfig?.AutoRemove)
    throw new AppError(
      409,
      'unsupported',
      'The container was started with --rm; stopping it would delete it and there would be nothing to roll back to.',
    );
  if (c.Config?.Labels?.['com.docker.compose.project'])
    throw new AppError(409, 'unsupported', 'Compose-managed containers are updated through Compose.');
}

export function buildCloneSpec(old: Inspect, oldImage: ImageInspect, newImageRef: string): CloneSpec {
  assertCloneable(old);
  const notes: string[] = [];
  const cfg = old.Config;
  const img = (oldImage.Config ?? {}) as Partial<ImageInspect['Config']>;

  // --- Config: keep only what differs from the old image
  const body: Record<string, unknown> = { Image: newImageRef };
  const imgEnv = new Set(img.Env ?? []);
  const env = (cfg.Env ?? []).filter((e) => !imgEnv.has(e));
  if (env.length) body['Env'] = env;
  const keepIfDiffers = (key: 'Cmd' | 'Entrypoint' | 'WorkingDir' | 'User'): boolean => {
    const mine = cfg[key] as unknown;
    const theirs = img[key] as unknown;
    const empty = (v: unknown): boolean => v === null || v === undefined || v === '' || same(v, []);
    if (same(mine, theirs) || (empty(mine) && empty(theirs))) return false;
    body[key] = mine;
    return true;
  };
  const entrypointChanged = keepIfDiffers('Entrypoint');
  const cmdChanged = keepIfDiffers('Cmd');
  // an overridden entrypoint resets the image's default Cmd in the daemon: keep the Cmd explicit then
  if (entrypointChanged && !cmdChanged && cfg.Cmd) body['Cmd'] = cfg.Cmd;
  keepIfDiffers('WorkingDir');
  keepIfDiffers('User');
  const imgLabels = img.Labels ?? {};
  const labels = Object.fromEntries(Object.entries(cfg.Labels ?? {}).filter(([k, v]) => imgLabels[k] !== v));
  if (Object.keys(labels).length) body['Labels'] = labels;
  const hc = (cfg as { Healthcheck?: unknown }).Healthcheck;
  const imgHc = (img as { Healthcheck?: unknown }).Healthcheck;
  if (hc && !same(hc, imgHc)) body['Healthcheck'] = hc;
  const imgPorts = img.ExposedPorts ?? {};
  const ports = Object.fromEntries(Object.entries(cfg.ExposedPorts ?? {}).filter(([k]) => !(k in imgPorts)));
  if (Object.keys(ports).length) body['ExposedPorts'] = ports;
  if (cfg.Tty) body['Tty'] = true;
  if (cfg.OpenStdin) body['OpenStdin'] = true;
  const sig = (cfg as { StopSignal?: string }).StopSignal;
  if (sig && sig !== (img as { StopSignal?: string }).StopSignal) body['StopSignal'] = sig;
  const stopTimeout = (cfg as { StopTimeout?: number }).StopTimeout;
  if (stopTimeout !== undefined && stopTimeout !== null) body['StopTimeout'] = stopTimeout;
  if (cfg.Domainname) body['Domainname'] = cfg.Domainname;
  // an auto-generated hostname is the short container ID: the clone gets its own
  if (cfg.Hostname && cfg.Hostname !== old.Id.slice(0, 12)) body['Hostname'] = cfg.Hostname;
  if (cfg.Hostname && cfg.Hostname !== old.Id.slice(0, 12)) notes.push('explicit hostname kept');

  // --- HostConfig: copied (it holds only explicit settings), with the mounts completed
  const host = JSON.parse(JSON.stringify(old.HostConfig ?? {})) as Record<string, unknown>;
  const declared = new Set<string>([
    ...((host['Binds'] as string[] | undefined) ?? []).map((b) => b.split(':')[1] ?? ''),
    ...((host['Mounts'] as { Target: string }[] | undefined) ?? []).map((m) => m.Target),
    ...Object.keys((host['Tmpfs'] as Record<string, string> | undefined) ?? {}),
  ]);
  const mounts = [...((host['Mounts'] as Record<string, unknown>[] | undefined) ?? [])];
  for (const m of old.Mounts ?? []) {
    if (declared.has(m.Destination)) continue;
    if (m.Type === 'volume' && m.Name) {
      mounts.push({ Type: 'volume', Source: m.Name, Target: m.Destination, ReadOnly: m.RW === false });
      notes.push(`volume ${m.Name} re-attached at ${m.Destination}`);
    } else if (m.Type === 'bind') {
      mounts.push({
        Type: 'bind',
        Source: m.Source,
        Target: m.Destination,
        ReadOnly: m.RW === false,
      });
    }
  }
  if (mounts.length) host['Mounts'] = mounts;
  delete host['ContainerIDFile'];
  delete host['AutoRemove'];
  // old image's Volumes declaration is not copied (the new image declares its own); the mounts above carry the data

  // --- networks: one at create, the rest before start
  const nets = Object.entries(old.NetworkSettings?.Networks ?? {});
  const shortId = old.Id.slice(0, 12);
  const attach = (name: string, n: Dockerode.NetworkInfo): NetworkAttachment => {
    const ipam = (n as { IPAMConfig?: { IPv4Address?: string; IPv6Address?: string; LinkLocalIPs?: string[] } })
      .IPAMConfig;
    return {
      network: name,
      aliases: ((n as { Aliases?: string[] }).Aliases ?? []).filter((a) => a !== shortId && a !== old.Name.slice(1)),
      ipv4: ipam?.IPv4Address ?? null,
      ipv6: ipam?.IPv6Address ?? null,
      linkLocalIPs: ipam?.LinkLocalIPs ?? [],
      macAddress: null,
    };
  };
  const mode = String(host['NetworkMode'] ?? 'default');
  const builtin = ['default', 'bridge', 'host', 'none'].includes(mode);
  const attachments = nets.map(([n, v]) => attach(n, v));
  const primary = attachments.find((a) => a.network === mode) ?? (builtin ? undefined : attachments[0]);
  const extra = attachments.filter((a) => a !== primary && !['host', 'none'].includes(a.network));
  if (primary && !builtin) {
    body['NetworkingConfig'] = {
      EndpointsConfig: {
        [primary.network]: {
          Aliases: primary.aliases,
          ...(primary.ipv4 || primary.ipv6
            ? {
                IPAMConfig: {
                  ...(primary.ipv4 ? { IPv4Address: primary.ipv4 } : {}),
                  ...(primary.ipv6 ? { IPv6Address: primary.ipv6 } : {}),
                },
              }
            : {}),
        },
      },
    };
  } else if (extra.length) {
    // default bridge as primary mode but extra user networks present: those are connected before start
  }
  if (cfg.Hostname !== undefined && (host['NetworkMode'] as string | undefined)?.startsWith('container:')) {
    delete body['Hostname'];
  }
  body['HostConfig'] = host;
  if (extra.length) notes.push(`networks connected before start: ${extra.map((e) => e.network).join(', ')}`);
  return { body, extraNetworks: extra.filter((e) => e.network !== (builtin ? 'bridge' : primary?.network)), notes };
}
