import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type Dockerode from 'dockerode';
import type {
  CapabilityLevel,
  ProjectReason,
  ReasonCode,
  ComposeContainerRef,
  ComposeProjectSummary,
  ComposeServiceInfo,
} from '@quaymaster/shared';
import { LABEL, healthFromStatus, normState } from '../docker/model.js';
import type { Guard } from '../security/guard.js';
import { PROJECT_NAME_RE } from './argv.js';
import { helperDirAllowed, mountHintFor, parseConfigFilesLabel, validateLabelDir } from './labelpath.js';
import type { PathPolicy } from './paths.js';

export interface ScannedProject {
  /** Project name Compose would derive from the directory (lower-case, sanitised). */
  name: string;
  dir: string;
  files: string[];
}

const COMPOSE_FILE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'data', 'volumes']);

/** Compose's default project name for a directory. */
export function deriveProjectName(dir: string): string {
  const base = path
    .basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  return base.replace(/^[^a-z0-9]+/, '');
}

/**
 * Read-only scan of QM_STACK_PATHS for Compose files, so projects that are down remain visible
 * (RT-40). Bounded depth and file count; never follows symlinked directories.
 */
export function scanStackPaths(
  roots: string[],
  limits: { maxDepth: number; maxDirs: number } = { maxDepth: 3, maxDirs: 500 },
): ScannedProject[] {
  const found: ScannedProject[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    if (visited++ >= limits.maxDirs) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    const file = COMPOSE_FILE_NAMES.find((n) => entries.includes(n));
    if (file) {
      const name = deriveProjectName(dir);
      if (PROJECT_NAME_RE.test(name)) found.push({ name, dir, files: [path.join(dir, file)] });
      return; // a project directory: do not descend (nested projects are rare and confusing)
    }
    if (depth >= limits.maxDepth) return;
    for (const e of entries.sort()) {
      if (e.startsWith('.') || SKIP_DIRS.has(e)) continue;
      const p = path.join(dir, e);
      try {
        if (lstatSync(p).isDirectory()) walk(p, depth + 1);
      } catch {
        /* unreadable */
      }
    }
  };
  for (const r of roots) {
    try {
      walk(realpathSync(r), 0);
    } catch {
      /* missing root */
    }
  }
  return found;
}

export interface DiscoveryInput {
  containers: Dockerode.ContainerInfo[];
  ls: { Name: string; Status: string; ConfigFiles: string }[];
  scanned: ScannedProject[];
  policy: PathPolicy;
  guard: Guard;
  /** Whether the read-only file helper can be used (see compose/helper.ts). */
  helper?: { usable: boolean; deniedDirs?: string[] };
  /** Reads a compose file for the remote-include check; null when unreadable. */
  readText?: (file: string) => string | null;
}

