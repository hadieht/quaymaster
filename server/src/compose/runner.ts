import { execFile, type ExecFileException } from 'node:child_process';
import { COMPOSE_LS_ARGV, COMPOSE_VERSION_ARGV, assertSafeArgv, subcommandOf } from './argv.js';
import type { Config } from '../config/env.js';
import type { Guard } from '../security/guard.js';
import { AppError } from '../util/errors.js';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  /** Streamed output (stdout and stderr interleaved as they arrive). */
  onOutput?: (chunk: string) => void;
}

/**
 * The single place that spawns the Docker CLI. Rules:
 * - `execFile` with an argument array; no shell, ever
 * - the subcommand must be on the allow-list, and mutating ones are refused in read-only mode
 * - minimal, documented child environment (PATH, HOME, DOCKER_HOST, LANG) — nothing inherited
 */
export class ComposeRunner {
  private version: string | null = null;

  constructor(
    private readonly d: {
      config: Pick<Config, 'dockerBin' | 'dockerSocket'>;
      guard: Guard;
      /** Overridable for tests. */
      exec?: typeof execFile;
    },
  ) {}

  /** Environment given to every child process. */
  childEnv(): NodeJS.ProcessEnv {
    return {
      PATH: process.env['PATH'] ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: process.env['HOME'] ?? '/root',
      DOCKER_HOST: this.d.config.dockerSocket.startsWith('tcp://')
        ? this.d.config.dockerSocket
        : `unix://${this.d.config.dockerSocket}`,
      LANG: 'C.UTF-8',
      ...(process.env['DOCKER_CONFIG'] ? { DOCKER_CONFIG: process.env['DOCKER_CONFIG'] } : {}),
    };
  }

  /** Runs an already-built argv (everything after the docker binary). */
  async run(argv: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
    if (argv[0] !== 'compose')
      throw new AppError(500, 'internal', 'Runner only executes `docker compose` commands');
    const sub = subcommandOf(argv);
    this.d.guard.assertComposeSubcommand(sub);
    assertSafeArgv(argv, { allowForceRecreate: argv.includes('--force-recreate') });
    return this.exec(argv, opts);
  }

  private exec(argv: readonly string[], opts: RunOptions): Promise<RunResult> {
    const exec = this.d.exec ?? execFile;
    return new Promise((resolve) => {
      const child = exec(
        this.d.config.dockerBin,
        [...argv],
        {
          env: this.childEnv(),
          timeout: opts.timeoutMs ?? 10 * 60_000,
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
        },
        (err: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
          resolve({
            code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
            stdout: String(stdout),
            stderr: String(stderr),
            timedOut: !!err && (err as { killed?: boolean }).killed === true,
          });
        },
      );
      if (opts.onOutput) {
        child.stdout?.on('data', (c: Buffer | string) => opts.onOutput?.(String(c)));
        child.stderr?.on('data', (c: Buffer | string) => opts.onOutput?.(String(c)));
      }
    });
  }

  async composeVersion(): Promise<string | null> {
    if (this.version) return this.version;
    const r = await this.exec(COMPOSE_VERSION_ARGV, { timeoutMs: 15_000 });
    if (r.code === 0) this.version = r.stdout.trim();
    return this.version;
  }

  /** `docker compose ls --all --format json` — label-based, touches no project files. */
  async ls(): Promise<{ Name: string; Status: string; ConfigFiles: string }[]> {
    const r = await this.exec(COMPOSE_LS_ARGV, { timeoutMs: 30_000 });
    if (r.code !== 0) return [];
    try {
      const parsed = JSON.parse(r.stdout) as unknown;
      return Array.isArray(parsed) ? (parsed as { Name: string; Status: string; ConfigFiles: string }[]) : [];
    } catch {
      return [];
    }
  }
}

/** Compose reports unset interpolation variables as warnings; Quaymaster treats them as errors (RT-01). */
export function unsetVariableWarnings(stderr: string): string[] {
  return stderr
    .split('\n')
    .filter((l) => /variable is not set|Defaulting to a blank string/i.test(l))
    .map((l) => l.trim());
}
