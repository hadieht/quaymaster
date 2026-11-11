import type { CapabilityLevel, ContainerSummary, RunStatus, UpdateState } from '@/api/types';
import { Badge } from '@/components/ui';
import {
  CAPABILITY_TEXT,
  UPDATE_LABEL,
  capabilityTone,
  composeTone,
  containerTone,
  runTone,
  serviceTone,
  updateTone,
} from '@/lib/status';

export function ContainerStatus({ c }: { c: Pick<ContainerSummary, 'state' | 'health'> }) {
  const label =
    c.state === 'running' && c.health === 'unhealthy'
      ? 'unhealthy'
      : c.state === 'running' && c.health === 'starting'
        ? 'starting'
        : c.state === 'running' && c.health === 'healthy'
          ? 'healthy'
          : c.state;
  return <Badge tone={containerTone(c.state, c.health)}>{label}</Badge>;
}

export function HealthBadge({ health }: { health: ContainerSummary['health'] }) {
  if (health === 'none') return <span className="text-muted">–</span>;
  return (
    <Badge tone={health === 'healthy' ? 'healthy' : health === 'starting' ? 'warning' : 'critical'}>
      {health}
    </Badge>
  );
}

export function UpdateBadge({ state }: { state: UpdateState }) {
  return <Badge tone={updateTone(state)}>{UPDATE_LABEL[state]}</Badge>;
}

export function RunBadge({ status }: { status: RunStatus }) {
  return <Badge tone={runTone(status)}>{status.replace(/_/g, ' ')}</Badge>;
}

export function CapabilityBadge({ level }: { level: CapabilityLevel }) {
  return (
    <Badge tone={capabilityTone(level)} title={CAPABILITY_TEXT[level].text}>
      {CAPABILITY_TEXT[level].label}
    </Badge>
  );
}

export function ProjectStatus({ status }: { status: string }) {
  return <Badge tone={status === 'down' ? 'inactive' : composeTone(status as never)}>{status}</Badge>;
}

export function ServiceStatus({ status }: { status: string }) {
  return <Badge tone={serviceTone(status)}>{status}</Badge>;
}
