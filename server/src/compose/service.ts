import yaml from 'js-yaml';
import type Dockerode from 'dockerode';
import type {
  ActionRequest,
  ComposeAction,
  ComposeActionRequest,
  ComposeProjectSummary,
  ComposeServiceInfo,
  DependencyGraph,
  ProjectFilesView,
} from '@quaymaster/shared';
import type { AuditService } from '../audit/audit.js';
import type { Config } from '../config/env.js';
import type { ContainerService, Actor, Recreator, ResolvedContainer } from '../docker/containers.js';
import type { IgnoreList } from '../docker/ignore.js';
import { LABEL, learnSecrets } from '../docker/model.js';
import type { OperationManager } from '../operations/manager.js';
import { globalScrubber, redactArgv, redactDeep } from '../redaction/redact.js';
import type { Guard } from '../security/guard.js';
import { AppError, badRequest, conflict, notFound } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { buildComposeArgv, SERVICE_NAME_RE, type ComposeTarget } from './argv.js';
import type { FileHelper, HelperFile } from './helper.js';
import {
  DEFAULT_COMPOSE_NAMES,
  filesUnderDir,
  isComposeFileName,
  isEnvFileName,
  helperDirAllowed,
} from './labelpath.js';
import { buildProjects, scanStackPaths, type ScannedProject } from './discovery.js';
import {
  buildGraph,
  dependentsOf,
  namespaceProviders,
  projectReferences,
  topoOrder,
  type ResolvedConfig,
} from './graph.js';
import type { PathPolicy } from './paths.js';
import { type ComposeRunner, unsetVariableWarnings } from './runner.js';

const DISCOVERY_CACHE_MS = 3000;
const CONFIG_CACHE_MS = 15_000;
/** Upper bound on values in one helper-read Compose file once YAML aliases are expanded (RT4-03). */
export const MAX_YAML_NODES = 50_000;

/**
 * Counts the values of a parsed YAML document the way a recursive walk (redaction, JSON) would see them: aliased
 * nodes are counted every time they are referenced. Returns false as soon as `budget` is exceeded, so a cycle or an
 * alias bomb costs at most `budget` steps.
 */
export function withinNodeBudget(doc: unknown, budget: number): boolean {
  let left = budget;
  const stack: unknown[] = [doc];
  while (stack.length > 0) {
    const v = stack.pop();
    if (--left < 0) return false;
    if (v !== null && typeof v === 'object') {
      for (const c of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) stack.push(c);
      if (stack.length > budget) return false;
    }
  }
  return true;
}

export interface ComposeDetail {
  summary: ComposeProjectSummary;
  graph: DependencyGraph;
  /** Services declared in the Compose file (full level) merged with what is running. */
  services: ComposeServiceInfo[];
  namespaceProviders: Record<string, string[]>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface DriftEntry {
  service: string;
  running: string[];
  wanted: string;
}

interface CachedConfig {
  at: number;
  config: ResolvedConfig;
  warnings: string[];
}

export class ComposeService implements Recreator {
  private cache: { at: number; value: ComposeProjectSummary[]; scanned: ScannedProject[] } | null = null;
  private readonly configCache = new Map<string, CachedConfig>();
  private readonly filesCache = new Map<string, { at: number; view: ProjectFilesView }>();
  private readonly filesInflight = new Map<string, Promise<ProjectFilesView>>();

  constructor(
    private readonly d: {
      runner: ComposeRunner;
      policy: PathPolicy;
      guard: Guard;
      audit: AuditService;
      containers: ContainerService;
      ops: OperationManager;
      config: Pick<Config, 'stackPaths' | 'redactAllEnv'>;
      docker: Dockerode;
      log: Logger;
      ignore: IgnoreList;
      helper: FileHelper;
    },
  ) {}

  invalidate(): void {
    this.cache = null;
    this.configCache.clear();
    this.filesCache.clear();
  }

  // ---- discovery --------------------------------------------------------------------------

