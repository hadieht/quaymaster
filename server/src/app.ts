import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import type { ErrorEnvelope } from '@quaymaster/shared';
import type { AuthContext, Permission } from './auth/service.js';
import type { AppContext } from './context.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import { SECURITY_HEADERS } from './http/sse.js';
import { globalScrubber, redactDeep, redactText } from './redaction/redact.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerComposeRoutes } from './routes/compose.js';
import { registerContainerRoutes } from './routes/containers.js';
import { registerInventoryRoutes } from './routes/inventory.js';
import { registerMiscRoutes } from './routes/misc.js';
import { registerMaintenanceRoutes } from './routes/maintenance.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerUpdateRoutes } from './routes/updates.js';
import { registerWebApiRoutes } from './routes/webapi.js';
import { registerStreamRoutes } from './routes/streams.js';
import { registerSystemRoutes } from './routes/system.js';
import { AppError, forbidden, unauthorized } from './util/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const PUBLIC_PATHS = new Set(['/healthz', '/api/v1/auth/status', '/api/v1/auth/login', '/api/v1/auth/setup']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function cookieName(secure: boolean): string {
  return secure ? '__Host-qm_session' : 'qm_session';
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Origins accepted on state-changing requests: QM_PUBLIC_ORIGIN, or derived from the bind address. */
export function allowedOrigins(config: { publicOrigins: string[]; host: string; port: number }): Set<string> {
  if (config.publicOrigins.length > 0) return new Set(config.publicOrigins);
  const set = new Set<string>([`http://${config.host}:${config.port}`]);
  if (['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::'].includes(config.host)) {
    set.add(`http://127.0.0.1:${config.port}`);
    set.add(`http://localhost:${config.port}`);
  }
  return set;
}

/**
 * Pure CSRF/Origin decision for one request (RT-18). Safe methods are exempt (and must never have
 * side effects). Everything else needs an exact Origin match; authenticated requests also need the
 * session-bound token in `X-QM-CSRF`.
 */
export function checkMutationRequest(opts: {
  method: string;
  origin: string | undefined;
  allowed: Set<string>;
  csrfHeader: string | undefined;
  auth: AuthContext | null;
  verifyCsrf: (ctx: AuthContext, token: string | undefined) => boolean;
}): void {
  if (SAFE_METHODS.has(opts.method.toUpperCase())) return;
  if (!opts.origin || !opts.allowed.has(opts.origin)) {
    throw new AppError(403, 'origin', 'Missing or unexpected Origin header');
  }
  if (opts.auth && !opts.verifyCsrf(opts.auth, opts.csrfHeader)) {
    throw new AppError(403, 'csrf', 'Missing or invalid X-QM-CSRF token');
  }
}

export function parseBody<S extends ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success)
    throw new AppError(
      400,
      'validation',
      'Invalid request',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  return r.data as z.infer<S>;
}

export function requirePerm(ctx: AppContext, perm: Permission) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!req.auth) throw unauthorized();
    if (!ctx.auth.can(req.auth, perm)) {
      throw forbidden(
        perm === 'logs' ? 'Your account may not read container logs' : 'Administrator role required',
      );
    }
  };
}

export function actorOf(req: FastifyRequest): { name: string; ip: string | null } {
  return { name: req.auth?.user.username ?? 'anonymous', ip: req.ip };
}

