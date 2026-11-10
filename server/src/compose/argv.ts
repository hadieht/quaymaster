import { AppError } from '../util/errors.js';

/** Where a Compose invocation is anchored. Every field is passed explicitly (RT-01). */
export interface ComposeTarget {
  projectName: string;
  workingDir: string;
  /** Compose files in recorded order. */
  files: string[];
}

export const SERVICE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export type ComposeCommand =
  | { sub: 'config'; format: 'json' }
  | { sub: 'config'; validateOnly: true }
  | { sub: 'config'; noEnvResolution: true }
  | { sub: 'config'; hash: string[] }
  | { sub: 'ps' }
  | { sub: 'images' }
  | { sub: 'up'; services: string[]; noDeps: boolean; forceRecreate: boolean }
  | { sub: 'stop'; services: string[] }
  | { sub: 'start'; services: string[] }
  | { sub: 'restart'; services: string[] }
  | { sub: 'down' }
  | { sub: 'pull'; services: string[] };

/** Flags that must never appear in an argv we build (RT-28); the runner re-checks this last. */
const FORBIDDEN_FLAGS = [
  '--remove-orphans',
  '-v',
  '--volumes',
  '--rmi',
  '--build',
  '--always-recreate-deps',
  '--renew-anon-volumes',
  '-V',
  '--yes',
  '-y',
];

function validateName(kind: string, value: string, re: RegExp): void {
  if (!re.test(value) || value.startsWith('-')) throw new AppError(400, 'validation', `Invalid ${kind} name`);
}

/**
 * Builds the argv (everything after the `docker` binary) from a fixed template. User-derived
 * values use the `--flag=value` form, and service names come after `--`.
 */
export function buildComposeArgv(t: ComposeTarget, cmd: ComposeCommand): string[] {
  validateName('project', t.projectName, PROJECT_NAME_RE);
  if (t.files.length === 0) throw new AppError(400, 'validation', 'No compose files');
  for (const f of t.files) if (!f.startsWith('/') || f.includes('\0')) throw new AppError(400, 'validation', 'Compose file path must be absolute');
  if (!t.workingDir.startsWith('/')) throw new AppError(400, 'validation', 'Project directory must be absolute');
  const base = [
    'compose',
    '--ansi=never',
    '--progress=plain',
    `--project-name=${t.projectName}`,
    `--project-directory=${t.workingDir}`,
    ...t.files.map((f) => `--file=${f}`),
  ];
  const svc = (services: string[]): string[] => {
    for (const s of services) validateName('service', s, SERVICE_NAME_RE);
    return services.length ? ['--', ...services] : [];
  };
  let argv: string[];
  switch (cmd.sub) {
    case 'config':
      if ('validateOnly' in cmd) argv = [...base, 'config', '--quiet'];
      else if ('noEnvResolution' in cmd) argv = [...base, 'config', '--format=json', '--no-env-resolution'];
      else if ('hash' in cmd) {
        for (const s of cmd.hash) validateName('service', s, SERVICE_NAME_RE);
        argv = [...base, 'config', `--hash=${cmd.hash.length ? cmd.hash.join(',') : '*'}`];
      } else argv = [...base, 'config', '--format=json'];
      break;
    case 'ps':
      argv = [...base, 'ps', '--all', '--format=json'];
      break;
    case 'images':
      argv = [...base, 'images', '--format=json'];
      break;
    case 'up':
      argv = [
        ...base,
        'up',
        '--detach',
        '--no-build',
        '--pull=never',
        ...(cmd.noDeps ? ['--no-deps'] : []),
        ...(cmd.forceRecreate ? ['--force-recreate'] : []),
        ...svc(cmd.services),
      ];
      break;
    case 'stop':
      argv = [...base, 'stop', ...svc(cmd.services)];
      break;
    case 'start':
      argv = [...base, 'start', ...svc(cmd.services)];
      break;
    case 'restart':
      argv = [...base, 'restart', ...svc(cmd.services)];
      break;
    case 'down':
      argv = [...base, 'down']; // never -v / --rmi / --remove-orphans
      break;
    case 'pull':
      argv = [...base, 'pull', ...svc(cmd.services)];
      break;
  }
  assertSafeArgv(argv, { allowForceRecreate: cmd.sub === 'up' && cmd.forceRecreate });
  return argv;
}

/** `docker compose ls --all --format=json`: the only invocation without project flags. */
export const COMPOSE_LS_ARGV: readonly string[] = ['compose', 'ls', '--all', '--format=json'];
export const COMPOSE_VERSION_ARGV: readonly string[] = ['compose', 'version', '--short'];

export function assertSafeArgv(argv: readonly string[], opts: { allowForceRecreate?: boolean } = {}): void {
  const sep = argv.indexOf('--');
  const flags = sep >= 0 ? argv.slice(0, sep) : argv;
  for (const a of flags) {
    const bare = a.split('=')[0] ?? a;
    if (FORBIDDEN_FLAGS.includes(bare)) throw new AppError(500, 'internal', `Forbidden Compose flag ${bare}`);
    if (bare === '--force-recreate' && !opts.allowForceRecreate) {
      throw new AppError(500, 'internal', 'Forbidden Compose flag --force-recreate');
    }
  }
}

/** The Compose subcommand of a built argv (first non-flag token after `compose`). */
export function subcommandOf(argv: readonly string[]): string {
  for (const a of argv.slice(1)) if (!a.startsWith('-')) return a;
  return '';
}
