/** Updates, maintenance and cleanup contract (spec sections 7.1–7.6, amended by RT-06…RT-29). */

// ---- update detection ---------------------------------------------------------------------

export type UpdateState =
  'up_to_date' | 'update_available' | 'update_staged' | 'local_only' | 'pinned_digest' | 'unknown';

export interface ImageUser {
  containerId: string;
  containerName: string;
  project: string | null;
  service: string | null;
  imageId: string;
}

export interface ImageUpdateStatus {
  /** Image reference as written in the container / Compose file. */
  ref: string;
  state: UpdateState;
  /** Why (always set for `unknown` / `local_only` / `pinned_digest`). */
  reason: string | null;
  localDigest: string | null;
  remoteDigest: string | null;
  checkedAt: string | null;
  source: 'registry' | 'engine' | 'cache' | 'none';
  /** A (target, remote digest) that failed before is skipped by unattended runs (RT-22). */
  quarantined: boolean;
  usedBy: ImageUser[];
}

export interface RegistryCredentialInfo {
  host: string;
  username: string;
  updatedAt: string;
}

// ---- policies, windows, schedules ---------------------------------------------------------

export type UpdateMode = 'ignore' | 'notify' | 'pull_only' | 'auto';
export type PolicyScopeKind = 'global' | 'project' | 'service' | 'container';

export interface HealthPolicy {
  /** Upper bound for the health gate (raised automatically to the healthcheck's own timings, RT-10). */
  timeoutSeconds: number;
  /** How long a container without a healthcheck must stay running with a stable restart count. */
  stabilizationSeconds: number;
  /** Optional HTTP probe run from the server; it only gates a rollback once it passed on the current version. */
  probe: { url: string; expectStatus: number } | null;
}

/** What is stored at one level. Every field is optional: unset = inherit. */
export interface PolicyInput {
  updateMode?: UpdateMode;
  critical?: boolean;
  requireApproval?: boolean;
  autoRollback?: boolean;
  health?: Partial<HealthPolicy>;
  maxParallel?: number;
  updateOrder?: number;
}

export interface PolicyRecord {
  scopeKind: PolicyScopeKind;
  scopeKey: string;
  policy: PolicyInput;
  updatedAt: string;
}

export interface EffectivePolicy {
  updateMode: UpdateMode;
  critical: boolean;
  requireApproval: boolean;
  /** Explicit setting after AND-combining the levels; null = nobody set it (the default depends on mounts, RT-10). */
  autoRollbackExplicit: boolean | null;
  /** `true` was set at project/global level: it applies to stateless services only (RT-10). */
  autoRollbackBroad?: boolean;
  health: HealthPolicy;
  maxParallel: number;
  updateOrder: number | null;
  /** Which level each field came from. */
  sources: Record<string, string>;
}

export interface MaintenanceWindowInput {
  name: string;
  /** 0 = Sunday … 6 = Saturday; refers to the day the window STARTS (RT-09). */
  days: number[];
  /** Local wall-clock `HH:MM`. `end <= start` means the window crosses midnight; start == end is rejected. */
  start: string;
  end: string;
  /** IANA time zone. */
  timezone: string;
  enabled?: boolean;
}

export interface MaintenanceWindow extends Required<MaintenanceWindowInput> {
  id: string;
  createdAt: string;
  /** Is the window open right now? */
  openNow: boolean;
  /** Start of the next occurrence (ISO), if any. */
  nextStart: string | null;
}

export type ScheduleJobType = 'image_check' | 'image_pull' | 'update' | 'cleanup_report';
export type ScheduleMode = 'manual' | 'auto';

export interface ScheduleInput {
  name: string;
  cron: string;
  timezone: string;
  jobType: ScheduleJobType;
  /** `update`: `{ project }` or `{ container }` (one target per schedule). Other jobs act host-wide. */
  selector?: { project?: string; container?: string; services?: string[] };
  mode: ScheduleMode;
  windowId?: string | null;
  enabled?: boolean;
}

export interface Schedule extends Required<Omit<ScheduleInput, 'selector'>> {
  id: string;
  selector: { project?: string; container?: string; services?: string[] };
  createdAt: string;
  nextRuns: string[];
}

// ---- plan ---------------------------------------------------------------------------------

export interface PlanMount {
  type: string;
  source: string;
  target: string;
  readOnly: boolean;
}

export interface PlanService {
  service: string;
  role: 'update' | 'dependent';
  /** For dependents: why they are recreated (RT-11). */
  dependentOf?: string;
  containers: { id: string; name: string }[];
  /** Image reference as configured. */
  ref: string;
  fromImageId: string;
  fromDigest: string | null;
  toDigest: string | null;
  configHash: string | null;
  /** The service was stopped before: it is updated with `up --no-start` and stays stopped (RT-28). */
  wasRunning: boolean;
  oneShot: boolean;
  autoRollback: boolean;
  autoRollbackReason: string;
  health: {
    kind: 'healthcheck' | 'stability' | 'oneshot';
    timeoutSeconds: number;
    stabilizationSeconds: number;
    probe: HealthPolicy['probe'];
  };
  downtime: string;
  dataRisk: { flagged: boolean; mounts: PlanMount[]; note: string };
  critical: boolean;
  requireApproval: boolean;
  updateMode: UpdateMode;
  unattended: { eligible: boolean; blockers: string[] };
  quarantined: boolean;
}

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PlanImpact {
  /** Services that depend on an updated service (directly or transitively). */
  dependents: { service: string; via: string; kind: string }[];
  /** Containers on the host that reference the same tag (RT-07). */
  sharedTag: {
    ref: string;
    containerName: string;
    project: string | null;
    service: string | null;
    inRun: boolean;
    note: string;
  }[];
}