  /**
   * Every Compose project Docker reports (plus down stacks found on disk), INCLUDING the ones on the
   * "stopped monitoring" list. Only for safety computations (volume/network ownership, image protection).
   */
  async discoverAll(fresh = false): Promise<ComposeProjectSummary[]> {
    if (!fresh && this.cache && Date.now() - this.cache.at < DISCOVERY_CACHE_MS) return this.cache.value;
    const [containers, ls, helper] = await Promise.all([
      this.d.containers.listRawAll(fresh),
      this.d.runner.ls(),
      this.d.helper.status(),
    ]);
    const scanned = scanStackPaths(this.d.policy.allowedRoots);
    const value = buildProjects({
      containers,
      ls,
      scanned,
      policy: this.d.policy,
      guard: this.d.guard,
      helper,
    }).filter((p) => this.d.guard.visible(p.name));
    this.cache = { at: Date.now(), value, scanned };
    return value;
  }

  /** The monitored projects: what the API lists and what every action, update check and schedule works on. */
  async discover(fresh = false): Promise<ComposeProjectSummary[]> {
    return (await this.discoverAll(fresh)).filter(
      (p) => !this.d.ignore.isProjectIgnored(p.name, p.workingDir),
    );
  }

  private async summary(name: string, includeIgnored = false): Promise<ComposeProjectSummary> {
    const all = await this.discoverAll();
    const s = all.find((p) => p.name === name && !this.d.ignore.isProjectIgnored(p.name, p.workingDir));
    if (s) return s;
    if (all.some((p) => p.name === name && this.d.ignore.isProjectIgnored(p.name, p.workingDir))) {
      if (includeIgnored) return all.find((p) => p.name === name) as ComposeProjectSummary;
      throw new AppError(
        409,
        'ignored',
        `Project "${name}" is on the "stopped monitoring" list. Restore it in Settings to manage it again.`,
      );
    }
    throw notFound('Compose project');
  }

  private async rawContainers(name: string): Promise<Dockerode.ContainerInfo[]> {
    return (await this.d.containers.listRaw()).filter((c) => c.Labels?.[LABEL.project] === name);
  }

  private fullTarget(s: ComposeProjectSummary): ComposeTarget {
    if (s.level !== 'full' || !s.workingDir) {
      throw new AppError(
        409,
        'limited_capability',
        `Project "${s.name}" has capability "${s.level}": file-level operations are unavailable. ${s.reasons.join('; ')}`,
        { level: s.level, reasons: s.reasons, reasonDetails: s.reasonDetails, mountHint: s.mountHint },
      );
    }
    return { projectName: s.name, workingDir: s.workingDir, files: s.configFiles };
  }

  // ---- resolved configuration -------------------------------------------------------------

  /** Runs `compose config --format json` (cached briefly). The raw result stays in memory; only redacted views leave. */
  async resolvedConfig(name: string, fresh = false, includeIgnored = false): Promise<CachedConfig> {
    const hit = this.configCache.get(name);
    if (
      !fresh &&
      hit &&
      Date.now() - hit.at < CONFIG_CACHE_MS &&
      !(!includeIgnored && this.isIgnoredName(name))
    )
      return hit;
    const target = this.fullTarget(await this.summary(name, includeIgnored));
    const r = await this.d.runner.run(buildComposeArgv(target, { sub: 'config', format: 'json' }), {
      timeoutMs: 60_000,
    });
    if (r.code !== 0) {
      throw new AppError(
        422,
        'compose_failed',
        `docker compose config failed: ${this.clean(r.stderr).slice(-2000)}`,
      );
    }
    let config: ResolvedConfig;
    try {
      config = JSON.parse(r.stdout) as ResolvedConfig;
    } catch {
      throw new AppError(502, 'compose_failed', 'docker compose config returned invalid JSON');
    }
    learnSecrets(config, this.d.config.redactAllEnv);
    const entry = {
      at: Date.now(),
      config,
      warnings: unsetVariableWarnings(r.stderr).map((w) => this.clean(w)),
    };
    this.configCache.set(name, entry);
    return entry;
  }

  private clean(s: string): string {
    return globalScrubber.clean(s);
  }

  private isIgnoredName(name: string): boolean {
    return (this.cache?.value ?? []).some(
      (p) => p.name === name && this.d.ignore.isProjectIgnored(p.name, p.workingDir),
    );
  }

