import type { FastifyInstance } from 'fastify';
import type { ModeInfo } from '@quaymaster/shared';
import type { AppContext } from '../context.js';

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/system/mode', async (): Promise<ModeInfo> => {
    const self = ctx.guard.getSelf();
    return {
      readOnly: ctx.guard.readOnly,
      readOnlyReason: ctx.guard.readOnlyReason,
      managedScope: ctx.guard.scope,
      selfContainerId: self.containerId,
      selfProject: self.project,
      stackPaths: ctx.policy.allowedRoots,
    };
  });

  /** Authenticated health with details (RT-35: /healthz itself reveals nothing). */
  app.get('/system/health', async () => {
    let docker: 'ok' | 'unreachable' = 'ok';
    try {
      await ctx.docker.ping();
    } catch {
      docker = 'unreachable';
    }
    return {
      status: docker === 'ok' ? 'ok' : 'degraded',
      docker,
      apiVersion: ctx.handle.apiVersion,
      daemonApiVersion: ctx.handle.daemonApiVersion,
      engineVersion: ctx.handle.engineVersion,
      composeVersion: await ctx.runner.composeVersion(),
      eventStream: ctx.events.connected ? 'connected' : 'disconnected',
      uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
      streams: ctx.sse.count,
    };
  });

  app.get('/system/info', async () => ctx.system.info());
  app.get('/system/host', async () => ctx.system.host());

  app.get('/system/df', async (req) => {
    const refresh = (req.query as { refresh?: string }).refresh === '1';
    const usage = await ctx.disk.get({ force: refresh });
    return { usage, refreshing: usage === null };
  });
}