export interface Plan {
  version: 1;
  kind: 'compose' | 'standalone';
  /** Compose project name, or the standalone container name. */
  target: string;
  createdAt: string;
  /** Execution order (dependencies first). */
  order: string[];
  services: PlanService[];
  excluded: { service: string; reason: string }[];
  preflight: { ok: boolean; checks: PreflightCheck[] };
  validation: { valid: boolean; errors: string[]; warnings: string[] };
  drift: { service: string; running: string[]; wanted: string }[];
  impact: PlanImpact;
  disk: { requiredBytes: number | null; freeBytes: number | null; floorBytes: number; ok: boolean };
  blocked: { code: string; message: string } | null;
  warnings: string[];
  planHash: string;
}

// ---- runs ---------------------------------------------------------------------------------

export type RunKind = 'dry_run' | 'update' | 'image_check' | 'image_pull' | 'cleanup_report';
export type RunStatus =
  | 'planned'
  | 'awaiting_approval'
  | 'approved'
  | 'running'
  | 'completed'
  | 'failed'
  | 'partial'
  | 'rolled_back'
  | 'skipped'
  | 'interrupted'
  | 'approval_stale'
  | 'blocked'
  | 'rejected';

export const FINAL_RUN_STATUSES: readonly RunStatus[] = [
  'planned',
  'completed',
  'failed',
  'partial',
  'rolled_back',
  'skipped',
  'interrupted',
  'approval_stale',
  'blocked',
  'rejected',
];

export type StepName =
  | 'preflight'
  | 'validate'
  | 'check'
  | 'recovery_point'
  | 'pull'
  | 'impact'
  | 'deploy'
  | 'health'
  | 'rollback'
  | 'record';

export interface RunStep {
  id: number;
  seq: number;
  service: string | null;
  step: StepName | string;
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  startedAt: string;
  finishedAt: string | null;
  detail: Record<string, unknown> | null;
}

export type ServiceOutcome =
  'updated' | 'rolled_back' | 'failed' | 'failed_left_as_is' | 'skipped' | 'dependent_recreated';

export interface RunResult {
  services: { service: string; outcome: ServiceOutcome; detail: string }[];
  summary: string;
}

export interface RunInfo {
  id: string;
  kind: RunKind;
  trigger: 'manual' | 'schedule';
  scheduleId: string | null;
  occurrence: string | null;
  windowId: string | null;
  windowEnd: string | null;
  target: string;
  status: RunStatus;
  reason: string | null;
  planHash: string | null;
  requestedBy: string;
  approvalExpiresAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  approvedPlanHash: string | null;
  result: RunResult | null;
  /** Exact manual recovery commands / next steps when a run did not end cleanly. */
  guidance: string[] | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunDetail extends RunInfo {
  plan: Plan | null;
  steps: RunStep[];
}

export interface QuarantineEntry {
  target: string;
  digest: string;
  runId: string | null;
  reason: string | null;
  createdAt: string;
}

// ---- cleanup ------------------------------------------------------------------------------

export type CleanupCategory = 'dangling_images' | 'unused_images' | 'stopped_containers' | 'expired_rollback';

export interface CleanupCandidate {
  id: string;
  category: CleanupCategory;
  /** What is removed: image ID/tag, or container ID. */
  name: string;
  size: number | null;
  ageHours: number | null;
  note: string;
}

export interface CleanupProtected {
  name: string;
  category: CleanupCategory | 'volume' | 'network';
  reason: string;
}

export interface CleanupPreview {
  previewId: string;
  expiresAt: string;
  categories: CleanupCategory[];
  minAgeHours: number;
  candidates: CleanupCandidate[];
  protected: CleanupProtected[];
  /** Reported only: Quaymaster never deletes volumes or networks in bulk (RT-24). */
  reportOnly: { unusedVolumes: string[]; unusedNetworks: string[] };
  totalBytes: number;
}

export interface CleanupResult {
  removed: { id: string; name: string }[];
  skipped: { id: string; name: string; reason: string }[];
  reclaimedBytes: number;
}

// ---- monitors -----------------------------------------------------------------------------

export interface MonitorSettings {
  enabled: boolean;
  diskFreePercentBelow: number;
  diskFreeBytesBelow: number;
  cpuPercentAbove: number;
  memoryPercentAbove: number;
  /** Sustained for this long before an alert fires. */
  sustainSeconds: number;
  restartLoopCount: number;
  restartLoopWindowSeconds: number;
  upcomingMaintenanceMinutes: number;
}
