import type Dockerode from 'dockerode';
import type { ImageSummary, NetworkSummary, VolumeSummary } from '@quaymaster/shared';
import type { Config } from '../config/env.js';
import { redactDeep, redactLabels } from '../redaction/redact.js';
import { badRequest, notFound } from '../util/errors.js';
import type { ContainerService } from './containers.js';
import { mapDockerError } from './containers.js';
import { isSafeRef, LABEL, learnSecrets, shortId } from './model.js';
import type { DiskUsageService } from './system.js';

const checkRef = (ref: string, what: 'image' | 'volume' | 'network'): void => {
  if (!isSafeRef(ref, what)) throw badRequest(`Invalid ${what} reference`);
};

/** Read-only image inventory (phase 1: list, inspect, usage). */
export class ImageService {
  constructor(
    private readonly d: {
      docker: Dockerode;
      containers: ContainerService;
      config: Pick<Config, 'redactAllEnv'>;
    },
  ) {}

  async list(): Promise<ImageSummary[]> {
    const [images, containers] = await Promise.all([
      this.d.docker.listImages({ all: false }).catch((e: unknown) => {
        throw mapDockerError(e);
      }),
      this.d.containers.listRaw(),
    ]);
    return images.map((img) => {
      const users = containers.filter((c) => c.ImageID === img.Id);
      const tags = (img.RepoTags ?? []).filter((t) => t !== '<none>:<none>');
      return {
        id: img.Id,
        shortId: shortId(img.Id),
        tags,
        digests: img.RepoDigests ?? [],
        size: img.Size,
        createdAt: new Date(img.Created * 1000).toISOString(),
        containers: users.map((c) => ({
          id: c.Id,
          name: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''),
          state: c.State,
          composeProject: c.Labels?.[LABEL.project] ?? null,
          composeService: c.Labels?.[LABEL.service] ?? null,
        })),
        inUse: users.length > 0,
      };
    });
  }

  async inspect(ref: string): Promise<unknown> {
    checkRef(ref, 'image');
    try {
      const raw = await this.d.docker.getImage(ref).inspect();
      learnSecrets(raw.Config, this.d.config.redactAllEnv);
      return redactDeep(raw, { redactAllEnv: this.d.config.redactAllEnv });
    } catch (e) {
      const m = mapDockerError(e);
      throw m.code === 'not_found' ? notFound('Image') : m;
    }
  }
}

export class VolumeService {
  constructor(
    private readonly d: { docker: Dockerode; containers: ContainerService; usage: DiskUsageService },
  ) {}

  async list(): Promise<VolumeSummary[]> {
    const [res, containers] = await Promise.all([
      this.d.docker.listVolumes().catch((e: unknown) => {
        throw mapDockerError(e);
      }),
      this.d.containers.listRaw(),
    ]);
    const sizes = this.d.usage.cached()?.volumes ?? {};
    return (res.Volumes ?? []).map((v) => {
      const users = containers
        .filter((c) => (c.Mounts ?? []).some((m) => m.Type === 'volume' && m.Name === v.Name))
        .map((c) => (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''));
      const labels = (v.Labels ?? {}) as Record<string, string>;
      return {
        name: v.Name,
        driver: v.Driver,
        mountpoint: v.Mountpoint,
        createdAt: (v as { CreatedAt?: string }).CreatedAt ?? null,
        labels: redactLabels(labels),
        composeProject: labels[LABEL.project] ?? null,
        usedBy: users,
        size: sizes[v.Name] ?? null,
      };
    });
  }

  async inspect(name: string): Promise<unknown> {
    checkRef(name, 'volume');
    try {
      return redactDeep(await this.d.docker.getVolume(name).inspect());
    } catch (e) {
      const m = mapDockerError(e);
      throw m.code === 'not_found' ? notFound('Volume') : m;
    }
  }
}

export class NetworkService {
  constructor(private readonly d: { docker: Dockerode; containers: ContainerService }) {}

  async list(): Promise<NetworkSummary[]> {
    const [nets, containers] = await Promise.all([
      this.d.docker.listNetworks().catch((e: unknown) => {
        throw mapDockerError(e);
      }),
      this.d.containers.listRaw(),
    ]);
    return nets.map((n) => {
      const labels = (n.Labels ?? {}) as Record<string, string>;
      const members = containers
        .filter((c) => {
          const nets = c.NetworkSettings?.Networks ?? {};
          return Object.entries(nets).some(([name, v]) => name === n.Name || v.NetworkID === n.Id);
        })
        .map((c) => (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''));
      return {
        id: n.Id,
        name: n.Name,
        driver: n.Driver,
        scope: n.Scope,
        internal: n.Internal === true,
        composeProject: labels[LABEL.project] ?? null,
        containers: members,
        labels: redactLabels(labels),
      };
    });
  }

  async inspect(ref: string): Promise<unknown> {
    checkRef(ref, 'network');
    try {
      return redactDeep(await this.d.docker.getNetwork(ref).inspect());
    } catch (e) {
      const m = mapDockerError(e);
      throw m.code === 'not_found' ? notFound('Network') : m;
    }
  }
}
