import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthStatus, UserInfo } from '@quaymaster/shared';
import { cookieName, parseBody, parseCookies, requirePerm } from '../app.js';
import { toUserInfo, type AuthContext } from '../auth/service.js';
import type { AppContext } from '../context.js';
import { unauthorized } from '../util/errors.js';

const loginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(1024) });
const setupBody = z.object({
  token: z.string().min(1).max(200),
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
});
const passwordBody = z.object({ current: z.string().min(1).max(1024), next: z.string().min(1).max(1024) });
const createUserBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
  role: z.enum(['admin', 'viewer']),
  logsRead: z.boolean().optional(),
});
const patchUserBody = z.object({
  role: z.enum(['admin', 'viewer']).optional(),
  logsRead: z.boolean().optional(),
  disabled: z.boolean().optional(),
});
const setPasswordBody = z.object({ password: z.string().min(1).max(1024) });
const idParam = z.object({ id: z.coerce.number().int().positive() });

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { config, auth } = ctx;
  const cname = cookieName(config.cookieSecure);

  const setSessionCookie = (reply: FastifyReply, token: string): void => {
    const maxAge = Math.floor(config.session.absoluteMs / 1000);
    reply.header(
      'Set-Cookie',
      `${cname}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`,
    );
  };
  const clearCookie = (reply: FastifyReply): void => {
    reply.header(
      'Set-Cookie',
      `${cname}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${config.cookieSecure ? '; Secure' : ''}`,
    );
  };

  app.get('/auth/status', async (req): Promise<AuthStatus> => {
    const token = parseCookies(req.headers.cookie)[cname];
    return { setupRequired: ctx.setup.required(), authenticated: !!auth.authenticate(token) };
  });

  app.post('/auth/setup', async (req, reply) => {
    const body = parseBody(setupBody, req.body);
    const user = await ctx.setup.complete({ ...body, ip: req.ip });
    ctx.audit.record({ actor: user.username, ip: req.ip, action: 'auth.setup', outcome: 'success' });
    const { token, ctx: session } = auth.createSession(user, req.ip, req.headers['user-agent'] ?? null);
    setSessionCookie(reply, token);
    return auth.sessionInfo(session);
  });

  app.post('/auth/login', async (req, reply) => {
    const body = parseBody(loginBody, req.body);
    const { token, ctx: session } = await auth.login({
      username: body.username,
      password: body.password,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    setSessionCookie(reply, token);
    return auth.sessionInfo(session);
  });

  app.post('/auth/logout', async (req, reply) => {
    if (!req.auth) throw unauthorized();
    auth.logout(req.auth);
    ctx.audit.record({
      actor: req.auth.user.username,
      ip: req.ip,
      action: 'auth.logout',
      outcome: 'success',
    });
    clearCookie(reply);
    return { ok: true };
  });

  app.post('/auth/logout-all', async (req, reply) => {
    if (!req.auth) throw unauthorized();
    auth.logoutAll(req.auth.user.id);
    ctx.audit.record({
      actor: req.auth.user.username,
      ip: req.ip,
      action: 'auth.logout_all',
      outcome: 'success',
    });
    clearCookie(reply);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    if (!req.auth) throw unauthorized();
    return auth.sessionInfo(req.auth);
  });

  app.post('/auth/password', async (req) => {
    const session = req.auth as AuthContext;
    const body = parseBody(passwordBody, req.body);
    await auth.changePassword(session, body.current, body.next);
    ctx.audit.record({
      actor: session.user.username,
      ip: req.ip,
      action: 'auth.password_change',
      outcome: 'success',
    });
    return { ok: true, note: 'All other sessions were signed out' };
  });

  // ---- user management (admin) ------------------------------------------------------------
  const admin = { preHandler: requirePerm(ctx, 'write') };

  app.get('/users', admin, async (): Promise<UserInfo[]> => ctx.usersRepo.list().map(toUserInfo));

  app.post('/users', admin, async (req, reply) => {
    const body = parseBody(createUserBody, req.body);
    const user = await auth.createUser(body);
    ctx.audit.record({
      actor: (req.auth as AuthContext).user.username,
      ip: req.ip,
      action: 'user.create',
      target: user.username,
      params: { role: user.role },
      outcome: 'success',
    });
    void reply.status(201);
    return toUserInfo(user);
  });

  app.patch('/users/:id', admin, async (req) => {
    const { id } = parseBody(idParam, req.params);
    const patch = parseBody(patchUserBody, req.body);
    const user = auth.updateUser(id, patch);
    ctx.audit.record({
      actor: (req.auth as AuthContext).user.username,
      ip: req.ip,
      action: 'user.update',
      target: user.username,
      params: patch,
      outcome: 'success',
    });
    return toUserInfo(user);
  });

  app.post('/users/:id/password', admin, async (req) => {
    const { id } = parseBody(idParam, req.params);
    const { password } = parseBody(setPasswordBody, req.body);
    await auth.adminSetPassword(id, password);
    ctx.audit.record({
      actor: (req.auth as AuthContext).user.username,
      ip: req.ip,
      action: 'user.set_password',
      target: String(id),
      outcome: 'success',
    });
    return { ok: true };
  });

  app.delete('/users/:id', admin, async (req) => {
    const { id } = parseBody(idParam, req.params);
    const target = ctx.usersRepo.byId(id);
    auth.deleteUser(id);
    ctx.audit.record({
      actor: (req.auth as AuthContext).user.username,
      ip: req.ip,
      action: 'user.delete',
      target: target?.username ?? String(id),
      outcome: 'success',
    });
    return { ok: true };
  });
}
