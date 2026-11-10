import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Dockerode from 'dockerode';
import { AuditService } from './audit/audit.js';
import { LoginLimiter } from './auth/limiter.js';
import { AuthService } from './auth/service.js';
import { SetupService } from './auth/setup.js';
import { ComposeRunner } from './compose/runner.js';
import { ComposeService } from './compose/service.js';
import { PathPolicy } from './compose/paths.js';
import type { Config } from './config/env.js';
import { PasswordService } from './crypto/password.js';
import { SecretBox } from './crypto/secretbox.js';
import { acquireInstanceLock, openDatabase, type Db } from './db/connection.js';
import { AuditRepo } from './db/audit.js';
import { EventsRepo } from './db/events.js';
import { OperationsRepo } from './db/operations.js';
import { SessionsRepo } from './db/sessions.js';
import { KvRepo, SecretStore, StatsRepo } from './db/stats.js';
import { UsersRepo } from './db/users.js';
import { connectDocker, type DockerHandle } from './docker/client.js';
import { ContainerService } from './docker/containers.js';
import { EventWatcher } from './docker/events.js';
import { ImageService, NetworkService, VolumeService } from './docker/inventory.js';
import { StatsSampler } from './docker/stats.js';
import { DiskUsageService, SystemService } from './docker/system.js';
import { DEFAULT_SSE_LIMITS, SseHub } from './http/sse.js';
import { OperationManager } from './operations/manager.js';
import { Guard } from './security/guard.js';
import { detectSelf } from './security/self.js';
import { createLogger, type Logger } from './util/logger.js';

export interface AppContext {
  config: Config;
  log: Logger;
  db: Db;
  guard: Guard;
  box: SecretBox;
  secrets: SecretStore;
  kv: KvRepo;
  audit: AuditService;
  auditRepo: AuditRepo;
  auth: AuthService;
  usersRepo: UsersRepo;
  setup: SetupService;
  sse: SseHub;
  handle: DockerHandle;
  docker: Dockerode;
  containers: ContainerService;
  images: ImageService;
  volumes: VolumeService;
  networks: NetworkService;
  system: SystemService;
  disk: DiskUsageService;
  eventsRepo: EventsRepo;
  events: EventWatcher;
  stats: StatsSampler;
  statsRepo: StatsRepo;
  ops: OperationManager;
  runner: ComposeRunner;
  policy: PathPolicy;
  compose: ComposeService;
  startedAt: number;
  setupOutcome: string;
  shutdown(): Promise<void>;
}

export interface ContextOptions {
  log?: Logger;
  /** Skip watchers/samplers/timers (tests that only need the HTTP layer). */
  background?: boolean;
  /** Where setup instructions are printed (default: stderr). */
  announce?: (line: string) => void;
}

/** Wires every service together. The only place that knows the full object graph. */
export async function createContext(config: Config, options: ContextOptions = {}): Promise<AppContext> {
  const log = options.log ?? createLogger(config.logLevel);
  const releaseLock = acquireInstanceLock(config.dataDir);
  try {
    return await build(config, log, options, releaseLock);
  } catch (e) {
    releaseLock();
    throw e;
  }
}

