/** Notification contract shared by server and web (spec section 8). */

export type Severity = 'info' | 'warning' | 'critical';

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export type NotificationEventType =
  | 'container.died'
  | 'container.unhealthy'
  | 'container.restart_loop'
  | 'updates.available'
  | 'maintenance.upcoming'
  | 'maintenance.awaiting_approval'
  | 'run.succeeded'
  | 'run.failed'
  | 'run.rolled_back'
  | 'run.partial'
  | 'run.skipped'
  | 'run.interrupted'
  | 'run.conflict'
  | 'service.left_down'
  | 'cleanup.report'
  | 'host.disk_low'
  | 'host.cpu_high'
  | 'host.memory_high'
  | 'app.error'
  | 'test';

export const NOTIFICATION_EVENT_TYPES: readonly NotificationEventType[] = [
  'container.died',
  'container.unhealthy',
  'container.restart_loop',
  'updates.available',
  'maintenance.upcoming',
  'maintenance.awaiting_approval',
  'run.succeeded',
  'run.failed',
  'run.rolled_back',
  'run.partial',
  'run.skipped',
  'run.interrupted',
  'run.conflict',
  'service.left_down',
  'cleanup.report',
  'host.disk_low',
  'host.cpu_high',
  'host.memory_high',
  'app.error',
  'test',
];

/** What producers (monitors, the maintenance engine) hand to the notification service. */
export interface NotificationEvent {
  type: NotificationEventType;
  severity: Severity;
  title: string;
  message: string;
  /** Events with the same key inside the cool-down are delivered once (default key: type + title). */
  dedupeKey?: string;
  /** Cool-down for this event (default 15 minutes). */
  cooldownMs?: number;
  /** Small, non-secret structured details (rendered as fields where a channel supports it). */
  data?: Record<string, string | number | boolean | null>;
  /** Epoch ms; filled in by the service when absent. */
  ts?: number;
}

export type ChannelType = 'webhook' | 'ntfy' | 'gotify' | 'discord' | 'slack' | 'telegram' | 'smtp';

export interface ChannelFieldSpec {
  name: string;
  label: string;
  kind: 'string' | 'url' | 'secret' | 'number' | 'boolean' | 'email' | 'string_list';
  required: boolean;
  /** True for fields that are write-only: the API never returns them. */
  secret: boolean;
  help?: string;
}

export interface ChannelTypeInfo {
  type: ChannelType;
  label: string;
  fields: ChannelFieldSpec[];
}

export interface NotificationChannelInfo {
  id: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  minSeverity: Severity;
  /** Event types this channel receives; `["*"]` = all. */
  events: string[];
  /** Non-secret configuration; secret and URL-like fields are replaced by a mask. */
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationChannelInput {
  type: ChannelType;
  name: string;
  enabled?: boolean;
  minSeverity?: Severity;
  events?: string[];
  config: Record<string, unknown>;
}

export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'suppressed' | 'dead';

export interface DeliveryRecord {
  id: number;
  time: string;
  channelId: string;
  channelName: string | null;
  eventType: string;
  severity: Severity;
  title: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  httpStatus: number | null;
}

export interface ChannelTestResult {
  ok: boolean;
  httpStatus: number | null;
  /** A short, redacted reason; response bodies are never returned (RT-21). */
  error: string | null;
}