const REMOTE_REF_RE = /^\s*(?:-\s*)?(?:path\s*:\s*)?["']?(?:git|oci|https?|ssh):\/\//im;

function defaultRead(file: string): string | null {
  try {
    if (statSync(file).size > 1024 * 1024) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** True when a compose file pulls in remote resources via include/extends (RT-21): such projects are limited. */
export function usesRemoteResources(text: string): boolean {
  const lines = text.split('\n');
  let inInclude = false;
  for (const line of lines) {
    if (/^(include|extends)\s*:/.test(line) || /^\s+extends\s*:/.test(line)) inInclude = true;
    else if (/^\S/.test(line) && !/^\s*#/.test(line)) inInclude = false;
    if (inInclude && REMOTE_REF_RE.test(line)) return true;
    if (/^\s*file\s*:\s*["']?(git|oci|https?):\/\//i.test(line)) return true;
  }
  return false;
}

function aggregateService(name: string, cs: Dockerode.ContainerInfo[]): ComposeServiceInfo {
  const containers: ComposeContainerRef[] = cs.map((c) => ({
    id: c.Id,
    name: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''),
    state: normState(c.State),
    health: healthFromStatus(c.Status),
    imageId: c.ImageID,
    configHash: c.Labels?.[LABEL.configHash] ?? null,
  }));
  const running = containers.filter((c) => c.state === 'running');
  let status: ComposeServiceInfo['status'];
  if (containers.length === 0) status = 'not-created';
  else if (containers.some((c) => c.health === 'unhealthy' || c.state === 'restarting')) status = 'unhealthy';
  else if (running.length === containers.length) status = 'running';
  else if (running.length === 0) status = 'stopped';
  else status = 'partial';
  return {
    name,
    image: cs[0]?.Image ?? null,
    containers,
    status,
    replicas: containers.length,
  };
}

function projectStatus(services: ComposeServiceInfo[]): ComposeProjectSummary['status'] {
  const created = services.filter((s) => s.status !== 'not-created');
  if (created.length === 0) return 'down';
  if (created.some((s) => s.status === 'unhealthy')) return 'unhealthy';
  if (created.every((s) => s.status === 'running')) return 'running';
  if (created.every((s) => s.status === 'stopped')) return 'stopped';
  return 'partial';
}

/**
 * Builds project summaries from labels (untrusted!), `docker compose ls -a` and a filesystem scan,
 * and assigns capability levels (spec 4.2 + RT-02):
 *
 *  full    — recorded paths agree everywhere and realpath under an allowed root (never the Docker root)
 *  limited — containers exist but files cannot be trusted/read here; file operations are refused. The
 *            summary says precisely why (`reasonDetails`, one stable code each) and what could be done.
 *
 * Every Compose project that Docker reports is listed, whatever its path: discovery needs no configuration.
 */
export function buildProjects(input: DiscoveryInput): ComposeProjectSummary[] {
  const { policy, guard } = input;
  const read = input.readText ?? defaultRead;
  const helperUsable = input.helper?.usable === true;
  const byProject = new Map<string, Dockerode.ContainerInfo[]>();
  for (const c of input.containers) {
    const p = c.Labels?.[LABEL.project];
    if (p) byProject.set(p, [...(byProject.get(p) ?? []), c]);
  }
  const lsByName = new Map(input.ls.map((e) => [e.Name, e]));
  const scannedByName = new Map<string, ScannedProject[]>();
  for (const s of input.scanned) scannedByName.set(s.name, [...(scannedByName.get(s.name) ?? []), s]);

  const out: ComposeProjectSummary[] = [];
  const consumedScans = new Set<ScannedProject>();

  for (const [name, cs] of byProject) {
    const reasons: ProjectReason[] = [];
    const add = (code: ReasonCode, message: string, hint?: string): void => {
      reasons.push(hint ? { code, message, hint } : { code, message });
    };
    const dirs = new Set(cs.map((c) => c.Labels?.[LABEL.workingDir] ?? ''));
    const fileSets = new Set(cs.map((c) => c.Labels?.[LABEL.configFiles] ?? ''));
    let workingDir: string | null = null;
    let files: string[] = [];
    let labelsConsistent = true;
    if (dirs.size > 1 || fileSets.size > 1) {
      labelsConsistent = false;
      add(
        'conflict',
        'conflicting labels: containers of this project disagree on working directory or config files',
      );
    }
    const dir0 = [...dirs][0] ?? '';
    const files0 = [...fileSets][0] ?? '';
    if (!dir0 || !files0) {
      labelsConsistent = false;
      add(
        'no_labels',
        'containers carry no working-directory/config-file labels (not created by Docker Compose, or by an old version)',
      );
    } else {
      workingDir = dir0;
      files = parseConfigFilesLabel(files0);
    }
    const lsEntry = lsByName.get(name);
    if (lsEntry && files.length > 0) {
      const lsFiles = parseConfigFilesLabel(lsEntry.ConfigFiles);
      if (lsFiles.join(',') !== files.join(',') && lsFiles.length > 0) {
        labelsConsistent = false;
        add('conflict', '`docker compose ls` reports different config files than the container labels');
      }
    }
    if (!PROJECT_NAME_RE.test(name)) add('unsafe_name', 'unusual project name; refusing file operations');

    const labelDir = workingDir ? validateLabelDir(workingDir) : null;
    const hint = labelDir?.ok ? mountHintFor(labelDir.dir) : null;
    if (workingDir) {
      if (labelDir && !labelDir.ok) {
        add('untrusted', `the recorded working directory is not usable: ${labelDir.reason}`);
      } else {
        const c = policy.check(workingDir);
        if (!c.ok) {
          add(c.code, c.reason, hintFor(c.code, hint?.volume));
        } else {
          for (const f of files) {
            const fc = policy.check(f, { requireReadable: true });
            if (!fc.ok) {
              // the directory is fine, so a vanished file is "missing", not "not mounted"
              if (fc.code === 'not_mounted')
                add(
                  'file_missing',
                  `${f} does not exist in the project directory`,
                  'Restore the file or recreate the project.',
                );
              else add(fc.code, fc.reason, hintFor(fc.code, hint?.volume));
            } else if (usesRemoteResources(read(fc.real) ?? '')) {
              add('remote_include', `${f} uses remote include/extends, which Quaymaster does not follow`);
            }
          }
        }
      }
    }
    const scans = scannedByName.get(name) ?? [];
    let source: ComposeProjectSummary['source'] = 'containers';
    for (const s of scans) {
      const sameDir = workingDir ? safeReal(s.dir) === safeReal(workingDir) : false;
      if (sameDir) {
        consumedScans.add(s);
        source = 'both';
      } else {
        add('duplicate_dir', `another scanned directory also maps to project "${name}"`);
      }
    }
    const byService = new Map<string, Dockerode.ContainerInfo[]>();
    for (const c of cs) {
      const svc = c.Labels?.[LABEL.service] ?? '(unknown)';
      byService.set(svc, [...(byService.get(svc) ?? []), c]);
    }
    const services = [...byService]
      .map(([n, l]) => aggregateService(n, l))
      .sort((a, b) => a.name.localeCompare(b.name));
    const level: CapabilityLevel = reasons.length === 0 ? 'full' : 'limited';
    const refusal = guard.projectRefusal(name);
    // The helper may read a project whose directory looks sane: only for projects Quaymaster manages anyway.
    const helperOk =
      level !== 'full' &&
      helperUsable &&
      labelsConsistent &&
      labelDir?.ok === true &&
      helperDirAllowed(labelDir.dir, input.helper?.deniedDirs ?? []).ok &&
      PROJECT_NAME_RE.test(name) &&
      guard.inScope(name) &&
      !reasons.some((r) => r.code === 'unsafe_name' || r.code === 'untrusted' || r.code === 'remote_include');
    out.push({
      name,
      level,
      reasons: [...new Set(reasons.map((r) => r.message))],
      reasonDetails: dedupe(reasons),
      fileAccess: level === 'full' ? 'local' : helperOk ? 'helper' : 'none',
      mountHint: level !== 'full' && hint ? hint : null,
      workingDir,
      configFiles: files,
      source,
      status: projectStatus(services),
      services,
      composeVersions: [...new Set(cs.map((c) => c.Labels?.[LABEL.version]).filter((v): v is string => !!v))],
      protectedReason: refusal?.message ?? null,
      mutable: refusal === null,
    });
  }

  // Projects visible only on disk (down). They are inside the allow-list by construction.
  for (const s of input.scanned) {
    if (consumedScans.has(s) || byProject.has(s.name)) continue;
    const reasons: ProjectReason[] = [];
    for (const f of s.files) {
      const fc = policy.check(f, { requireReadable: true });
      if (!fc.ok) reasons.push({ code: fc.code, message: fc.reason });
      else if (usesRemoteResources(read(fc.real) ?? ''))
        reasons.push({ code: 'remote_include', message: `${f} uses remote include/extends` });
    }
    if ((scannedByName.get(s.name)?.length ?? 0) > 1)
      reasons.push({
        code: 'duplicate_dir',
        message: `several scanned directories map to project "${s.name}"`,
      });
    const refusal = guard.projectRefusal(s.name);
    out.push({
      name: s.name,
      level: reasons.length === 0 ? 'full' : 'limited',
      reasons: [...new Set(reasons.map((r) => r.message))],
      reasonDetails: dedupe(reasons),
      fileAccess: reasons.length === 0 ? 'local' : 'none',
      mountHint: null,
      workingDir: s.dir,
      configFiles: s.files,
      source: 'scan',
      status: 'down',
      services: [],
      composeVersions: [],
      protectedReason: refusal?.message ?? null,
      mutable: refusal === null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** What the operator can do about a reason. Generic on purpose: no site-specific paths. */
function hintFor(code: ReasonCode, volumeLine: string | undefined): string | undefined {
  const mount = volumeLine
    ? `Add this line to the volumes of the Quaymaster service and recreate it:  ${volumeLine}`
    : undefined;
  switch (code) {
    case 'not_mounted':
      return mount;
    case 'path_not_allowed':
      return volumeLine
        ? `Mount the directory into Quaymaster at the same path (${volumeLine}) or list it in QM_STACK_PATHS.`
        : 'Mount the directory into Quaymaster at the same path or list it in QM_STACK_PATHS.';
    case 'not_readable':
      return 'Make the project files readable by the user Quaymaster runs as (for example chmod g+r and a shared group).';
    case 'untrusted':
      return 'Use a real directory inside the mounted path (no symlinks that leave it) and keep it out of the Docker data root.';
    default:
      return undefined;
  }
}

function dedupe(list: ProjectReason[]): ProjectReason[] {
  const seen = new Set<string>();
  return list.filter((r) => {
    const k = `${r.code}|${r.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
