import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config/env.js';
import { createContext } from './context.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n\nSee .env.example for every supported variable.\n`);
      process.exit(2);
    }
    throw e;
  }
  const ctx = await createContext(config);
  const app = await buildApp(ctx);
  await app.listen({ host: config.host, port: config.port });
  ctx.log.info(
    {
      host: config.host,
      port: config.port,
      readOnly: ctx.guard.readOnly,
      scope: config.managedScope,
      stackPaths: ctx.policy.allowedRoots,
      docker: ctx.handle.engineVersion,
      apiVersion: ctx.handle.apiVersion,
      setup: ctx.setupOutcome,
    },
    'Quaymaster started',
  );

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    ctx.log.info({ signal }, 'shutting down');
    void (async () => {
      await app.close();
      await ctx.shutdown();
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((e: unknown) => {
  process.stderr.write(`Fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
