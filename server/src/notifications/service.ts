import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import {
  NOTIFICATION_EVENT_TYPES,
  SEVERITY_RANK,
  type ChannelTestResult,
  type ChannelTypeInfo,
  type DeliveryRecord,
  type NotificationChannelInfo,
  type NotificationChannelInput,
  type NotificationEvent,
  type Severity,
} from '@quaymaster/shared';
import type { AuditService } from '../audit/audit.js';
import type { Db } from '../db/connection.js';
import type { SecretStore } from '../db/stats.js';
import { MASK, globalScrubber, maskUrlToSchemeHost, redactDeep, redactText } from '../redaction/redact.js';
import { AppError, badRequest, conflict, notFound } from '../util/errors.js';
import type { SendResult, Transport } from './channel.js';
import type { ChannelRegistry } from './registry.js';
import { defaultRegistry } from './registry.js';
import { NotificationRepo, type ChannelRow, type DeliveryRow } from './repo.js';
import { DefaultTransport } from './transport.js';

export interface Actor {
  name: string;
  ip: string | null;
}

export interface NotificationServiceDeps {
  db: Db;
  secrets: SecretStore;
  audit: AuditService;
  log: Logger;
  registry?: ChannelRegistry;
  transport?: Transport;
  clock?: () => number;
}

export interface ChannelPatch {
  name?: string;
  enabled?: boolean;
  minSeverity?: Severity;
  events?: string[];
  /** Omitted keys keep their stored value; `null` removes an optional key. */
  config?: Record<string, unknown>;
}

export const DEFAULT_COOLDOWN_MS = 15 * 60_000;
export const CRITICAL_COOLDOWN_MS = 5 * 60_000;
/** Delay after the n-th failed attempt (before jitter). */
export const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000] as const;
export const MAX_ATTEMPTS = 5;
const SEVERITIES: readonly Severity[] = ['info', 'warning', 'critical'];

const secretNameOf = (id: string): string => `notify:${id}`;

export class NotificationService {
  private readonly repo: NotificationRepo;
  private readonly secrets: SecretStore;
  private readonly audit: AuditService;
  private readonly log: Logger;
  private readonly registry: ChannelRegistry;
  private readonly transport: Transport;
  private readonly clock: () => number;
  private readonly inflight = new Set<Promise<void>>();
  private readonly busy = new Set<number>();
  private timer: NodeJS.Timeout | undefined;

  constructor(deps: NotificationServiceDeps) {
    this.repo = new NotificationRepo(deps.db);
    this.secrets = deps.secrets;
    this.audit = deps.audit;
    this.log = deps.log;
    this.registry = deps.registry ?? defaultRegistry();
    this.transport = deps.transport ?? new DefaultTransport();
    this.clock = deps.clock ?? Date.now;
  }

