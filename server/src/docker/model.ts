import type Dockerode from 'dockerode';
import type { ContainerState, ContainerSummary } from '@quaymaster/shared';
import { redactLabels, globalScrubber, collectSecretValues } from '../redaction/redact.js';
import type { Guard } from '../security/guard.js';

export const LABEL = {
  project: 'com.docker.compose.project',
  service: 'com.docker.compose.service',
  workingDir: 'com.docker.compose.project.working_dir',
  configFiles: 'com.docker.compose.project.config_files',
  environmentFile: 'com.docker.compose.project.environment_file',
  configHash: 'com.docker.compose.config-hash',
  version: 'com.docker.compose.version',
  dependsOn: 'com.docker.compose.depends_on',
  containerNumber: 'com.docker.compose.container-number',
  oneoff: 'com.docker.compose.oneoff',
  image: 'com.docker.compose.image',
} as const;

const STATES = new Set<ContainerState>([
  'created',
  'running',
  'paused',
  'restarting',
  'removing',
  'exited',
  'dead',
]);

export function normState(s: string | undefined): ContainerState {
  const v = (s ?? '').toLowerCase() as ContainerState;
  return STATES.has(v) ? v : 'dead';
}

export function healthFromStatus(status: string): ContainerSummary['health'] {
  if (/\(healthy\)/.test(status)) return 'healthy';
  if (/\(unhealthy\)/.test(status)) return 'unhealthy';
  if (/\(health: starting\)/.test(status)) return 'starting';
  return 'none';
}

export const shortId = (id: string): string => id.replace(/^sha256:/, '').slice(0, 12);

/** Valid container/image/volume/network reference as typed by a user: no flags, no path tricks. */
export const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,254}$/;

export function toSummary(c: Dockerode.ContainerInfo, guard: Guard): ContainerSummary {
  const labels = c.Labels ?? {};
  const name = (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, '');
  const project = labels[LABEL.project] ?? null;
  const refusal = guard.containerRefusal({ id: c.Id, name, project });
  return {
    id: c.Id,
    shortId: c.Id.slice(0, 12),
    name,
    image: c.Image,
    imageId: c.ImageID,
    state: normState(c.State),
    status: c.Status,
    health: healthFromStatus(c.Status),
    createdAt: new Date(c.Created * 1000).toISOString(),
    ports: (c.Ports ?? []).map((p) => ({
      ip: p.IP,
      privatePort: p.PrivatePort,
      publicPort: p.PublicPort,
      type: p.Type,
    })),
    labels: redactLabels(labels),
    composeProject: project,
    composeService: labels[LABEL.service] ?? null,
    protectedReason: refusal?.message ?? null,
    mutable: refusal === null,
  };
}

/** Feeds every secret found in `raw` into the process-wide scrubber (used for logs, errors, events). */
export function learnSecrets(raw: unknown, redactAllEnv: boolean): void {
  globalScrubber.addAll(collectSecretValues(raw, { redactAllEnv }));
}