  /**
   * Redacted configuration. Full projects: `docker compose config`. Other projects: when the read-only helper can
   * reach the directory, the project's own files parsed and redacted (not interpolated). Otherwise a precise
   * `limited_capability` error.
   */
  async configView(
    name: string,
    opts: { actor?: Actor; mayUseHelper?: boolean } = {},
  ): Promise<ProjectFilesView> {
    const s = await this.summary(name);
    if (s.level === 'full') {
      const { config, warnings } = await this.resolvedConfig(name);
      return {
        source: 'compose',
        config: redactDeep(config, { redactAllEnv: this.d.config.redactAllEnv }),
        warnings,
      };
    }
    if (s.fileAccess !== 'helper' || !s.workingDir) {
      throw new AppError(
        409,
        'limited_capability',
        `The configuration of "${name}" cannot be shown: ${s.reasons.join('; ') || 'files are not accessible'}`,
        { level: s.level, reasons: s.reasons, reasonDetails: s.reasonDetails, mountHint: s.mountHint },
      );
    }
    // RT4-05: reading through the helper creates a container on the host; that is an administrator action
    if (opts.mayUseHelper !== true)
      throw new AppError(
        403,
        'forbidden',
        `The files of "${name}" are not mounted into Quaymaster; reading them through the helper container needs an administrator.`,
      );
    const hit = this.filesCache.get(s.name);
    const cached = hit !== undefined && Date.now() - hit.at < CONFIG_CACHE_MS;
    const view = await this.filesView(s);
    if (!cached && opts.actor)
      this.d.audit.record({
        actor: opts.actor.name,
        ip: opts.actor.ip,
        action: 'compose.files_read',
        target: s.name,
        outcome: 'success',
        params: { workingDir: s.workingDir, files: view.files ?? [], via: 'helper' },
      });
    return view;
  }

  private async filesView(s: ComposeProjectSummary): Promise<ProjectFilesView> {
    const hit = this.filesCache.get(s.name);
    if (hit && Date.now() - hit.at < CONFIG_CACHE_MS) return hit.view;
    const running = this.filesInflight.get(s.name);
    if (running) return running;
    const p = this.readViaHelper(s)
      .then((view) => {
        this.filesCache.set(s.name, { at: Date.now(), view });
        return view;
      })
      .finally(() => this.filesInflight.delete(s.name));
    this.filesInflight.set(s.name, p);
    return p;
  }

