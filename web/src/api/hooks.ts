import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { api, describeError } from './client';
import { useToast } from '@/components/ui/Toast';
import type {
  AuditEntry,
  ChannelTypeInfo,
  ComposeProjectDetail,
  ComposeProjectSummary,
  ComposeValidation,
  IgnoredEntry,
  ProjectFilesView,
  ContainerDetail,
  ContainerSummary,
  DependencyGraph,
  DeliveryRecord,
  DiskUsage,
  DockerEventRecord,
  DockerInfoLite,
  HealthInfo,
  HostMetrics,
  ImageSummary,
  ImageUpdateStatus,
  LogLineDto,
  MaintenanceWindow,
  ModeInfo,
  MonitorSettings,
  NetworkSummary,
  NotificationChannelInfo,
  OperationInfo,
  PolicyRecord,
  QuarantineEntry,
  RegistryCredentialInfo,
  RollbackPoint,
  Rollup,
  RunDetail,
  RunInfo,
  Schedule,
  SessionEntry,
  StagedImage,
  StatsPoint,
  SystemSettings,
  UserInfo,
  VolumeSummary,
  CronPreview,
} from './types';

const SECOND = 1000;

/** Read queries. Lists refresh in the background so the UI stays current even without SSE. */
export const q = {
  mode: () => ({
    queryKey: ['mode'],
    queryFn: () => api.get<ModeInfo>('/system/mode'),
    staleTime: 60 * SECOND,
  }),
  health: () => ({
    queryKey: ['health'],
    queryFn: () => api.get<HealthInfo>('/system/health'),
    refetchInterval: 30 * SECOND,
  }),
  info: () => ({
    queryKey: ['info'],
    queryFn: () => api.get<DockerInfoLite>('/system/info'),
    staleTime: 60 * SECOND,
  }),
  host: () => ({
    queryKey: ['host'],
    queryFn: () => api.get<HostMetrics>('/system/host'),
    refetchInterval: 10 * SECOND,
  }),
  df: () => ({
    queryKey: ['df'],
    queryFn: () => api.get<{ usage: DiskUsage | null; refreshing: boolean }>('/system/df'),
    refetchInterval: (query: { state: { data?: { refreshing: boolean } } }) =>
      query.state.data?.refreshing ? 3 * SECOND : 5 * 60 * SECOND,
  }),
  containers: () => ({
    queryKey: ['containers'],
    queryFn: () => api.get<ContainerSummary[]>('/containers'),
    refetchInterval: 10 * SECOND,
  }),
  container: (ref: string) => ({
    queryKey: ['container', ref],
    queryFn: () => api.get<ContainerDetail>(`/containers/${encodeURIComponent(ref)}`),
    refetchInterval: 10 * SECOND,
  }),
  containerStats: (ref: string) => ({
    queryKey: ['container-stats', ref],
    queryFn: () => api.get<{ points: StatsPoint[] }>(`/containers/${encodeURIComponent(ref)}/stats`),
    refetchInterval: 30 * SECOND,
  }),
  containerHistory: (ref: string, minutes: number) => ({
    queryKey: ['container-history', ref, minutes],
    queryFn: () =>
      api.get<{ rollups: Rollup[] }>(`/containers/${encodeURIComponent(ref)}/stats/history`, { minutes }),
    refetchInterval: 60 * SECOND,
  }),
  logs: (ref: string, tail: number) => ({
    queryKey: ['logs', ref, tail],
    queryFn: () => api.get<{ lines: LogLineDto[] }>(`/containers/${encodeURIComponent(ref)}/logs`, { tail }),
    retry: false,
  }),
  projects: () => ({
    queryKey: ['projects'],
    queryFn: () => api.get<ComposeProjectSummary[]>('/compose/projects'),
    refetchInterval: 15 * SECOND,
  }),
  project: (name: string) => ({
    queryKey: ['project', name],
    queryFn: () => api.get<ComposeProjectDetail>(`/compose/projects/${encodeURIComponent(name)}`),
    refetchInterval: 15 * SECOND,
  }),
  projectGraph: (name: string) => ({
    queryKey: ['project-graph', name],
    queryFn: () => api.get<DependencyGraph>(`/compose/projects/${encodeURIComponent(name)}/graph`),
  }),
  projectConfig: (name: string, enabled: boolean) => ({
    queryKey: ['project-config', name],
    queryFn: () => api.get<ProjectFilesView>(`/compose/projects/${encodeURIComponent(name)}/config`),
    enabled,
    retry: false,
  }),
  projectValidate: (name: string, enabled: boolean) => ({
    queryKey: ['project-validate', name],
    queryFn: () => api.get<ComposeValidation>(`/compose/projects/${encodeURIComponent(name)}/validate`),
    enabled,
    retry: false,
  }),
  ignored: () => ({
    queryKey: ['ignored'],
    queryFn: () => api.get<{ entries: IgnoredEntry[] }>('/ignored'),
  }),
  images: () => ({
    queryKey: ['images'],
    queryFn: () => api.get<ImageSummary[]>('/images'),
    refetchInterval: 30 * SECOND,
  }),
  updates: () => ({
    queryKey: ['updates'],
    queryFn: () => api.get<{ images: ImageUpdateStatus[] }>('/updates'),
    refetchInterval: 60 * SECOND,
  }),
  staged: () => ({
    queryKey: ['staged'],
    queryFn: () => api.get<{ staged: StagedImage[]; rollbackPoints: RollbackPoint[] }>('/images/staged'),
    refetchInterval: 30 * SECOND,
  }),
  quarantine: () => ({
    queryKey: ['quarantine'],
    queryFn: () => api.get<{ entries: QuarantineEntry[] }>('/updates/quarantine'),
  }),
  volumes: () => ({
    queryKey: ['volumes'],
    queryFn: () => api.get<VolumeSummary[]>('/volumes'),
    refetchInterval: 30 * SECOND,
  }),
  networks: () => ({
    queryKey: ['networks'],
    queryFn: () => api.get<NetworkSummary[]>('/networks'),
    refetchInterval: 30 * SECOND,
  }),
  events: (limit: number, filters: { container?: string; project?: string } = {}) => ({
    queryKey: ['events', limit, filters],
    queryFn: () => api.get<{ events: DockerEventRecord[] }>('/events', { limit, ...filters }),
  }),
  audit: (filters: { action?: string; actor?: string; beforeId?: number }) => ({
    queryKey: ['audit', filters],
    queryFn: () => api.get<{ entries: AuditEntry[] }>('/audit', { limit: 100, ...filters }),
  }),
  operations: () => ({
    queryKey: ['operations'],
    queryFn: () => api.get<{ operations: OperationInfo[] }>('/operations'),
    refetchInterval: 10 * SECOND,
  }),
  policies: () => ({
    queryKey: ['policies'],
    queryFn: () => api.get<{ policies: PolicyRecord[] }>('/maintenance/policies'),
  }),
  windows: () => ({
    queryKey: ['windows'],
    queryFn: () => api.get<{ windows: MaintenanceWindow[] }>('/maintenance/windows'),
    refetchInterval: 60 * SECOND,
  }),
  schedules: () => ({
    queryKey: ['schedules'],
    queryFn: () => api.get<{ schedules: Schedule[] }>('/maintenance/schedules'),
    refetchInterval: 60 * SECOND,
  }),
  runs: (limit = 50) => ({
    queryKey: ['runs', limit],
    queryFn: () => api.get<{ runs: RunInfo[] }>('/maintenance/runs', { limit }),
    refetchInterval: 10 * SECOND,
  }),
  run: (id: string) => ({
    queryKey: ['run', id],
    queryFn: () => api.get<RunDetail>(`/maintenance/runs/${encodeURIComponent(id)}`),
    refetchInterval: (query: { state: { data?: RunDetail } }) => {
      const s = query.state.data?.status;
      return s === 'running' || s === 'approved' ? 2 * SECOND : 15 * SECOND;
    },
  }),
  monitors: () => ({ queryKey: ['monitors'], queryFn: () => api.get<MonitorSettings>('/monitors/settings') }),
  settings: () => ({ queryKey: ['settings'], queryFn: () => api.get<SystemSettings>('/system/settings') }),
  channels: () => ({
    queryKey: ['channels'],
    queryFn: () => api.get<NotificationChannelInfo[]>('/notifications/channels'),
  }),
  channelTypes: () => ({
    queryKey: ['channel-types'],
    queryFn: () => api.get<ChannelTypeInfo[]>('/notifications/types'),
    staleTime: 600 * SECOND,
  }),
  deliveries: () => ({
    queryKey: ['deliveries'],
    queryFn: () => api.get<DeliveryRecord[]>('/notifications/deliveries', { limit: 30 }),
  }),
  credentials: () => ({
    queryKey: ['credentials'],
    queryFn: () => api.get<{ credentials: RegistryCredentialInfo[] }>('/registries/credentials'),
  }),
  users: () => ({ queryKey: ['users'], queryFn: () => api.get<UserInfo[]>('/users') }),
  sessions: () => ({
    queryKey: ['sessions'],
    queryFn: () => api.get<{ sessions: SessionEntry[] }>('/auth/sessions'),
  }),
  overview: (minutes: number) => ({
    queryKey: ['overview', minutes],
    queryFn: () =>
      api.get<{ points: { t: number; cpu: number; mem: number; netRx: number; netTx: number }[] }>(
        '/stats/overview',
        {
          minutes,
        },
      ),
    refetchInterval: 30 * SECOND,
  }),
  cronPreview: (cron: string, timezone: string) => ({
    queryKey: ['cron-preview', cron, timezone],
    queryFn: () => api.get<CronPreview>('/maintenance/cron/preview', { cron, timezone }),
    enabled: cron.trim().split(/\s+/).length >= 5,
    retry: false,
    staleTime: 60 * SECOND,
  }),
};

