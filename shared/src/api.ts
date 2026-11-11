/**
 * API contract shared by server and web. Types only: this package has no runtime
 * code so that the server never needs it at run time.
 */

export type ErrorCode =
  | 'validation'
  | 'unauthorized'
  | 'forbidden'
  | 'csrf'
  | 'origin'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'read_only'
  | 'out_of_scope'
  | 'self_protected'
  | 'confirmation_required'
  | 'blocked_drift'
  | 'limited_capability'
  | 'unsupported'
  | 'docker_unavailable'
  | 'compose_failed'
  | 'approval_stale'
  | 'window_closed'
  | 'insufficient_disk'
  | 'registry_error'
  | 'setup_required'
  | 'internal';

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export type Role = 'admin' | 'viewer';

export interface UserInfo {
  id: number;
  username: string;
  role: Role;
  /** Viewers only see container logs when this is true (admins always can). */
  logsRead: boolean;
  disabled: boolean;
  createdAt: string;
}

export interface AuthStatus {
  setupRequired: boolean;
  authenticated: boolean;
}

export interface SessionInfo {
  user: UserInfo;
  csrfToken: string;
  expiresAt: string;
  idleExpiresAt: string;
}

export interface ModeInfo {
  readOnly: boolean;
  readOnlyReason: string | null;
  managedScope: string[];
  selfContainerId: string | null;
  selfProject: string | null;
  stackPaths: string[];
}

export type ContainerState = 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead';

export interface PortInfo {
  ip?: string;
  privatePort: number;
  publicPort?: number;
  type: string;
}

export interface ContainerSummary {
  id: string;
  shortId: string;
  name: string;
  image: string;
  imageId: string;
  state: ContainerState;
  status: string;
  health: 'healthy' | 'unhealthy' | 'starting' | 'none';
  createdAt: string;
  ports: PortInfo[];
  labels: Record<string, string>;
  composeProject: string | null;
  composeService: string | null;
  /** Why mutations on this container are refused right now (null = allowed). */
  protectedReason: string | null;
  mutable: boolean;
  /** `standalone` for containers without Compose labels; otherwise the level of their project. */
  capability?: CapabilityLevel;
  /** From `inspect` (list endpoint only): how often Docker restarted it, and when it last started. */
  restartCount?: number;
  startedAt?: string | null;
}

export type ContainerAction =
  'start' | 'stop' | 'restart' | 'kill' | 'pause' | 'unpause' | 'remove' | 'recreate';

export interface ActionRequest {
  /** Must equal the container/project name for destructive actions (remove, recreate, down). */
  confirm?: string;
  /** Separate explicit confirmation to apply configuration drift (Compose recreate/redeploy). */
  applyDrift?: boolean;
  /** Confirms recreating a service other services share a namespace/volumes with. */
  confirmNamespaceProvider?: boolean;
  signal?: string;
  timeoutSeconds?: number;
}

export type CapabilityLevel = 'full' | 'limited' | 'standalone';

export interface ComposeContainerRef {
  id: string;
  name: string;
  state: ContainerState;
  health: string;
  imageId: string;
  configHash: string | null;
}

export interface ComposeServiceInfo {
  name: string;
  image: string | null;
  containers: ComposeContainerRef[];
  status: 'running' | 'stopped' | 'partial' | 'not-created' | 'unhealthy';
  replicas: number;
}

export interface ComposeProjectSummary {
  name: string;
  level: CapabilityLevel;
  /** Human-readable reasons for level `limited` (empty for full). */
  reasons: string[];
  workingDir: string | null;
  configFiles: string[];
  source: 'containers' | 'scan' | 'both';
  status: 'running' | 'stopped' | 'partial' | 'down' | 'unhealthy';
  services: ComposeServiceInfo[];
  composeVersions: string[];
  protectedReason: string | null;
  mutable: boolean;
}

export type DependencyEdgeKind = 'depends_on' | 'shares_namespace' | 'volumes_from';
export interface DependencyGraph {
  nodes: string[];
  edges: {
    from: string;
    to: string;
    kind: DependencyEdgeKind;
    condition?: string;
    restart?: boolean;
    required?: boolean;
  }[];
  /** Services in start order (dependencies first). Empty when the graph has a cycle. */
  order: string[];
  cycle: string[] | null;
}

export type ComposeAction = 'up' | 'stop' | 'start' | 'restart' | 'down' | 'redeploy';
export interface ComposeActionRequest extends ActionRequest {
  service?: string;
  forceRecreate?: boolean;
}

export type OperationStatus = 'running' | 'succeeded' | 'failed';
export interface OperationInfo {
  id: string;
  kind: string;
  target: string;
  status: OperationStatus;
  startedAt: string;
  finishedAt: string | null;
  actor: string;
  composeVersion: string | null;
  output: string;
  error: string | null;
}

export interface ImageSummary {
  id: string;
  shortId: string;
  tags: string[];
  digests: string[];
  size: number;
  createdAt: string;
  containers: {
    id: string;
    name: string;
    state: string;
    composeProject: string | null;
    composeService: string | null;
  }[];
  inUse: boolean;
}

export interface VolumeSummary {
  name: string;
  driver: string;
  mountpoint: string;
  createdAt: string | null;
  labels: Record<string, string>;
  composeProject: string | null;
  usedBy: string[];
  size: number | null;
}

export interface NetworkSummary {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  composeProject: string | null;
  containers: string[];
  labels: Record<string, string>;
}

export interface HostMetrics {
  cpuPercent: number | null;
  load: [number, number, number];
  memTotal: number;
  memAvailable: number;
  uptimeSeconds: number;
  dockerRoot: { path: string; total: number; free: number } | null;
  dockerRootError: string | null;
}

export interface StatsPoint {
  t: number;
  cpu: number;
  memUsage: number;
  memLimit: number;
  netRx: number;
  netTx: number;
  blkRead: number;
  blkWrite: number;
}

export interface DockerEventRecord {
  id: number;
  time: string;
  type: string;
  action: string;
  actorId: string;
  name: string | null;
  image: string | null;
  project: string | null;
  service: string | null;
  attributes: Record<string, string>;
  synthetic: boolean;
}

export interface AuditEntry {
  id: number;
  time: string;
  actor: string;
  ip: string | null;
  action: string;
  target: string | null;
  params: unknown;
  outcome: 'success' | 'failure' | 'denied';
  durationMs: number | null;
}
