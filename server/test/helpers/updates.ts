import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { FIXTURES, STACKS_DIR, waitFor, type TestApp } from './app.js';

/** Helpers for the update / maintenance integration tests. Fixtures only (qmtest-* + quaymaster.test=true). */

const script = (name: string, ...args: string[]): string =>
  execFileSync('bash', [path.join(FIXTURES, 'scripts', name), ...args], {
    stdio: 'pipe',
    timeout: 240_000,
    encoding: 'utf8',
  });

/** Starts the fixture registry, publishes v1 of db/app/worker, pulls them and brings qmtest-upd up. */
export const updUp = (): string => script('upd-up.sh');
export const updDown = (): string => script('upd-down.sh');
export const registryDown = (): string => script('registry-down.sh');
export const registryUp = (): string => script('registry-up.sh');

/** Publishes a new "upstream release" of qmtest-<name>:latest to the fixture registry. */
export const publish = (
  name: string,
  version: number | string,
  kind: 'good' | 'unhealthy' | 'crash' = 'good',
): string => script('publish.sh', name, String(version), kind);

export function docker(...args: string[]): string {
  // fixtures only: every caller passes qmtest-* names or inspects (read-only) verbs
  return execFileSync('docker', args, { stdio: 'pipe', encoding: 'utf8', timeout: 120_000 }).trim();
}

export const PROJECT = 'qmtest-upd';
export const IMG = (n: string): string => `127.0.0.1:5055/qmtest-${n}:latest`;

export interface ContainerSnap {
  id: string;
  imageId: string;
  startedAt: string;
  status: string;
  health: string;
}

export function snap(service: string): ContainerSnap {
  const out = docker(
    'inspect',
    '--format',
    '{{.Id}}|{{.Image}}|{{.State.StartedAt}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}',
    `qmtest-upd-${service}-1`,
  );
  const [id, imageId, startedAt, status, health] = out.split('|') as [string, string, string, string, string];
  return { id, imageId, startedAt, status, health };
}

export const snapAll = (): Record<string, ContainerSnap> => ({
  db: snap('db'),
  app: snap('app'),
  worker: snap('worker'),
});

/** The fixture image's version label (from the build), so tests can tell v1 from v2. */
export function versionOf(imageId: string): string {
  return docker(
    'image',
    'inspect',
    '--format',
    '{{index .Config.Labels "qmtest.version"}}-{{index .Config.Labels "qmtest.kind"}}',
    imageId,
  );
}

export async function waitRun(
  t: TestApp,
  id: string,
  timeoutMs = 180_000,
): Promise<{ status: string; [k: string]: unknown }> {
  const finals = new Set([
    'completed',
    'failed',
    'partial',
    'rolled_back',
    'skipped',
    'interrupted',
    'approval_stale',
    'blocked',
    'rejected',
    'planned',
  ]);
  return waitFor(
    async () => {
      const r = await t.call('GET', `/api/v1/maintenance/runs/${id}`, undefined, t.admin);
      return finals.has(r.body.status) ? r.body : null;
    },
    `run ${id} to finish`,
    timeoutMs,
    500,
  );
}

export const stackFile = path.join(STACKS_DIR, 'qmtest-upd', 'compose.yaml');

/** Free text of all steps: `service:step:status` in order. */
export function stepLog(run: {
  steps: { service: string | null; step: string; status: string }[];
}): string[] {
  return run.steps.map((s) => `${s.service ?? '-'}:${s.step}:${s.status}`);
}
