import type {
  ContainerState,
  ContainerSummary,
  ComposeProjectSummary,
  RunStatus,
  Severity,
  UpdateState,
  CapabilityLevel,
  DeliveryStatus,
} from '@quaymaster/shared';

/** The single status colour language. Every badge, chart marker and icon maps onto one of these. */
export type Tone = 'healthy' | 'warning' | 'critical' | 'inactive' | 'info';

export function containerTone(state: ContainerState, health: ContainerSummary['health']): Tone {
  if (state === 'restarting' || state === 'dead') return 'critical';
  if (health === 'unhealthy') return 'critical';
  if (state === 'running') return health === 'starting' ? 'warning' : 'healthy';
  if (state === 'paused' || state === 'removing') return 'warning';
  return 'inactive';
}

export function composeTone(s: ComposeProjectSummary['status']): Tone {
  switch (s) {
    case 'running':
      return 'healthy';
    case 'partial':
      return 'warning';
    case 'unhealthy':
      return 'critical';
    default:
      return 'inactive';
  }
}

export function serviceTone(s: string): Tone {
  switch (s) {
    case 'running':
      return 'healthy';
    case 'partial':
      return 'warning';
    case 'unhealthy':
      return 'critical';
    default:
      return 'inactive';
  }
}

export function runTone(s: RunStatus): Tone {
  switch (s) {
    case 'completed':
      return 'healthy';
    case 'running':
    case 'approved':
    case 'planned':
      return 'info';
    case 'awaiting_approval':
    case 'partial':
    case 'rolled_back':
    case 'approval_stale':
    case 'skipped':
      return 'warning';
    case 'failed':
    case 'interrupted':
    case 'blocked':
      return 'critical';
    default:
      return 'inactive';
  }
}

export function stepTone(s: string): Tone {
  return s === 'succeeded' ? 'healthy' : s === 'failed' ? 'critical' : s === 'running' ? 'info' : 'inactive';
}

export function updateTone(s: UpdateState): Tone {
  switch (s) {
    case 'up_to_date':
      return 'healthy';
    case 'update_available':
      return 'info';
    case 'update_staged':
      return 'warning';
    default:
      return 'inactive';
  }
}

export const UPDATE_LABEL: Record<UpdateState, string> = {
  up_to_date: 'Up to date',
  update_available: 'Update available',
  update_staged: 'Update staged',
  local_only: 'Local image',
  pinned_digest: 'Pinned digest',
  unknown: 'Unknown',
};

export function severityTone(s: Severity): Tone {
  return s === 'critical' ? 'critical' : s === 'warning' ? 'warning' : 'info';
}

export function outcomeTone(o: 'success' | 'failure' | 'denied'): Tone {
  return o === 'success' ? 'healthy' : o === 'failure' ? 'critical' : 'warning';
}

export function deliveryTone(s: DeliveryStatus): Tone {
  return s === 'sent' ? 'healthy' : s === 'failed' || s === 'dead' ? 'critical' : s === 'pending' ? 'info' : 'inactive';
}

export function capabilityTone(l: CapabilityLevel): Tone {
  return l === 'full' ? 'healthy' : l === 'limited' ? 'warning' : 'inactive';
}

export const CAPABILITY_TEXT: Record<CapabilityLevel, { label: string; text: string }> = {
  full: {
    label: 'Full control',
    text: 'Quaymaster can read this project’s Compose files, so it can validate them, show the resolved configuration and update or recreate services safely.',
  },
  limited: {
    label: 'Limited',
    text: 'The Compose files are missing, outside the allowed stack paths or not trustworthy. You can start, stop and restart containers, but not update, redeploy or show the configuration.',
  },
  standalone: {
    label: 'Standalone',
    text: 'Started with docker run (no Compose project). You can start, stop, restart and remove it; updating is a manual, confirmed operation.',
  },
};

/** Border / text / background classes for each tone (kept literal so Tailwind sees them). */
export const TONE_CLASSES: Record<Tone, { text: string; bg: string; border: string; dot: string; bar: string }> = {
  healthy: { text: 'text-healthy', bg: 'bg-healthy/10', border: 'border-healthy/30', dot: 'bg-healthy', bar: 'bg-healthy' },
  warning: { text: 'text-warning', bg: 'bg-warning/10', border: 'border-warning/30', dot: 'bg-warning', bar: 'bg-warning' },
  critical: { text: 'text-critical', bg: 'bg-critical/10', border: 'border-critical/30', dot: 'bg-critical', bar: 'bg-critical' },
  inactive: { text: 'text-inactive', bg: 'bg-inactive/10', border: 'border-inactive/30', dot: 'bg-inactive', bar: 'bg-inactive' },
  info: { text: 'text-info', bg: 'bg-info/10', border: 'border-info/30', dot: 'bg-info', bar: 'bg-info' },
};
