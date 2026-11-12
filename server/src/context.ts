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
import { OccurrencesRepo, PoliciesRepo, RunsRepo, SchedulesRepo, WindowsRepo } from './db/maintenance.js';
import {
  ImageChecksRepo,
  QuarantineRepo,
  RegistryCredentialsRepo,
  RollbackRepo,
  StagedRepo,
} from './db/updates.js';
import { ImageOps } from './docker/imageops.js';
import { AdjustableClock } from './maintenance/clock.js';
import { RunExecutor } from './maintenance/executor.js';
import { StandaloneUpdater } from './maintenance/standalone.js';
import { MaintenanceService } from './maintenance/service.js';
import { Planner } from './maintenance/planner.js';
import { PolicyResolver } from './maintenance/policy.js';
import { Monitors } from './monitor/monitors.js';
import { NotificationService } from './notifications/service.js';
import { RegistryClient } from './registry/client.js';
import { cacheKey, parseImageRef } from './registry/reference.js';
import { CleanupService } from './updates/cleanup.js';
import { StorageCleanupService, type ComposeOwnership } from './docker/storage-cleanup.js';
import { UpdateService } from './updates/detector.js';
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
  clock: AdjustableClock;
  notifications: NotificationService;
  registry: RegistryClient;
  registryCreds: RegistryCredentialsRepo;
  checksRepo: ImageChecksRepo;
  stagedRepo: StagedRepo;
  rollbackRepo: RollbackRepo;
  quarantineRepo: QuarantineRepo;
  policiesRepo: PoliciesRepo;
  runsRepo: RunsRepo;
  imageOps: ImageOps;
  updates: UpdateService;
  cleanup: CleanupService;
  storage: StorageCleanupService;
  planner: Planner;
  executor: RunExecutor;
  maintenance: MaintenanceService;
  monitors: Monitors;
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

