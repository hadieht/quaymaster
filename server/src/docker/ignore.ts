import type { IgnoredEntry } from '@quaymaster/shared';
import type { IgnoreRepo } from '../db/ignore.js';
import { LABEL } from './model.js';

/**
 * In-memory view of the ignore list with the matching rules in ONE place.
 *
 *  - project entry: matches containers/projects with the same Compose project name AND the same recorded
 *    working directory ('' matches only projects that have no working directory)
 *  - container entry: matches a standalone (non-Compose) container by name
 *
 * Ignoring is a filter only. Nothing here ever calls Docker.
 */
export class IgnoreList {
  private entries: IgnoredEntry[] = [];

  constructor(private readonly repo: IgnoreRepo) {
    this.reload();
  }

  reload(): void {
    this.entries = this.repo.list();
  }

  all(): IgnoredEntry[] {
    return this.entries;
  }

  isProjectIgnored(name: string, workingDir: string | null): boolean {
    const wd = workingDir ?? '';
    return this.entries.some((e) => e.kind === 'project' && e.name === name && e.workingDir === wd);
  }

  /** For stored history (events) that only knows names: hides anything whose project or name is on the list. */
  hidesRecord(project: string | null, name: string | null): boolean {
    return this.entries.some(
      (e) =>
        (e.kind === 'project' && project !== null && e.name === project) ||
        (e.kind === 'container' && e.name === name),
    );
  }

  isContainerIgnored(name: string, labels: Record<string, string> | null | undefined): boolean {
    const project = labels?.[LABEL.project];
    if (project) return this.isProjectIgnored(project, labels?.[LABEL.workingDir] ?? null);
    const n = name.replace(/^\//, '');
    return this.entries.some((e) => e.kind === 'container' && e.name === n);
  }
}