  private async readViaHelper(s: ComposeProjectSummary): Promise<ProjectFilesView> {
    const dir = helperDirAllowed(s.workingDir ?? '', (await this.d.helper.status()).deniedDirs ?? []);
    if (!dir.ok)
      throw new AppError(409, 'limited_capability', `The working directory is not usable: ${dir.reason}`);
    const { rel, rejected } = filesUnderDir(dir.dir, s.configFiles);
    const res = await this.d.helper.read(dir.dir, rel);
    if (!res.ok) {
      throw new AppError(
        res.code === 'failed' ? 502 : 409,
        res.code === 'failed' ? 'internal' : 'limited_capability',
        `Cannot read the project files: ${res.reason}`,
      );
    }
    // trust: a directory anybody can write to may have had files added or replaced. The sticky bit does not help:
    // it only stops deleting OTHER users' files, anyone can still drop a new compose.override.yaml in.
    if (res.dirMode !== null && (res.dirMode & 0o002) !== 0) {
      throw new AppError(
        409,
        'limited_capability',
        `The project directory is world-writable, so its files are not trusted: ${s.workingDir}`,
        { reasonDetails: [{ code: 'untrusted', message: 'the project directory is world-writable' }] },
      );
    }
    // the label named files, but none may be read: show nothing rather than some other file of the directory
    const wanted =
      rel.length > 0
        ? rel
        : s.configFiles.length > 0
          ? []
          : [
              DEFAULT_COMPOSE_NAMES.find((n) =>
                res.files.some((f) => f.name === n && f.content !== undefined),
              ) ?? DEFAULT_COMPOSE_NAMES[0]!,
            ];
    const byName = new Map<string, HelperFile>(res.files.map((f) => [f.name, f]));
    const warnings: string[] = rejected.map((r) => `${r.file}: not read (${r.reason})`);
    const config: Record<string, unknown> = {};
    const shown: string[] = [];
    for (const n of wanted) {
      const f = byName.get(n);
      const base = n.split('/').pop() ?? n;
      if (!f || f.content === undefined) {
        warnings.push(`${n}: ${f?.error ?? 'missing'}`);
        continue;
      }
      if (!isComposeFileName(base)) continue;
      try {
        const doc = yaml.load(f.content);
        // RT4-03: aliases are shared references; expanding them in redaction/JSON can turn a few hundred bytes
        // into gigabytes. Refuse documents whose expanded size exceeds a sane Compose file.
        if (!withinNodeBudget(doc, MAX_YAML_NODES)) {
          warnings.push(
            `${n}: refused: YAML anchors/aliases expand to more than ${MAX_YAML_NODES} values (or form a cycle)`,
          );
          continue;
        }
        learnSecrets(doc, this.d.config.redactAllEnv);
        config[n] = doc;
        shown.push(n);
      } catch (e) {
        warnings.push(`${n}: not valid YAML (${(e as Error).message.split('\n')[0]})`);
      }
    }
    const envKeys: string[] = [];
    for (const f of res.files) {
      // the helper returns NAMES only for .env files (RT4-02); values never reach Quaymaster
      if (!isEnvFileName(f.name) || f.keys === undefined) continue;
      envKeys.push(...f.keys);
      shown.push(f.name);
    }
    if (shown.length === 0 && warnings.length === 0)
      warnings.push('no Compose file was found in the directory');
    return {
      source: 'files',
      config: redactDeep(config, { redactAllEnv: this.d.config.redactAllEnv }),
      warnings,
      files: shown,
      envKeys: [...new Set(envKeys)].sort(),
    };
  }

  async validate(name: string): Promise<ValidationResult> {
    const target = this.fullTarget(await this.summary(name));
    const r = await this.d.runner.run(buildComposeArgv(target, { sub: 'config', validateOnly: true }), {
      timeoutMs: 60_000,
    });
    const warnings = unsetVariableWarnings(r.stderr).map((w) => this.clean(w));
    const errors: string[] = [];
    if (r.code !== 0) errors.push(this.clean(r.stderr.trim()).slice(-2000) || `exit code ${r.code}`);
    for (const w of warnings) errors.push(`unset variable (treated as an error): ${w}`);
    // env_file / secrets / configs files must also be inside the allow-list (RT-02)
    if (r.code === 0) errors.push(...(await this.fileReferenceProblems(target)));
    return { valid: errors.length === 0, errors, warnings };
  }

  /** Checks env_file / secret / config file paths of the *resolved* project against QM_STACK_PATHS. */
  private async fileReferenceProblems(target: ComposeTarget): Promise<string[]> {
    const problems: string[] = [];
    const r = await this.d.runner.run(buildComposeArgv(target, { sub: 'config', noEnvResolution: true }), {
      timeoutMs: 60_000,
    });
    if (r.code !== 0) return problems;
    let cfg: ResolvedConfig & { services?: Record<string, { env_file?: unknown }> };
    try {
      cfg = JSON.parse(r.stdout) as typeof cfg;
    } catch {
      return problems;
    }
    const paths = new Set<string>();
    for (const svc of Object.values(cfg.services ?? {})) {
      const ef = svc.env_file;
      const list = Array.isArray(ef) ? ef : ef ? [ef] : [];
      for (const e of list) {
        const p = typeof e === 'string' ? e : (e as { path?: string }).path;
        if (p) paths.add(p);
      }
    }
    for (const s of Object.values(cfg.secrets ?? {})) if (s?.file) paths.add(s.file);
    for (const c of Object.values(cfg.configs ?? {})) if (c?.file) paths.add(c.file);
    for (const p of paths) {
      const abs = p.startsWith('/') ? p : `${target.workingDir}/${p}`;
      const check = this.d.policy.check(abs);
      // a missing optional env file is not a security problem; only report out-of-root references
      if (!check.ok && !check.reason.includes('does not exist')) problems.push(check.reason);
    }
    return problems;
  }

