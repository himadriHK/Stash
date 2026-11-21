import 'dotenv/config';

import { pathToFileURL } from 'node:url';

import helmet from '@fastify/helmet';
import Fastify from 'fastify';
import type { Logger } from 'pino';

import type { AppEnv } from '../config/env';
import { ConfigError, loadEnv } from '../config/env';
import { closeDatabase, openDatabase } from '../db/database';
import type { Db } from '../db/database';
import { createLogger } from '../logging/logger';
import { createBasicHealthRegistry } from '../observability/health';

export async function buildServer(env: AppEnv, db: Db, logger: Logger) {
  const health = createBasicHealthRegistry(db, env);
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: false,
    bodyLimit: 1_048_576,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  const startedAt = Date.now();

  app.get('/health/live', async () => ({
    status: 'ok',
    service: 'stash-host-node',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  }));

  app.get('/api/health', async (_request, reply) => {
    const report = await health.checkAll();
    if (report.status === 'down') {
      reply.code(503);
    }
    return report;
  });

  return { app, health };
}

async function main(): Promise<void> {
  let env: AppEnv;
  try {
    env = loadEnv();
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : 'Failed to load configuration';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(env);
  let db: Db | null = null;

  try {
    db = openDatabase(env.DB_PATH);
    const { app } = await buildServer(env, db, logger);

    await app.listen({ host: env.HOST, port: env.PORT });
    logger.info({ host: env.HOST, port: env.PORT }, 'Stash host node started');

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'Shutting down');
      try {
        await app.close();
      } catch (error) {
        logger.warn({ error }, 'Fastify close failed');
      }
      closeDatabase(db);
      db = null;
    };

    process.once('SIGINT', () => {
      void shutdown('SIGINT').then(() => process.exit(0));
    });
    process.once('SIGTERM', () => {
      void shutdown('SIGTERM').then(() => process.exit(0));
    });
  } catch (error) {
    logger.fatal({ error }, 'Failed to start Stash host node');
    closeDatabase(db);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  void main();
}


