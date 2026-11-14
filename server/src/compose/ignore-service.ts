import type { IgnoredEntry, IgnoreRequest } from '@quaymaster/shared';
import type { AuditService } from '../audit/audit.js';
import type { IgnoreRepo } from '../db/ignore.js';
import type { Actor, ContainerService } from '../docker/containers.js';
import type { IgnoreList } from '../docker/ignore.js';
import { LABEL } from '../docker/model.js';
import type { Guard } from '../security/guard.js';
import { AppError, badRequest, notFound } from '../util/errors.js';
import { PROJECT_NAME_RE } from './argv.js';
import type { ComposeService } from './service.js';

/**
 * "Stop monitoring": removes a Compose project (or one standalone container) from Quaymaster's view.
 *
 * This is a FILTER, nothing else. It never calls the Docker Engine, never runs `docker compose`, never touches a
 * file. The containers, volumes, networks, images and files of an ignored project are exactly as they were; they
 * are still protected from storage/image cleanup (those computations see everything), and the entry can be
 * restored at any time. The mutation is local state, so it is allowed in read-only mode and for resources outside
 * QM_MANAGED_SCOPE (hiding something is not acting on it).
 */
export class IgnoreService {
  constructor(
    private readonly d: {
      repo: IgnoreRepo;
      list: IgnoreList;
      compose: ComposeService;
      containers: ContainerService;
      guard: Guard;
      audit: AuditService;
      /** Called after every change (resets event baselines etc.). */
      onChange?: () => void;
    },
  ) {}

  list(): IgnoredEntry[] {
    return this.d.list.all();
  }

  private changed(): void {
    this.d.list.reload();
    this.d.compose.invalidate();
    this.d.containers.invalidate();
    this.d.onChange?.();
  }

  async ignore(req: IgnoreRequest, actor: Actor): Promise<IgnoredEntry> {
    const base = {
      actor: actor.name,
      ip: actor.ip,
      action: 'monitoring.stop',
      target: `${req.kind}:${req.name}`,
    };
    try {
      const entry = await this.doIgnore(req, actor);
      this.d.audit.record({
        ...base,
        outcome: 'success',
        params: {
          kind: req.kind,
          name: req.name,
          workingDir: entry.workingDir,
          dockerResourcesTouched: false,
        },
      });
      return entry;
    } catch (e) {
      this.d.audit.record({
        ...base,
        outcome: [403, 409].includes((e as { status?: number }).status ?? 0) ? 'denied' : 'failure',
        params: { kind: req.kind, name: req.name, error: (e as Error).message },
      });
      throw e;
    }
  }

  private async doIgnore(req: IgnoreRequest, actor: Actor): Promise<IgnoredEntry> {
    if (req.confirm !== req.name) {
      throw new AppError(409, 'confirmation_required', `Confirm by typing the name: "${req.name}"`, {
        expected: req.name,
      });
    }
    if (req.kind === 'project') {
      if (!PROJECT_NAME_RE.test(req.name)) throw badRequest('Invalid project name');
      const p = (await this.d.compose.discoverAll(true)).find((x) => x.name === req.name);
      if (!p) throw notFound('Compose project');
      const prot = this.d.guard.projectProtectedReason(p.name);
      if (prot)
        throw new AppError(
          409,
          'self_protected',
          `Refused: ${prot}. Quaymaster does not hide its own project.`,
        );
      const entry = this.d.repo.add('project', p.name, p.workingDir ?? '', actor.name);
      this.changed();
      return entry;
    }
    const all = await this.d.containers.listRawAll(true);
    const c = all.find((x) => (x.Names?.[0] ?? '').replace(/^\//, '') === req.name);
    if (!c) throw notFound('Container');
    if (c.Labels?.[LABEL.project])
      throw new AppError(
        409,
        'unsupported',
        `"${req.name}" belongs to Compose project "${c.Labels[LABEL.project]}"; stop monitoring the project instead`,
      );
    const prot = this.d.guard.containerProtectedReason({ id: c.Id, name: req.name, project: null });
    if (prot) throw new AppError(409, 'self_protected', `Refused: ${prot}`);
    const entry = this.d.repo.add('container', req.name, '', actor.name);
    this.changed();
    return entry;
  }

  restore(id: number, actor: Actor): IgnoredEntry {
    const base = { actor: actor.name, ip: actor.ip, action: 'monitoring.restore', target: `ignored:${id}` };
    const entry = this.d.repo.get(id);
    if (!entry) {
      this.d.audit.record({ ...base, outcome: 'failure', params: { error: 'not found' } });
      throw notFound('Ignored entry');
    }
    this.d.repo.remove(id);
    this.changed();
    this.d.audit.record({
      ...base,
      target: `${entry.kind}:${entry.name}`,
      outcome: 'success',
      params: { kind: entry.kind, name: entry.name, workingDir: entry.workingDir },
    });
    return entry;
  }
}