  // ---- detail / graph ---------------------------------------------------------------------

  async detail(name: string): Promise<ComposeDetail> {
    const summary = await this.summary(name);
    const rawContainers = await this.rawContainers(name);
    if (summary.level === 'full') {
      try {
        const { config } = await this.resolvedConfig(name);
        const graph = buildGraph(config);
        const running = new Map(summary.services.map((s) => [s.name, s]));
        const services: ComposeServiceInfo[] = Object.entries(config.services ?? {})
          .map(
            ([n, svc]) =>
              running.get(n) ?? {
                name: n,
                image: svc.image ?? null,
                containers: [],
                status: 'not-created' as const,
                replicas: 0,
              },
          )
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const s of summary.services) if (!services.some((x) => x.name === s.name)) services.push(s);
        return {
          summary,
          graph,
          services,
          namespaceProviders: Object.fromEntries(namespaceProviders(graph)),
        };
      } catch (e) {
        if (!(e instanceof AppError) || e.code !== 'compose_failed') throw e;
        // fall through to the label-based view when the file does not resolve
        this.d.log.warn({ project: name }, 'compose config failed; showing label-based view');
      }
    }
    const graph = graphFromLabels(rawContainers);
    return {
      summary,
      graph,
      services: summary.services,
      namespaceProviders: Object.fromEntries(namespaceProviders(graph)),
    };
  }

  // ---- update-workflow primitives (used by the maintenance planner / executor) -------------

  /** Summary + trusted Compose target of a project (throws `limited_capability` when files are not trusted). */
  async targetOf(
    name: string,
    fresh = false,
  ): Promise<{ summary: ComposeProjectSummary; target: ComposeTarget }> {
    const summary = fresh
      ? ((await this.discover(true)).find((p) => p.name === name) ?? (await this.summary(name)))
      : await this.summary(name);
    return { summary, target: this.fullTarget(summary) };
  }

  /** Raw containers of a project (fresh list). */
  async projectContainers(name: string): Promise<Dockerode.ContainerInfo[]> {
    return (await this.d.containers.listRaw(true)).filter((c) => c.Labels?.[LABEL.project] === name);
  }