/** The built UI directory, or null when it has not been built (API-only mode). */
export function resolveWebDir(configured: string | null | undefined): string | null {
  const dir = configured ?? path.resolve(import.meta.dirname, '../../web/dist');
  return existsSync(path.join(dir, 'index.html')) ? dir : null;
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const { config } = ctx;
  const app: FastifyInstance = Fastify({
    loggerInstance: ctx.log,
    trustProxy: config.trustProxy.length > 0 ? config.trustProxy : false,
    bodyLimit: 64 * 1024,
    routerOptions: { maxParamLength: 300 },
  }) as unknown as FastifyInstance;
  const origins = allowedOrigins(config);
  const cname = cookieName(config.cookieSecure);

  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req, reply) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    if (config.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    const url = req.url.split('?')[0] ?? '';
    if (url.startsWith('/api/') || url === '/healthz') reply.header('Cache-Control', 'no-store');

    const isApi = url.startsWith('/api/v1/');
    if (isApi && !PUBLIC_PATHS.has(url)) {
      const token = parseCookies(req.headers.cookie)[cname];
      req.auth = ctx.auth.authenticate(token);
      if (!req.auth) throw unauthorized();
    } else if (isApi) {
      const token = parseCookies(req.headers.cookie)[cname];
      req.auth = token ? ctx.auth.authenticate(token) : null;
    }
    if (isApi) {
      const origin = req.headers.origin;
      checkMutationRequest({
        method: req.method,
        origin: typeof origin === 'string' ? origin : undefined,
        allowed: origins,
        csrfHeader: typeof req.headers['x-qm-csrf'] === 'string' ? req.headers['x-qm-csrf'] : undefined,
        // public endpoints (login/setup) have no session yet: Origin is enough there
        auth: PUBLIC_PATHS.has(url) ? null : req.auth,
        verifyCsrf: (a, t) => ctx.auth.verifyCsrf(a, t),
      });
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    // Known-value scrubbing (RT-04): any literal secret learned from containers/projects is removed
    // from every JSON response, even where it sits in free text (e.g. a command string).
    const type = String(reply.getHeader('content-type') ?? '');
    if (typeof payload === 'string' && type.includes('application/json') && globalScrubber.size > 0) {
      return globalScrubber.scrub(payload);
    }
    return payload;
  });

  app.setErrorHandler(
    (
      err: Error & { statusCode?: number; validation?: unknown; code?: string },
      req: FastifyRequest,
      reply: FastifyReply,
    ) => {
      let status = 500;
      let code: ErrorEnvelope['error']['code'] = 'internal';
      let message = 'Internal server error';
      let details: unknown;
      if (err instanceof AppError) {
        status = err.status;
        code = err.code;
        message = err.message;
        details = err.details;
        for (const [k, v] of Object.entries(err.headers ?? {})) reply.header(k, v);
      } else if (err instanceof ZodError) {
        status = 400;
        code = 'validation';
        message = 'Invalid request';
        details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      } else if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
        status = err.statusCode;
        code = status === 413 ? 'validation' : status === 404 ? 'not_found' : 'validation';
        message =
          status === 413
            ? 'Request body too large'
            : status === 415
              ? 'Content-Type must be application/json'
              : 'Bad request';
      } else {
        req.log.error({ err }, 'unhandled error');
      }
      if (status >= 500 && !(err instanceof AppError)) message = 'Internal server error';
      const body: ErrorEnvelope = {
        error: {
          code,
          message: redactText(globalScrubber.scrub(message)),
          ...(details !== undefined ? { details: redactDeep(details) } : {}),
        },
      };
      void reply.status(status).send(body);
    },
  );

  const webDir = resolveWebDir(config.webDir);
  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0] ?? '';
    if (webDir && req.method === 'GET' && !url.startsWith('/api/') && !/\.[a-z0-9]{1,8}$/i.test(url)) {
      // SPA fallback: client-side routes are served index.html (never cached)
      void reply
        .header('Cache-Control', 'no-cache')
        .type('text/html; charset=utf-8')
        .send(readFileSync(path.join(webDir, 'index.html')));
      return;
    }
    void reply
      .status(404)
      .send({ error: { code: 'not_found', message: 'Route not found' } } satisfies ErrorEnvelope);
  });

  // RT-35: /healthz reveals nothing but liveness
  app.get('/healthz', async () => ({ status: 'ok' }));

  if (webDir) {
    await app.register(fastifyStatic, {
      root: webDir,
      wildcard: true,
      index: ['index.html'],
      setHeaders: (res, filePath) => {
        res.header(
          'Cache-Control',
          filePath.includes(`${path.sep}assets${path.sep}`)
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        );
      },
    });
  }

  const prefix = '/api/v1';
  await app.register(
    async (api) => {
      registerAuthRoutes(api, ctx);
      registerSystemRoutes(api, ctx);
      registerContainerRoutes(api, ctx);
      registerComposeRoutes(api, ctx);
      registerInventoryRoutes(api, ctx);
      registerMiscRoutes(api, ctx);
      registerUpdateRoutes(api, ctx);
      registerMaintenanceRoutes(api, ctx);
      registerNotificationRoutes(api, ctx);
      registerWebApiRoutes(api, ctx);
      registerStreamRoutes(api, ctx);
    },
    { prefix },
  );

  return app;
}
