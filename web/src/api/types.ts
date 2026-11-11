import type { ComposeServiceInfo, ComposeProjectSummary, ContainerSummary, DependencyGraph } from '@quaymaster/shared';

export * from '@quaymaster/shared';

/** Redacted `docker inspect` output; the UI only reads what it renders. */
export interface InspectData {
  Id: string;
  Name: string;
  Created: string;
  Path?: string;
  Args?: string[];
  State: {
    Status: string;
    Running: boolean;
    Paused: boolean;
    Restarting: boolean;
    OOMKilled: boolean;
    ExitCode: number;
    Error?: string;
    StartedAt: string;
    FinishedAt: string;
    Health?: { Status: string; FailingStreak: number; Log?: { ExitCode: number; Output: string; End: string }[] };
  };
  RestartCount?: number;
  Image: string;
  HostConfig?: {
    RestartPolicy?: { Name: string; MaximumRetryCount?: number };
    NetworkMode?: string;
    Privileged?: boolean;
    Memory?: number;
    NanoCpus?: number;
  };
  Config: {
    Image: string;
    Env?: string[];
    Cmd?: string[] | null;
    Entrypoint?: string[] | string | null;
    Labels?: Record<string, string>;
    User?: string;
    WorkingDir?: string;
    Tty?: boolean;
  };
  Mounts?: { Type: string; Name?: string; Source: string; Destination: string; RW: boolean; Mode?: string }[];
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string; Gateway?: string; Aliases?: string[] | null; MacAddress?: string }>;
    Ports?: Record<string, { HostIp: string; HostPort: string }[] | null>;
  };
}

export interface ContainerDetail {
  summary: ContainerSummary | null;
  inspect: InspectData;
}

export interface HealthInfo {
  status: 'ok' | 'degraded';
  docker: 'ok' | 'unreachable';
  apiVersion: string;
  daemonApiVersion: string;
  engineVersion: string;
  composeVersion: string | null;
  eventStream: 'connected' | 'disconnected';
  uptimeSeconds: number;
  streams: number;
}

export interface DiskUsage {
  refreshedAt: string;
  images: { count: number; layersSize: number; totalSize: number; unusedCount: number };
  containers: Record<string, { sizeRw: number; sizeRootFs: number }>;
  volumes: Record<string, number>;
}

export interface DockerInfoLite {
  Containers?: number;
  ContainersRunning?: number;
  ContainersPaused?: number;
  ContainersStopped?: number;
  Images?: number;
  ServerVersion?: string;
  OperatingSystem?: string;
  KernelVersion?: string;
  NCPU?: number;
  MemTotal?: number;
  Name?: string;
  Driver?: string;
  DockerRootDir?: string;
}

export interface LogLineDto {
  stream: 'stdout' | 'stderr';
  ts: string | null;
  text: string;
}

export interface Rollup {
  container_id: string;
  minute: number;
  name: string;
  samples: number;
  cpu_avg: number;
  cpu_max: number;
  mem_avg: number;
  mem_max: number;
  net_rx: number;
  net_tx: number;
  blk_read: number;
  blk_write: number;
}

export interface ComposeProjectDetail {
  summary: ComposeProjectSummary;
  graph: DependencyGraph;
  services: ComposeServiceInfo[];
  /** provider service → services that share its namespace/volumes */
  namespaceProviders: Record<string, string[]>;
}

export interface ComposeValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  [k: string]: unknown;
}

export interface StagedImage {
  tag: string;
  ref: string;
  digest: string;
  imageId: string;
  createdAt: string;
}
export interface RollbackPoint {
  tag: string;
  runId: string;
  project: string | null;
  service: string | null;
  ref: string;
  imageId: string;
  createdAt: string;
  expiresAt: string;
  released: boolean;
}

/** `GET /system/settings` (added in phase 3): operational, non-secret configuration. */
export interface SystemSettings {
  version: string;
  retention: { eventDays: number; auditDays: number; statsHours: number; rollbackDays: number; cleanupMinAgeHours: number; approvalExpiryHours: number };
  session: { idleMinutes: number; absoluteHours: number };
  limits: { sseMaxPerSession: number; sseMaxTotal: number; diskFloorBytes: number };
  security: { cookieSecure: boolean; publicOrigins: string[]; redactAllEnv: boolean; protectedNames: string[] };
}

export interface SessionEntry {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export interface CronPreview {
  valid: boolean;
  error: string | null;
  nextRuns: string[];
}