  // ------------------------------------------------------------------ lifecycle

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    try {
      for (const c of this.repo.listChannels()) this.feedScrubber(this.loadConfig(c));
    } catch (err) {
      this.log.warn({ err: this.errText(err) }, 'notifications: could not load channel secrets');
    }
    this.timer = setInterval(() => {
      void this.processRetries().catch((err) =>
        this.log.warn({ err: this.errText(err) }, 'notification retry loop failed'),
      );
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Resolves when all fire-and-forget deliveries started so far have finished (tests, shutdown). */
  async flush(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  types(): ChannelTypeInfo[] {
    return this.registry.info();
  }

  // ------------------------------------------------------------------ channels

  listChannels(): NotificationChannelInfo[] {
    return this.repo.listChannels().map((c) => this.toInfo(c));
  }

  getChannel(id: string): NotificationChannelInfo {
    return this.toInfo(this.mustGet(id));
  }

  createChannel(input: NotificationChannelInput, actor: Actor): NotificationChannelInfo {
    const impl = this.registry.get(input.type);
    if (!impl) throw badRequest(`Unknown channel type "${String(input.type)}"`);
    const name = this.checkName(input.name);
    const minSeverity = this.checkSeverity(input.minSeverity ?? 'info');
    const events = this.checkEvents(input.events ?? ['*']);
    if (this.repo.channelNameExists(name))
      throw conflict('conflict', `A channel named "${name}" already exists`);
    const config = impl.parseConfig(input.config);
    const id = `ch_${randomBytes(6).toString('hex')}`;
    const now = this.clock();
    const row: ChannelRow = {
      id,
      type: impl.type,
      name,
      enabled: input.enabled ?? true,
      minSeverity,
      events,
      secretName: secretNameOf(id),
      createdAt: now,
      updatedAt: now,
    };
    this.secrets.put(row.secretName, JSON.stringify(config));
    this.repo.insertChannel(row);
    this.feedScrubber(config);
    this.audit.record({
      actor: actor.name,
      ip: actor.ip,
      action: 'notifications.channel.create',
      target: id,
      params: { type: row.type, name, enabled: row.enabled },
      outcome: 'success',
    });
    return this.toInfo(row);
  }

  updateChannel(id: string, patch: ChannelPatch, actor: Actor): NotificationChannelInfo {
    const row = this.mustGet(id);
    const impl = this.registry.get(row.type);
    if (!impl) throw badRequest(`Unknown channel type "${row.type}"`);
    const next: ChannelRow = { ...row, updatedAt: this.clock() };
    if (patch.name !== undefined) {
      next.name = this.checkName(patch.name);
      if (this.repo.channelNameExists(next.name, id)) {
        throw conflict('conflict', `A channel named "${next.name}" already exists`);
      }
    }
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.minSeverity !== undefined) next.minSeverity = this.checkSeverity(patch.minSeverity);
    if (patch.events !== undefined) next.events = this.checkEvents(patch.events);
    let config: unknown;
    if (patch.config !== undefined) {
      const stored = this.loadConfig(row) as Record<string, unknown>;
      const secretFields = new Set(impl.fields.filter((f) => f.secret).map((f) => f.name));
      const merged: Record<string, unknown> = { ...stored };
      for (const [k, v] of Object.entries(patch.config)) {
        if (v === undefined) continue;
        if (v === null) delete merged[k];
        // A masked placeholder echoed back by a UI means "keep the stored value".
        else if (secretFields.has(k) && typeof v === 'string' && v.includes(MASK)) continue;
        else merged[k] = v;
      }
      config = impl.parseConfig(merged);
      this.secrets.put(row.secretName, JSON.stringify(config));
      this.feedScrubber(config);
    }
    this.repo.updateChannel(next);
    this.audit.record({
      actor: actor.name,
      ip: actor.ip,
      action: 'notifications.channel.update',
      target: id,
      params: {
        name: next.name,
        enabled: next.enabled,
        configChanged: patch.config !== undefined,
      },
      outcome: 'success',
    });
    return this.toInfo(next);
  }

  deleteChannel(id: string, actor: Actor): void {
    const row = this.mustGet(id);
    this.repo.deleteChannel(id);
    this.secrets.delete(row.secretName);
    this.audit.record({
      actor: actor.name,
      ip: actor.ip,
      action: 'notifications.channel.delete',
      target: id,
      params: { type: row.type, name: row.name },
      outcome: 'success',
    });
  }

  async testChannel(id: string, actor: Actor): Promise<ChannelTestResult> {
    const row = this.mustGet(id);
    const now = this.clock();
    const event = this.sanitize({
      type: 'test',
      severity: 'info',
      title: 'Quaymaster test notification',
      message: `This is a test notification for channel "${row.name}".`,
      ts: now,
    });
    const deliveryId = this.repo.insertDelivery({
      ts: now,
      channelId: id,
      eventType: 'test',
      severity: 'info',
      dedupeKey: null,
      title: event.title,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      httpStatus: null,
      eventJson: JSON.stringify(event),
    });
    const res = await this.deliver(row, event);
    this.repo.updateDeliveryResult(deliveryId, {
      status: res.ok ? 'sent' : 'failed',
      attempts: 1,
      nextAttemptAt: null, // tests are never retried
      lastError: res.error,
      httpStatus: res.httpStatus,
    });
    this.audit.record({
      actor: actor.name,
      ip: actor.ip,
      action: 'notifications.channel.test',
      target: id,
      params: { type: row.type, ok: res.ok, httpStatus: res.httpStatus },
      outcome: res.ok ? 'success' : 'failure',
    });
    return { ok: res.ok, httpStatus: res.httpStatus, error: res.error };
  }

  listDeliveries(opts: { limit?: number; channelId?: string; beforeId?: number } = {}): DeliveryRecord[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    return this.repo
      .listDeliveries({
        limit,
        ...(opts.channelId ? { channelId: opts.channelId } : {}),
        ...(opts.beforeId ? { beforeId: opts.beforeId } : {}),
      })
      .map((d) => ({
        id: d.id,
        time: new Date(d.ts).toISOString(),
        channelId: d.channelId,
        channelName: d.channelName,
        eventType: d.eventType,
        severity: d.severity,
        title: d.title,
        status: d.status,
        attempts: d.attempts,
        nextAttemptAt: d.nextAttemptAt === null ? null : new Date(d.nextAttemptAt).toISOString(),
        lastError: d.lastError,
        httpStatus: d.httpStatus,
      }));
  }

  /** Number of events suppressed so far for a channel + dedupe key (diagnostics, tests). */
  suppressedCount(channelId: string, key: string): number {
    return this.repo.suppressedCount(`${channelId}|${key}`);
  }

  // ------------------------------------------------------------------ emitting

  /** Fire-and-forget. Never throws; delivery failures never reach the caller. */
  emit(event: NotificationEvent): void {
    try {
      const p: Promise<void> = Promise.resolve()
        .then(() => this.dispatch(event))
        .catch((err) => {
          this.log.warn({ err: this.errText(err) }, 'notification dispatch failed');
        })
        .finally(() => {
          this.inflight.delete(p);
        });
      this.inflight.add(p);
    } catch (err) {
      try {
        this.log.warn({ err: this.errText(err) }, 'notification emit failed');
      } catch {
        /* never throw from emit */
      }
    }
  }

  private async dispatch(raw: NotificationEvent): Promise<void> {
    const now = this.clock();
    const event = this.sanitize({ ...raw, ts: raw.ts ?? now });
    const key = event.dedupeKey ?? `${event.type}:${event.title}`;
    const cooldown =
      event.cooldownMs ?? (event.severity === 'critical' ? CRITICAL_COOLDOWN_MS : DEFAULT_COOLDOWN_MS);
    const targets = this.repo.listChannels().filter((c) => this.matches(c, event));
    const sends: Promise<void>[] = [];
    for (const ch of targets) {
      try {
        const dk = `${ch.id}|${key}`;
        const last = this.repo.lastSent(dk);
        const base = {
          ts: now,
          channelId: ch.id,
          eventType: event.type,
          severity: event.severity,
          dedupeKey: key,
          title: event.title,
          attempts: 0,
          nextAttemptAt: null,
          lastError: null,
          httpStatus: null,
          eventJson: JSON.stringify(event),
        } as const;
        if (last !== undefined && now - last < cooldown) {
          this.repo.insertDelivery({ ...base, status: 'suppressed' });
          this.repo.bumpSuppressed(dk);
          continue;
        }
        this.repo.markSent(dk, now);
        const id = this.repo.insertDelivery({ ...base, status: 'pending' });
        sends.push(
          this.attempt(id).catch((err) => this.log.warn({ err: this.errText(err) }, 'delivery failed')),
        );
      } catch (err) {
        this.log.warn({ err: this.errText(err) }, 'notification routing failed');
      }
    }
    await Promise.all(sends);
  }

  private matches(c: ChannelRow, e: NotificationEvent): boolean {
    if (!c.enabled) return false;
    if (SEVERITY_RANK[c.minSeverity] > SEVERITY_RANK[e.severity]) return false;
    return c.events.includes('*') || c.events.includes(e.type);
  }

  // ------------------------------------------------------------------ delivery + retries

  /** Retries every failed delivery that is due. Returns the number of attempts made. */
  async processRetries(): Promise<number> {
    const due = this.repo.dueRetries(this.clock(), 50);
    let n = 0;
    for (const d of due) {
      if (this.busy.has(d.id)) continue;
      await this.attempt(d.id);
      n++;
    }
    return n;
  }

  private async attempt(deliveryId: number): Promise<void> {
    if (this.busy.has(deliveryId)) return;
    this.busy.add(deliveryId);
    try {
      const d = this.repo.getDelivery(deliveryId);
      if (!d || (d.status !== 'pending' && d.status !== 'failed')) return;
      const ch = this.repo.getChannel(d.channelId);
      const attempts = d.attempts + 1;
      let res: SendResult;
      if (!ch) {
        res = { ok: false, httpStatus: null, error: 'channel was deleted' };
      } else {
        let event: NotificationEvent;
        try {
          event = JSON.parse(d.eventJson) as NotificationEvent;
        } catch {
          event = { type: 'app.error', severity: d.severity, title: d.title, message: '' };
        }
        res = await this.deliver(ch, event);
      }
      if (res.ok) {
        this.repo.updateDeliveryResult(deliveryId, {
          status: 'sent',
          attempts,
          nextAttemptAt: null,
          lastError: null,
          httpStatus: res.httpStatus,
        });
        return;
      }
      const dead = !ch || attempts >= MAX_ATTEMPTS;
      this.repo.updateDeliveryResult(deliveryId, {
        status: dead ? 'dead' : 'failed',
        attempts,
        nextAttemptAt: dead ? null : this.clock() + this.backoff(attempts),
        lastError: res.error,
        httpStatus: res.httpStatus,
      });
    } finally {
      this.busy.delete(deliveryId);
    }
  }

  private backoff(attempts: number): number {
    const base = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

  /** Sends through the channel implementation; never throws; error text is redacted and short. */
  private async deliver(ch: ChannelRow, event: NotificationEvent): Promise<SendResult> {
    try {
      const impl = this.registry.get(ch.type);
      if (!impl) return { ok: false, httpStatus: null, error: `unknown channel type "${ch.type}"` };
      const config = impl.parseConfig(this.loadConfig(ch));
      const res = await impl.send(config, event, this.transport);
      return {
        ok: res.ok,
        httpStatus: res.httpStatus,
        error: res.error === null ? null : this.cleanError(res.error),
      };
    } catch (err) {
      return { ok: false, httpStatus: null, error: this.cleanError(this.errText(err)) };
    }
  }

  // ------------------------------------------------------------------ helpers

  private sanitize(e: NotificationEvent): NotificationEvent {
    const clean = (s: string): string => redactText(globalScrubber.scrub(s));
    const out: NotificationEvent = {
      type: e.type,
      severity: e.severity,
      title: clean(String(e.title)).slice(0, 300),
      message: clean(String(e.message)).slice(0, 4000),
    };
    if (e.dedupeKey !== undefined) out.dedupeKey = e.dedupeKey;
    if (e.cooldownMs !== undefined) out.cooldownMs = e.cooldownMs;
    if (e.ts !== undefined) out.ts = e.ts;
    if (e.data) {
      const data = redactDeep(e.data) as Record<string, string | number | boolean | null>;
      for (const [k, v] of Object.entries(data)) if (typeof v === 'string') data[k] = clean(v);
      out.data = data;
    }
    // Final pass over the serialised form so nothing the walkers missed gets persisted.
    return JSON.parse(globalScrubber.scrub(JSON.stringify(out))) as NotificationEvent;
  }

  private cleanError(s: string): string {
    return redactText(globalScrubber.scrub(s)).replace(/\s+/g, ' ').slice(0, 300);
  }

  private errText(err: unknown): string {
    return err instanceof AppError || err instanceof Error ? err.message : 'unknown error';
  }

  private mustGet(id: string): ChannelRow {
    const c = this.repo.getChannel(id);
    if (!c) throw notFound('Notification channel');
    return c;
  }

  private loadConfig(row: ChannelRow): unknown {
    const raw = this.secrets.get(row.secretName);
    if (raw === undefined) throw new Error(`channel ${row.id} has no stored configuration`);
    return JSON.parse(raw) as unknown;
  }

  private feedScrubber(config: unknown): void {
    if (typeof config !== 'object' || config === null) return;
    for (const v of Object.values(config as Record<string, unknown>)) {
      if (typeof v === 'string') {
        globalScrubber.add(v);
        try {
          const u = new URL(v);
          if (u.pathname.length > 1) globalScrubber.add(u.pathname);
          for (const seg of u.pathname.split('/')) if (seg.length >= 8) globalScrubber.add(seg);
          if (u.search.length > 1) globalScrubber.add(u.search.slice(1));
        } catch {
          /* not a URL */
        }
      } else if (typeof v === 'object' && v !== null) {
        for (const h of Object.values(v as Record<string, unknown>)) {
          if (typeof h === 'string') globalScrubber.add(h);
        }
      }
    }
  }

  private toInfo(row: ChannelRow): NotificationChannelInfo {
    const impl = this.registry.get(row.type);
    let config: Record<string, unknown> = {};
    try {
      const stored = this.loadConfig(row) as Record<string, unknown>;
      const specs = new Map((impl?.fields ?? []).map((f) => [f.name, f]));
      for (const [k, v] of Object.entries(stored)) {
        const spec = specs.get(k);
        if (!spec || spec.secret) {
          // Unknown keys are treated as secret; URL-like secrets show scheme://host/••••
          config[k] =
            typeof v === 'string' && (spec?.kind === 'url' || /^https?:\/\//i.test(v))
              ? maskUrlToSchemeHost(v)
              : MASK;
        } else {
          config[k] = v;
        }
      }
    } catch {
      config = {};
    }
    return {
      id: row.id,
      type: row.type as NotificationChannelInfo['type'],
      name: row.name,
      enabled: row.enabled,
      minSeverity: row.minSeverity,
      events: row.events,
      config,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }

  private checkName(name: unknown): string {
    if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 80) {
      throw badRequest('Channel name must be 1-80 characters');
    }
    return name.trim();
  }

  private checkSeverity(s: unknown): Severity {
    if (!SEVERITIES.includes(s as Severity)) throw badRequest('Invalid severity');
    return s as Severity;
  }

  private checkEvents(events: unknown): string[] {
    if (!Array.isArray(events) || events.length === 0) throw badRequest('events must be a non-empty list');
    const known = new Set<string>(['*', ...NOTIFICATION_EVENT_TYPES]);
    for (const e of events) {
      if (typeof e !== 'string' || !known.has(e)) throw badRequest('Unknown event type in events');
    }
    return [...new Set(events as string[])];
  }
}

export type { DeliveryRow };