export function useApiQuery<T>(opts: {
  queryKey: QueryKey;
  queryFn: () => Promise<T>;
  [k: string]: unknown;
}) {
  return useQuery(opts as never) as ReturnType<typeof useQuery<T>>;
}

/** Keys invalidated after any state-changing action (Docker state changes in many views at once). */
const DOCKER_KEYS = [
  'containers',
  'container',
  'projects',
  'project',
  'ignored',
  'images',
  'updates',
  'staged',
  'volumes',
  'networks',
  'df',
  'runs',
  'run',
  'operations',
];

export function useInvalidateDocker() {
  const qc = useQueryClient();
  return () => {
    for (const k of DOCKER_KEYS) void qc.invalidateQueries({ queryKey: [k] });
  };
}

/**
 * A state-changing call with a success toast and a toast for failures. Components that need inline
 * errors (dialogs) use `mutateAsync` and handle the thrown ApiError themselves.
 */
export function useAction<V, R = unknown>(
  fn: (v: V) => Promise<R>,
  opts: {
    success?: string | ((r: R, v: V) => string);
    invalidate?: string[];
    docker?: boolean;
    quietError?: boolean;
  } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  const invalidateDocker = useInvalidateDocker();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, v) => {
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r, v) : opts.success);
      if (opts.docker) invalidateDocker();
      for (const k of opts.invalidate ?? []) void qc.invalidateQueries({ queryKey: [k] });
    },
    onError: (e) => {
      if (!opts.quietError) toast.error('Action failed', describeError(e));
    },
  });
}
