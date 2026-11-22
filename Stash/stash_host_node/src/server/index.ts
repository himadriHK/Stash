import dotenv from 'dotenv';

import { pathToFileURL } from 'node:url';

import helmet from '@fastify/helmet';
import Fastify from 'fastify';
import type { Logger } from 'pino';

import { registerDashboardRoutes } from '../api/dashboardRoutes';
import { registerSettingsRoutes } from '../api/settingsRoutes';
import type { AppEnv } from '../config/env';
import { ConfigError, loadEnv } from '../config/env';
import { DashboardService } from '../dashboard/dashboardService';
import { closeDatabase, openDatabase } from '../db/database';
import type { Db } from '../db/database';
import { createLogger } from '../logging/logger';
import { createBasicHealthRegistry } from '../observability/health';
import type { PipelineRuntimeStatus } from '../pipeline/runtime';
import { PipelineRuntime } from '../pipeline/runtime';
import { SettingsService } from '../settings/settingsService';
import { registerDashboardAuth } from './auth';
import { resolveProjectPaths } from './paths';
import { registerStaticUi } from './ui';

export interface BuildServerOptions {
  publicDir?: string;
  envPath?: string;
  environment?: NodeJS.ProcessEnv;
  startedAt?: number;
  version?: string;
  settingsService?: SettingsService;
  dashboardService?: DashboardService;
  pipelineStatus?: () => PipelineRuntimeStatus;
}

export async function buildServer(
  env: AppEnv,
  db: Db,
  logger: Logger,
  options: BuildServerOptions = {},
) {
  const paths = resolveProjectPaths();
  const startedAt = options.startedAt ?? Date.now();
  const version = options.version ?? paths.version;
  const publicDir = options.publicDir ?? paths.publicDir;

  const health = createBasicHealthRegistry(db, env);
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: false,
    bodyLimit: 1_048_576,
  });

  const settings =
    options.settingsService ??
    new SettingsService({
      envPath: options.envPath ?? paths.envFile,
      environment: options.environment ?? {},
      runtimeEnv: process.env,
      logger,
    });

  const dashboard =
    options.dashboardService ??
    new DashboardService({
      db,
      env,
      health,
      startedAt,
      version,
      pipelineStatus: options.pipelineStatus,
    });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  registerDashboardAuth(app, env);

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0] ?? request.url;
    if (
      pathname === '/api' ||
      pathname.startsWith('/api/') ||
      pathname === '/health' ||
      pathname.startsWith('/health/') ||
      pathname === '/assets' ||
      pathname.startsWith('/assets/')
    ) {
      if (pathname.startsWith('/assets/')) {
        logger.warn({ path: pathname }, 'Static asset not found');
      }
      return reply.code(404).send({
        ok: false,
        error: { code: 'not_found', message: 'Route not found.' },
      });
    }
    return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
  });

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

  await registerStaticUi(app, publicDir, logger);
  registerDashboardRoutes(app, { dashboard, logger });
  registerSettingsRoutes(app, { settings, logger });

  return { app, health, settings, dashboard };
}

async function main(): Promise<void> {
  const paths = resolveProjectPaths();
  const shellEnv: NodeJS.ProcessEnv = { ...process.env };
  dotenv.config({ path: paths.envFile, quiet: true });

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
    const runtime = new PipelineRuntime({ env, db, logger });
    const { app } = await buildServer(env, db, logger, {
      environment: shellEnv,
      envPath: paths.envFile,
      publicDir: paths.publicDir,
      version: paths.version,
      pipelineStatus: () => runtime.status(),
    });

    await app.listen({ host: env.HOST, port: env.PORT });
    logger.info({ host: env.HOST, port: env.PORT }, 'Stash host node started');
    logger.info({ url: `http://${env.HOST}:${env.PORT}/` }, 'Dashboard available');
    await runtime.start();

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'Shutting down');
      try {
        await runtime.stop();
      } catch (error) {
        logger.warn({ error }, 'Pipeline runtime shutdown failed');
      }
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
