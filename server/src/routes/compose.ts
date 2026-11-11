import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ComposeAction } from '@quaymaster/shared';
import { actorOf, parseBody, requirePerm } from '../app.js';
import type { AppContext } from '../context.js';
import { PROJECT_NAME_RE } from '../compose/argv.js';
import { badRequest } from '../util/errors.js';

const ACTIONS: readonly ComposeAction[] = ['up', 'stop', 'start', 'restart', 'down', 'redeploy'];
const actionBody = z
  .object({
    service: z.string().max(100).optional(),
    forceRecreate: z.boolean().optional(),
    confirm: z.string().max(300).optional(),
    applyDrift: z.boolean().optional(),
    confirmNamespaceProvider: z.boolean().optional(),
  })
  .strict();

function projectName(raw: string): string {
  if (!PROJECT_NAME_RE.test(raw)) throw badRequest('Invalid project name');
  return raw;
}

export function registerComposeRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/compose/projects', async () => ctx.compose.discover());

  app.get<{ Params: { name: string } }>('/compose/projects/:name', async (req) =>
    ctx.compose.detail(projectName(req.params.name)),
  );

  app.get<{ Params: { name: string } }>('/compose/projects/:name/graph', async (req) => {
    const d = await ctx.compose.detail(projectName(req.params.name));
    return { graph: d.graph, namespaceProviders: d.namespaceProviders };
  });

  /** Redacted resolved configuration (secrets are masked server-side; there is no reveal API). */
  app.get<{ Params: { name: string } }>('/compose/projects/:name/config', async (req) =>
    ctx.compose.configView(projectName(req.params.name)),
  );

  /** `docker compose config --quiet` plus path-policy checks. Read-only. */
  app.get<{ Params: { name: string } }>('/compose/projects/:name/validate', async (req) =>
    ctx.compose.validate(projectName(req.params.name)),
  );

  app.post<{ Params: { name: string; action: string } }>(
    '/compose/projects/:name/actions/:action',
    { preHandler: requirePerm(ctx, 'write') },
    async (req, reply) => {
      const action = req.params.action as ComposeAction;
      if (!ACTIONS.includes(action)) throw badRequest(`Unknown action "${req.params.action}"`);
      const body = parseBody(actionBody, req.body);
      const res = await ctx.compose.operate(projectName(req.params.name), action, body, actorOf(req));
      void reply.status(202);
      return res;
    },
  );
}
