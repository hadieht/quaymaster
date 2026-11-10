import Docker from 'dockerode';
import type { Config } from '../config/env.js';
import { AppError } from '../util/errors.js';
import { enforceOnModem, type Guard } from '../security/guard.js';

/** Highest Engine API version Quaymaster has been tested against (RT-31). */
export const TESTED_MAX_API = '1.55';
/** Lowest API version the code relies on. */
export const REQUIRED_MIN_API = '1.40';

export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * API version negotiation: use min(daemon, tested max). Refuse when the daemon is too old for the
 * code, or when its minimum supported version is newer than the newest version we have tested.
 */
export function negotiateApiVersion(
  daemon: { ApiVersion: string; MinAPIVersion?: string },
  testedMax = TESTED_MAX_API,
  required = REQUIRED_MIN_API,
): string {
  if (cmpVersion(daemon.ApiVersion, required) < 0) {
    throw new AppError(
      503,
      'docker_unavailable',
      `Docker Engine API ${daemon.ApiVersion} is older than the minimum Quaymaster supports (${required})`,
    );
  }
  if (daemon.MinAPIVersion && cmpVersion(daemon.MinAPIVersion, testedMax) > 0) {
    throw new AppError(
      503,
      'docker_unavailable',
      `Docker daemon requires API >= ${daemon.MinAPIVersion}, newer than the newest version Quaymaster is tested with (${testedMax})`,
    );
  }
  return cmpVersion(daemon.ApiVersion, testedMax) < 0 ? daemon.ApiVersion : testedMax;
}

export interface DockerHandle {
  docker: Docker;
  apiVersion: string;
  daemonApiVersion: string;
  engineVersion: string;
}

/**
 * Creates the dockerode client with (1) transport-level enforcement of read-only mode and
 * authorised mutations and (2) API version negotiation. The first request is unversioned
 * (`GET /version`), after which the negotiated version prefix is pinned.
 */
export async function connectDocker(
  config: Pick<Config, 'dockerSocket'>,
  guard: Guard,
): Promise<DockerHandle> {
  const docker = new Docker({ socketPath: config.dockerSocket });
  enforceOnModem(docker.modem as never, guard);
  let v: Awaited<ReturnType<Docker['version']>>;
  try {
    v = (await docker.version()) as typeof v;
  } catch (e) {
    throw new AppError(
      503,
      'docker_unavailable',
      `Cannot reach the Docker daemon at ${config.dockerSocket}: ${(e as Error).message}`,
    );
  }
  const extra = v as unknown as { MinAPIVersion?: string };
  const chosen = negotiateApiVersion({ ApiVersion: v.ApiVersion, MinAPIVersion: extra.MinAPIVersion });
  (docker.modem as unknown as { version: string }).version = `v${chosen}`;
  return { docker, apiVersion: chosen, daemonApiVersion: v.ApiVersion, engineVersion: v.Version };
}