async function build(config: Config, log: Logger, options: ContextOptions, releaseLock: () => void): Promise<AppContext> {
  const opened = openDatabase(path.join(config.dataDir, 'quaymaster.db'));
  const db = opened.db;
  const box = new SecretBox(config.secretKey);
  const usersRepo = new UsersRepo(db);
  const sessionsRepo = new SessionsRepo(db);
  const auditRepo = new AuditRepo(db);
  const audit = new AuditService(auditRepo);
  const passwords = new PasswordService(config.scryptLog2N);
  const auth = new AuthService({
    users: usersRepo,
    sessions: sessionsRepo,
    passwords,
    limiter: new LoginLimiter(),
    audit,
    config,
  });
  const setup = new SetupService({ users: usersRepo, auth, passwords, config, announce: options.announce });
  const setupOutcome = await setup.init();

  const guard = new Guard({ readOnly: config.readOnly, scope: config.managedScope, protectedNames: config.protectedNames });
  const handle = await connectDocker(config, guard);
  const docker = handle.docker;

  // RT-05: identify ourselves; inside a container failure to do so makes the guard fail closed
  const self = await detectSelf({
    env: { QM_SELF_CONTAINER: config.selfContainer },
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    hostname: () => os.hostname(),
    inspect: async (ref) => {
      try {
        return (await docker.getContainer(ref).inspect()) as never;
      } catch {
        return null;
      }
    },
  });
  guard.setSelf(self);
  if (self.failure) log.error({ failure: self.failure }, 'running in a container but cannot identify it: read-only mode');
  else if (self.containerId) log.info({ self: self.containerName }, 'self-protection active');

  const system = new SystemService({ docker, config });
  let dockerRoot: string | null = null;
  dockerRoot = await system.dockerRootDir();
  const policy = new PathPolicy(config.stackPaths, () => dockerRoot);

  const containers = new ContainerService({ docker, guard, audit, config });
  const ops = new OperationManager(new OperationsRepo(db), log);
  const interrupted = ops.recover();
  if (interrupted > 0) log.warn({ interrupted }, 'operations left running by a previous crash were marked failed (interrupted)');
  const runner = new ComposeRunner({ config, guard });
  const compose = new ComposeService({ runner, policy, guard, audit, containers, ops, config, docker, log });
  containers.setRecreator(compose);
  const disk = new DiskUsageService({ docker, config, busy: () => ops.busy() });
  const eventsRepo = new EventsRepo(db);
  const statsRepo = new StatsRepo(db);
  const events = new EventWatcher({ docker, repo: eventsRepo, containers, log });
  const stats = new StatsSampler({
    docker,
    containers,
    repo: statsRepo,
    intervalMs: config.stats.intervalMs,
    log,
    paused: () => ops.busy(),
  });
  const sse = new SseHub(auth, {
    maxPerSession: config.sse.maxPerSession,
    maxTotal: config.sse.maxTotal,
    ...DEFAULT_SSE_LIMITS,
  });

  const timers: NodeJS.Timeout[] = [];
  const background = options.background ?? !config.disableBackground;
  if (background) {
    await events.start();
    stats.start();
    // housekeeping: batched deletes so the event loop is never blocked (RT-26)
    timers.push(
      setInterval(() => {
        try {
          auth.purgeExpired();
          eventsRepo.prune(Date.now() - config.eventRetentionDays * 86_400_000);
          statsRepo.prune(Math.floor((Date.now() - config.stats.retentionHours * 3_600_000) / 60_000));
          auditRepo.prune(Date.now() - config.auditRetentionDays * 86_400_000);
        } catch (e) {
          log.error({ err: e }, 'housekeeping failed');
        }
      }, 60_000),
    );
    for (const t of timers) t.unref();
  }

  let closed = false;
  return {
    config, log, db, guard, box,
    secrets: new SecretStore(db, box),
    kv: new KvRepo(db),
    audit, auditRepo, auth, usersRepo, setup, sse, handle, docker,
    containers,
    images: new ImageService({ docker, containers, config }),
    volumes: new VolumeService({ docker, containers, usage: disk }),
    networks: new NetworkService({ docker, containers }),
    system, disk, eventsRepo, events, stats, statsRepo, ops, runner, policy, compose,
    startedAt: Date.now(),
    setupOutcome,
    async shutdown() {
      if (closed) return;
      closed = true;
      // graceful (RT-14): stop taking new work, let running Compose operations finish
      await ops.drain(120_000);
      sse.closeAll('server shutting down');
      events.stop();
      stats.stop();
      for (const t of timers) clearInterval(t);
      setup.stop();
      opened.close();
      releaseLock();
    },
  };
}
