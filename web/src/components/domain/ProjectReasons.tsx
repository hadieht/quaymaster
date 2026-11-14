import type { FileAccess, MountHint, ProjectReason } from '@/api/types';
import { CodeBlock, Notice } from '@/components/ui';

/** Short operator-facing title per reason code. */
export const REASON_TITLE: Record<ProjectReason['code'], string> = {
  not_mounted: 'Project folder is not mounted into Quaymaster',
  not_readable: 'Project folder is not readable',
  file_missing: 'Compose file is missing',
  untrusted: 'Compose file is not trusted',
  path_not_allowed: 'Folder is outside the allowed stack paths',
  no_labels: 'No Compose labels on the containers',
  conflict: 'Conflicting project definitions',
  unsafe_name: 'Project name is not usable',
  remote_include: 'Compose file includes remote content',
  duplicate_dir: 'Several projects share one folder',
};

/** Copy-pasteable lines that make the project folder visible to Quaymaster. */
export function MountHintView({ hint }: { hint: MountHint }) {
  return (
    <div className="mt-2 space-y-2 text-sm" data-testid="mount-hint">
      <div>
        Add this line to the <code>volumes:</code> list of the Quaymaster service, then recreate it:
      </div>
      <CodeBlock maxHeight="max-h-24">{hint.volume}</CodeBlock>
      <div>Only if automatic mount detection is turned off, also allow the path:</div>
      <CodeBlock maxHeight="max-h-24">{hint.stackPaths}</CodeBlock>
    </div>
  );
}

/**
 * Explains why a project has limited control: one entry per reason reported by the server, plus the
 * mount hint when the folder is not visible to Quaymaster.
 */
export function ProjectReasons({
  reasons,
  mountHint,
  fileAccess,
}: {
  reasons: ProjectReason[];
  mountHint: MountHint | null;
  fileAccess: FileAccess;
}) {
  if (!reasons.length) return null;
  return (
    <div className="mb-4 space-y-2" data-testid="project-reasons">
      {reasons.map((r) => (
        <Notice key={`${r.code}:${r.message}`} tone="warning" title={REASON_TITLE[r.code] ?? r.code}>
          <div>{r.message}</div>
          {r.hint ? <div className="mt-1 text-muted">{r.hint}</div> : null}
        </Notice>
      ))}
      {fileAccess === 'helper' ? (
        <Notice tone="info" title="Files are read through a temporary read-only helper">
          The project files are shown read-only. Values from <code>.env</code> are never displayed, only their
          names.
        </Notice>
      ) : null}
      {mountHint ? (
        <Notice tone="info" title="How to give Quaymaster access">
          <MountHintView hint={mountHint} />
        </Notice>
      ) : null}
    </div>
  );
}
