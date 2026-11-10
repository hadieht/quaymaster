import type { AuditRepo } from '../db/audit.js';
import { globalScrubber, redactDeep } from '../redaction/redact.js';

export type Clock = () => number;

export interface AuditInput {
  actor: string;
  ip?: string | null;
  action: string;
  target?: string | null;
  params?: unknown;
  outcome: 'success' | 'failure' | 'denied';
  durationMs?: number | null;
}

/**
 * Append-only audit log. Parameters are redacted (whole-object walk plus known-value scrubbing)
 * before they are stored. There is deliberately no update or delete method.
 */
export class AuditService {
  constructor(
    private readonly repo: AuditRepo,
    private readonly clock: Clock = Date.now,
  ) {}

  record(e: AuditInput): void {
    const params = e.params === undefined ? null : globalScrubber.scrub(JSON.stringify(redactDeep(e.params)));
    this.repo.insert({
      ts: this.clock(),
      actor: e.actor,
      ip: e.ip ?? null,
      action: e.action,
      target: e.target ?? null,
      params,
      outcome: e.outcome,
      duration_ms: e.durationMs ?? null,
    });
  }

  list(opts: Parameters<AuditRepo['list']>[0]): ReturnType<AuditRepo['list']> {
    return this.repo.list(opts);
  }
}

/** Runs `fn`, records the outcome and duration. Re-throws errors after recording them. */
export async function audited<T>(
  audit: AuditService,
  base: Omit<AuditInput, 'outcome' | 'durationMs'>,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    audit.record({ ...base, outcome: 'success', durationMs: Date.now() - t0 });
    return result;
  } catch (err) {
    const denied = typeof err === 'object' && err !== null && 'status' in err && [403, 409].includes((err as { status: number }).status);
    audit.record({
      ...base,
      params: { ...(typeof base.params === 'object' && base.params ? base.params : {}), error: (err as Error).message },
      outcome: denied ? 'denied' : 'failure',
      durationMs: Date.now() - t0,
    });
    throw err;
  }
}