  /**
   * One `docker compose up` for exactly the given services (`--no-deps`, `--no-build`, `--pull never`).
   * The service layer checks read-only / scope / self-protection for the project and each container
   * first; the runner enforces the subcommand allow-list again.
   */
  async deployServices(
    target: ComposeTarget,
    opts: { services: string[]; forceRecreate?: boolean; noStart?: boolean },
    onOutput?: (chunk: string) => void,
  ): Promise<{ code: number; timedOut: boolean; stderrTail: string; argv: string[] }> {
    const cfg = await this.resolvedConfig(target.projectName, true);
    this.d.guard.assertProject(target.projectName, projectReferences(cfg.config), { perService: true });
    const containers = await this.projectContainers(target.projectName);
    for (const c of containers.filter((c) => opts.services.includes(c.Labels?.[LABEL.service] ?? ''))) {
      this.d.guard.assertContainer(
        { id: c.Id, name: (c.Names?.[0] ?? '').replace(/^\//, ''), project: target.projectName },
        'compose',
      );
    }
    const argv = buildComposeArgv(target, {
      sub: 'up',
      services: opts.services,
      noDeps: true,
      forceRecreate: opts.forceRecreate === true,
      noStart: opts.noStart === true,
    });
    try {
      const r = await this.d.runner.run(argv, { onOutput, timeoutMs: 10 * 60_000 });
      return {
        code: r.code,
        timedOut: r.timedOut,
        stderrTail: this.clean(r.stderr).slice(-1500),
        argv: redactArgv(argv),
      };
    } finally {
      this.d.containers.invalidate();
      this.invalidate();
    }
  }

  // ---- drift gate (RT-01) -----------------------------------------------------------------

  /** Wanted `compose config --hash` per service (RT-01). */
  async configHashes(target: ComposeTarget, services: string[]): Promise<Map<string, string>> {
    const r = await this.d.runner.run(buildComposeArgv(target, { sub: 'config', hash: services }), {
      timeoutMs: 60_000,
    });
    if (r.code !== 0) {
      throw new AppError(
        422,
        'compose_failed',
        `cannot compute configuration hash: ${this.clean(r.stderr).slice(-1000)}`,
      );
    }
    const wanted = new Map<string, string>();
    for (const line of r.stdout.split('\n')) {
      const m = /^(\S+)\s+([0-9a-f]{16,})\s*$/.exec(line.trim());
      if (m?.[1] && m[2]) wanted.set(m[1], m[2]);
    }
    return wanted;
  }

  /** Compares `compose config --hash` of each service with the running containers' labels. */
  async checkDrift(target: ComposeTarget, services: string[]): Promise<DriftEntry[]> {
    const wanted = await this.configHashes(target, services);
    const containers = await this.rawContainers(target.projectName);
    const drift: DriftEntry[] = [];
    for (const svc of services.length ? services : [...wanted.keys()]) {
      const w = wanted.get(svc);
      const have = containers
        .filter((c) => c.Labels?.[LABEL.service] === svc)
        .map((c) => c.Labels?.[LABEL.configHash])
        .filter((h): h is string => !!h);
      if (!w || have.length === 0) continue; // nothing deployed yet: nothing can drift
      if (have.some((h) => h !== w)) drift.push({ service: svc, running: [...new Set(have)], wanted: w });
    }
    return drift;
  }

  // ---- operations -------------------------------------------------------------------------

  async operate(
    name: string,
    action: ComposeAction,
    req: ComposeActionRequest,
    actor: Actor,
  ): Promise<{ operationId: string }> {
    this.d.guard.assertNotUnderMaintenance(name, null);
    const service = req.service;
    if (service !== undefined && !SERVICE_NAME_RE.test(service)) throw badRequest('Invalid service name');
    const base = {
      actor: actor.name,
      ip: actor.ip,
      action: `compose.${action}`,
      target: service ? `${name}/${service}` : name,
      params: { ...req },
    };
    const deny = (e: unknown): never => {
      const status = (e as { status?: number }).status;
      this.d.audit.record({
        ...base,
        params: { ...req, error: (e as Error).message },
        outcome: status === 409 || status === 403 ? 'denied' : 'failure',
      });
      throw e;
    };
    try {
      return await this.prepareAndStart(name, action, req, actor, base);
    } catch (e) {
      return deny(e);
    }
  }

  private async prepareAndStart(
    name: string,
    action: ComposeAction,
    req: ComposeActionRequest,
    actor: Actor,
    base: { actor: string; ip: string | null; action: string; target: string; params: unknown },
  ): Promise<{ operationId: string }> {
    const summary = await this.summary(name);
    const service = req.service;
    if (service && summary.level !== 'full' && !summary.services.some((s) => s.name === service))
      throw notFound('Service');

    // ---- limited projects: container-level start/stop/restart only (spec 4.2)
    if (summary.level !== 'full') {
      if (!['start', 'stop', 'restart'].includes(action)) {
        throw new AppError(
          409,
          'limited_capability',
          `"${action}" needs the Compose files, which Quaymaster cannot use for "${name}": ${summary.reasons.join('; ')}. ` +
            (summary.mountHint
              ? `Mount the project directory into Quaymaster at the same path (${summary.mountHint.volume}).`
              : 'See the project page for what to fix.'),
          {
            level: summary.level,
            reasons: summary.reasons,
            reasonDetails: summary.reasonDetails,
            mountHint: summary.mountHint,
          },
        );
      }
      return this.engineLevelOperation(summary, action as 'start' | 'stop' | 'restart', service, actor, base);
    }

    const target = this.fullTarget(summary);
    const needsConfig = action === 'up' || action === 'redeploy';
    let cfg: CachedConfig | null = null;
    if (needsConfig || service) cfg = await this.resolvedConfig(name, true);
    if (service && cfg && !(service in (cfg.config.services ?? {}))) throw notFound('Service');
    const refs = cfg ? projectReferences(cfg.config) : undefined;
    this.d.guard.assertProject(name, refs, { perService: !!service });
    if (service) {
      for (const c of (await this.rawContainers(name)).filter((c) => c.Labels?.[LABEL.service] === service)) {
        this.d.guard.assertContainer(
          { id: c.Id, name: (c.Names?.[0] ?? '').replace(/^\//, ''), project: name },
          'compose',
        );
      }
    }

    if (needsConfig && cfg && cfg.warnings.length > 0) {
      throw new AppError(409, 'validation', 'Compose reports unset variables (treated as an error)', {
        warnings: cfg.warnings,
      });
    }

    const destructive = action === 'down' || (action === 'redeploy' && req.forceRecreate === true);
    if (destructive && req.confirm !== name) {
      throw new AppError(409, 'confirmation_required', `Confirm by sending {"confirm":"${name}"}`, {
        expected: name,
      });
    }

    if (needsConfig && cfg) {
      // RT-11: recreating a namespace/volume provider affects its dependents
      if (service) {
        const graph = buildGraph(cfg.config);
        const dependents = namespaceProviders(graph).get(service);
        if (dependents?.length && req.confirmNamespaceProvider !== true) {
          throw new AppError(
            409,
            'confirmation_required',
            `"${service}" provides a network namespace/volumes to ${dependents.join(', ')}; recreating it breaks them until they are recreated too. Send {"confirmNamespaceProvider":true} to proceed.`,
            { providerFor: dependents, field: 'confirmNamespaceProvider' },
          );
        }
      }
      // RT-01: the hash gate
      const svcs = service ? [service] : Object.keys(cfg.config.services ?? {});
      const drift = await this.checkDrift(target, svcs);
      if (drift.length > 0 && req.applyDrift !== true) {
        throw new AppError(
          409,
          'blocked_drift',
          'The Compose configuration differs from what is running; a redeploy would apply those changes too. Review the redacted configuration and send {"applyDrift":true} to proceed.',
          {
            services: drift,
            redactedConfig: redactDeep(
              {
                services: Object.fromEntries(
                  drift.map((d) => [d.service, cfg?.config.services?.[d.service]]),
                ),
              },
              { redactAllEnv: this.d.config.redactAllEnv },
            ),
            field: 'applyDrift',
          },
        );
      }
    }

    const command = ((): Parameters<typeof buildComposeArgv>[1] => {
      const services = service ? [service] : [];
      switch (action) {
        case 'up':
          return { sub: 'up', services, noDeps: !!service, forceRecreate: false };
        case 'redeploy':
          return { sub: 'up', services, noDeps: !!service, forceRecreate: req.forceRecreate === true };
        case 'stop':
          return { sub: 'stop', services };
        case 'start':
          return { sub: 'start', services };
        case 'restart':
          return { sub: 'restart', services };
        case 'down':
          if (service) throw badRequest('`down` applies to a whole project; use stop for a single service');
          return { sub: 'down' };
      }
    })();
    const argv = buildComposeArgv(target, command);
    const version = await this.d.runner.composeVersion();

    const id = this.d.ops.start({
      kind: `compose.${action}`,
      target: base.target,
      actor: actor.name,
      params: { ...req },
      lockKey: `project:${name}`,
      composeVersion: version,
      run: async (ctx) => {
        const t0 = Date.now();
        ctx.log(`$ docker ${redactArgv(argv).join(' ')}\n(compose ${version ?? 'unknown'})\n`);
        try {
          const r = await this.d.runner.run(argv, { onOutput: (c) => ctx.log(c) });
          if (r.code !== 0) {
            throw new AppError(
              502,
              'compose_failed',
              `docker compose ${command.sub} exited with code ${r.code}${r.timedOut ? ' (timed out)' : ''}`,
            );
          }
          this.d.audit.record({
            ...base,
            outcome: 'success',
            durationMs: Date.now() - t0,
            params: { ...req, operation: ctx.id },
          });
        } catch (e) {
          this.d.audit.record({
            ...base,
            outcome: 'failure',
            durationMs: Date.now() - t0,
            params: { ...req, operation: ctx.id, error: (e as Error).message },
          });
          throw e;
        } finally {
          this.d.containers.invalidate();
          this.invalidate();
        }
      },
    });
    return { operationId: id };
  }

  /** Limited-level start/stop/restart through the Engine API (one container at a time, dependency-aware order). */
  private async engineLevelOperation(
    summary: ComposeProjectSummary,
    action: 'start' | 'stop' | 'restart',
    service: string | undefined,
    actor: Actor,
    base: { actor: string; ip: string | null; action: string; target: string; params: unknown },
  ): Promise<{ operationId: string }> {
    this.d.guard.assertProject(summary.name, undefined, { perService: !!service });
    const containers = (await this.rawContainers(summary.name)).filter(
      (c) => !service || c.Labels?.[LABEL.service] === service,
    );
    if (containers.length === 0) throw notFound('Service');
    const graph = graphFromLabels(await this.rawContainers(summary.name));
    const order = graph.order.length ? graph.order : graph.nodes;
    const rank = (c: Dockerode.ContainerInfo): number => order.indexOf(c.Labels?.[LABEL.service] ?? '');
    containers.sort((a, b) => (action === 'stop' ? rank(b) - rank(a) : rank(a) - rank(b)));
    // refuse up-front if any container is not allowed (nothing is half-done)
    for (const c of containers) {
      this.d.guard.assertContainer(
        { id: c.Id, name: (c.Names?.[0] ?? '').replace(/^\//, ''), project: summary.name },
        action,
      );
    }
    const id = this.d.ops.start({
      kind: `compose.${action}`,
      target: base.target,
      actor: actor.name,
      params: { engineLevel: true },
      lockKey: `project:${summary.name}`,
      run: async (ctx) => {
        const t0 = Date.now();
        try {
          for (const c of containers) {
            const n = (c.Names?.[0] ?? c.Id).replace(/^\//, '');
            ctx.log(`${action} ${n} (Engine API, limited project)\n`);
            await this.d.containers.act(c.Id, action, {}, actor);
          }
          this.d.audit.record({ ...base, outcome: 'success', durationMs: Date.now() - t0 });
        } catch (e) {
          this.d.audit.record({
            ...base,
            outcome: 'failure',
            durationMs: Date.now() - t0,
            params: { error: (e as Error).message },
          });
          throw e;
        } finally {
          this.invalidate();
        }
      },
    });
    return { operationId: id };
  }

  /** Recreator: Compose-managed containers are only ever recreated through Compose (RT-12). */
  async recreate(c: ResolvedContainer, req: ActionRequest, actor: Actor): Promise<{ operationId: string }> {
    if (!c.project || !c.service) throw new AppError(409, 'unsupported', 'Not a Compose-managed container');
    return this.operate(
      c.project,
      'redeploy',
      {
        service: c.service,
        forceRecreate: true,
        confirm: c.project,
        applyDrift: req.applyDrift,
        confirmNamespaceProvider: req.confirmNamespaceProvider,
      },
      actor,
    );
  }

  /** For tests/diagnostics. */
  async serviceNames(name: string): Promise<string[]> {
    return (await this.detail(name)).services.map((s) => s.name);
  }

  conflictIfBusy(name: string): void {
    if (this.d.ops.busy()) throw conflict('conflict', `An operation is running (project ${name})`);
  }
}

/** Dependency graph reconstructed from `com.docker.compose.depends_on` labels (limited projects). */
export function graphFromLabels(containers: Dockerode.ContainerInfo[]): DependencyGraph {
  const nodes = new Set<string>();
  const edges: DependencyGraph['edges'] = [];
  for (const c of containers) {
    const svc = c.Labels?.[LABEL.service];
    if (!svc) continue;
    nodes.add(svc);
    const dep = c.Labels?.[LABEL.dependsOn] ?? '';
    for (const part of dep.split(',').filter(Boolean)) {
      const [to, condition, restart] = part.split(':');
      if (!to) continue;
      nodes.add(to);
      if (!edges.some((e) => e.from === svc && e.to === to)) {
        edges.push({
          from: svc,
          to,
          kind: 'depends_on',
          condition: condition || 'service_started',
          restart: restart === 'true',
        });
      }
    }
  }
  const list = [...nodes].sort();
  return { nodes: list, edges, ...topoOrder(list, edges) };
}

export { buildGraph, dependentsOf };
