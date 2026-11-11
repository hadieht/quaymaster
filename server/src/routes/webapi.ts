import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody } from '../app.js';
import type { AppContext } from '../context.js';
import { cronError, isValidTimeZone, nextOccurrences } from '../maintenance/time.js';
import { notFound } from '../util/errors.js';

/** Endpoints added for the web UI (phase 3): settings overview, own sessions, cron preview, stats overview. */

const cronQuery = z.object({ cron: z.string().min(1).max(200), timezone: z.string().min(1).max(100) });
const overviewQuery = z.object({ minutes: z.coerce.number().int().min(5).max(1440).default(60) });

export interface OverviewPoint {
  /** epoch ms (start of the minute) */
  t: number;
  /** summed CPU of all containers, percent of one core */
  cpu: number;
  /** summed memory usage in bytes */
  mem: number;
  /** summed network receive / transmit rate in bytes per second */
  netRx: number;
  netTx: number;
}

export function registerWebApiRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Operational, non-secret configuration (read-only; changed through environment variables). */
  app.get('/system/settings', async () => {
    const c = ctx.config;
    return {
      version: process.env['npm_package_version'] ?? '0.1.0',
      retention: {
        eventDays: c.eventRetentionDays,
        auditDays: c.auditRetentionDays,
        statsHours: c.stats.retentionHours,
        rollbackDays: Math.round(c.rollbackRetentionMs / 86_400_000),
        cleanupMinAgeHours: Math.round(c.cleanupMinAgeMs / 3_600_000),
        approvalExpiryHours: Math.round(c.approvalExpiryMs / 3_600_000),
      },
      session: {
        idleMinutes: Math.round(c.session.idleMs / 60_000),
        absoluteHours: Math.round(c.session.absoluteMs / 3_600_000),
      },
      limits: {
        sseMaxPerSession: c.sse.maxPerSession,
        sseMaxTotal: c.sse.maxTotal,
        diskFloorBytes: c.diskFloorBytes,
      },
      security: {
        cookieSecure: c.cookieSecure,
        publicOrigins: c.publicOrigins,
        redactAllEnv: c.redactAllEnv,
        protectedNames: c.protectedNames,
      },
    };
  });

  /** The caller's own sessions (never anyone else's). */
  app.get('/auth/sessions', async (req) => {
    const me = req.auth;
    if (!me) return { sessions: [] };
    return {
      sessions: ctx.auth.listSessions(me.user.id).map((s) => ({
        id: s.id_hash,
        createdAt: new Date(s.created_at).toISOString(),
        lastSeenAt: new Date(s.last_seen).toISOString(),
        expiresAt: new Date(s.expires_at).toISOString(),
        ip: s.ip,
        userAgent: s.user_agent ? s.user_agent.slice(0, 200) : null,
        current: s.id_hash === me.session.id_hash,
      })),
    };
  });

  app.delete<{ Params: { id: string } }>('/auth/sessions/:id', async (req) => {
    const me = req.auth;
    if (!me || !ctx.auth.revokeSession(me.user.id, req.params.id, me.session.id_hash)) {
      throw notFound('Session');
    }
    ctx.audit.record({
      actor: me.user.username,
      ip: req.ip,
      action: 'auth.session_revoke',
      outcome: 'success',
    });
    return { ok: true };
  });

  /** Validates a cron expression and lists the next runs (same DST rules the scheduler uses). */
  app.get('/maintenance/cron/preview', async (req) => {
    const q = parseBody(cronQuery, req.query);
    if (!isValidTimeZone(q.timezone))
      return { valid: false, error: `Unknown time zone "${q.timezone}"`, nextRuns: [] };
    const err = cronError(q.cron);
    if (err) return { valid: false, error: err, nextRuns: [] };
    return {
      valid: true,
      error: null,
      nextRuns: nextOccurrences(q.cron, q.timezone, Date.now(), 5).map((t) => new Date(t).toISOString()),
    };
  });

  /** Host-wide container resource history (1-minute roll-ups, summed over all containers). */
  app.get('/stats/overview', async (req) => {
    const q = parseBody(overviewQuery, req.query);
    const nowMin = Math.floor(Date.now() / 60_000);
    const rows = ctx.statsRepo.since(nowMin - q.minutes);
    const byMinute = new Map<number, OverviewPoint>();
    const slot = (m: number): OverviewPoint => {
      let p = byMinute.get(m);
      if (!p) {
        p = { t: m * 60_000, cpu: 0, mem: 0, netRx: 0, netTx: 0 };
        byMinute.set(m, p);
      }
      return p;
    };
    const prev = new Map<string, { minute: number; rx: number; tx: number }>();
    for (const r of rows) {
      const p = slot(r.minute);
      p.cpu += r.cpu_avg;
      p.mem += r.mem_avg;
      const before = prev.get(r.container_id);
      // network counters are cumulative: a rate needs two samples, and a drop means a restart (skip)
      if (before && r.minute > before.minute && r.net_rx >= before.rx && r.net_tx >= before.tx) {
        const secs = (r.minute - before.minute) * 60;
        p.netRx += (r.net_rx - before.rx) / secs;
        p.netTx += (r.net_tx - before.tx) / secs;
      }
      prev.set(r.container_id, { minute: r.minute, rx: r.net_rx, tx: r.net_tx });
    }
    return { points: [...byMinute.values()].sort((a, b) => a.t - b.t) };
  });
}