async function build(
  config: Config,
  log: Logger,
  options: ContextOptions,
  releaseLock: () => void,
): Promise<AppContext> {
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

  const guard = new Guard({
    readOnly: config.readOnly,
    scope: config.managedScope,
    visibleScope: config.visibleScope,
    protectedNames: config.protectedNames,
  });
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
  if (self.failure)
    log.error({ failure: self.failure }, 'running in a container but cannot identify it: read-only mode');
  else if (self.containerId) log.info({ self: self.containerName }, 'self-protection active');

  const system = new SystemService({ docker, config });
  let dockerRoot: string | null = null;
  dockerRoot = await system.dockerRootDir();
  const policy = new PathPolicy(config.stackPaths, () => dockerRoot);

  const containers = new ContainerService({ docker, guard, audit, config });
  const ops = new OperationManager(new OperationsRepo(db), log);
  const interrupted = ops.recover();
  if (interrupted > 0)
    log.warn({ interrupted }, 'operations left running by a previous crash were marked failed (interrupted)');
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

  // ---- phase 2: updates, maintenance, notifications ------------------------------------------
  const clock = new AdjustableClock();
  const secrets = new SecretStore(db, box);
  const notifications = new NotificationService({ db, secrets, audit, log });
  const notify = (e: Parameters<NotificationService['emit']>[0]): void => notifications.emit(e);
  const registryCreds = new RegistryCredentialsRepo(db, secrets);
  const checksRepo = new ImageChecksRepo(db);
  const stagedRepo = new StagedRepo(db);
  const rollbackRepo = new RollbackRepo(db);
  const quarantineRepo = new QuarantineRepo(db);
  const policiesRepo = new PoliciesRepo(db);
  const runsRepo = new RunsRepo(db);
  const registry = new RegistryClient({
    credentials: (host) => registryCreds.get(host),
    insecureHosts: config.registryInsecure,
    realmAllowList: config.registryTokenRealms,
  });
  const imageOps = new ImageOps({
    docker,
    creds: registryCreds,
    staged: stagedRepo,
    audit,
    freeBytes: async () => (await system.host().catch(() => null))?.dockerRoot?.free ?? null,
    floorBytes: config.diskFloorBytes,
  });
  const updates = new UpdateService({
    docker,
    containers,
    registry,
    checks: checksRepo,
    staged: stagedRepo,
    quarantine: quarantineRepo,
    ttlMs: config.checkTtlMs,
    log,
  });
  const resolver = new PolicyResolver(policiesRepo);
  const planner = new Planner({
    compose,
    containers,
    updates,
    registry,
    policies: resolver,
    quarantine: quarantineRepo,
    system,
    guard,
    config,
    log,
    now: () => clock.now(),
  });
  // H-03: manual actions are refused on a project while a maintenance run holds the single-run lock
  guard.setMaintenanceGate((project, name) => {
    if (!ops.isLocked('maintenance')) return null;
    const run = runsRepo.running();
    if (run && project !== run.target && name !== run.target && /^[a-z0-9][a-z0-9_-]*$/.test(run.target))
      return null;
    return 'A maintenance run is active on this project; manual actions are refused until it finishes';
  });
  const windowsRepo = new WindowsRepo(db);
  const executor = new RunExecutor({
    compose,
    docker,
    containers,
    images: imageOps,
    updates,
    planner,
    runs: runsRepo,
    windows: windowsRepo,
    rollback: rollbackRepo,
    staged: stagedRepo,
    quarantine: quarantineRepo,
    audit,
    notify,
    config,
    clock,
    log,
  });
  const standalone = new StandaloneUpdater({
    docker,
    containers,
    images: imageOps,
    updates,
    runs: runsRepo,
    rollback: rollbackRepo,
    staged: stagedRepo,
    resolver,
    guard,
    audit,
    notify,
    config,
    clock,
    log,
  });
  const cleanup = new CleanupService({
    docker,
    containers,
    images: imageOps,
    guard,
    audit,
    rollback: rollbackRepo,
    staged: stagedRepo,
    projectImageRefs: async () => {
      const refs = new Set<string>();
      for (const p of await compose.discover()) {
        if (p.level !== 'full') continue;
        try {
          const cfg = (await compose.resolvedConfig(p.name)).config;
          for (const svc of Object.values(cfg.services ?? {})) {
            if (!svc.image) continue;
            refs.add(svc.image);
            const r = parseImageRef(svc.image);
            if (r) refs.add(cacheKey(r));
          }
        } catch {
          /* a project that does not resolve protects nothing it cannot name; running containers still protect their images */
        }
      }
      return refs;
    },
    usage: disk,
    freeBytes: async () => (await system.host().catch(() => null))?.dockerRoot?.free ?? null,
    minAgeMs: config.cleanupMinAgeMs,
    retentionMs: config.rollbackRetentionMs,
    log,
  });
  const storage = new StorageCleanupService({
    docker,
    guard,
    audit,
    usage: disk,
    freeBytes: async () => (await system.host().catch(() => null))?.dockerRoot?.free ?? null,
    composeOwnership: async () => {
      const own: ComposeOwnership = {
        ok: true,
        projects: new Set(),
        volumes: new Map(),
        networks: new Map(),
      };
      try {
        for (const p of await compose.discover()) {
          own.projects.add(p.name);
          if (p.level !== 'full') continue;
          try {
            const cfg = (await compose.resolvedConfig(p.name)).config;
            for (const [key, v] of Object.entries(cfg.volumes ?? {}))
              own.volumes.set(v?.name ?? `${p.name}_${key}`, p.name);
            for (const [key, v] of Object.entries(cfg.networks ?? {}))
              own.networks.set(v?.name ?? `${p.name}_${key}`, p.name);
          } catch {
            // a project whose config does not resolve still exists: its labelled resources stay protected
          }
        }
      } catch {
        own.ok = false;
      }
      return own;
    },
    minAgeMs: config.cleanupMinAgeMs,
  });
  const maintenance = new MaintenanceService({
    runs: runsRepo,
    windows: windowsRepo,
    schedules: new SchedulesRepo(db),
    occurrences: new OccurrencesRepo(db),
    resolver,
    planner,
    executor,
    standalone,
    ops,
    updates,
    images: imageOps,
    cleanup,
    compose,
    containers,
    guard,
    audit,
    notify,
    clock,
    config,
    log,
  });
  const monitors = new Monitors({
    kv: new KvRepo(db),
    system,
    schedules: new SchedulesRepo(db),
    updates,
    maintenance,
    notify,
    maintenanceBusy: () => ops.busy(),
    clock,
    log,
  });
  const interruptedRuns = await maintenance.recover();
  if (interruptedRuns > 0)
    log.warn({ interruptedRuns }, 'maintenance runs left running by a crash were marked interrupted');
  events.on('event', (e: Parameters<Monitors['onDockerEvent']>[0]) => monitors.onDockerEvent(e));
  stats.on('sample', (s: Parameters<Monitors['onSample']>[0]) => monitors.onSample(s));

  if (background) {
    notifications.start();
    maintenance.start_();
    monitors.start();
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
    config,
    log,
    db,
    guard,
    box,
    secrets: new SecretStore(db, box),
    kv: new KvRepo(db),
    audit,
    auditRepo,
    auth,
    usersRepo,
    setup,
    sse,
    handle,
    docker,
    containers,
    images: new ImageService({ docker, containers, config }),
    volumes: new VolumeService({ docker, containers, usage: disk }),
    networks: new NetworkService({ docker, containers }),
    system,
    disk,
    eventsRepo,
    events,
    stats,
    statsRepo,
    ops,
    runner,
    policy,
    compose,
    clock,
    notifications,
    registry,
    registryCreds,
    checksRepo,
    stagedRepo,
    rollbackRepo,
    quarantineRepo,
    policiesRepo,
    runsRepo,
    imageOps,
    updates,
    cleanup,
    storage,
    planner,
    executor,
    maintenance,
    monitors,
    startedAt: Date.now(),
    setupOutcome,
    async shutdown() {
      if (closed) return;
      closed = true;
      // graceful (RT-14): stop taking new work, let running Compose operations finish
      maintenance.stop();
      monitors.stop();
      await ops.drain(120_000);
      await notifications.flush().catch(() => undefined);
      notifications.stop();
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
