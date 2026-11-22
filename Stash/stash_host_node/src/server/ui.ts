import fs from 'node:fs';
import path from 'node:path';

import fastifyStatic from '@fastify/static';
import type { FastifyReply } from 'fastify';
import type { Logger } from 'pino';

import type { ServerInstance } from './types';

const HTML_CACHE_CONTROL = 'no-cache';
const ASSET_CACHE_CONTROL_MAX_AGE_MS = 3_600_000;

const NOT_FOUND_BODY = {
  ok: false,
  error: { code: 'not_found', message: 'Route not found.' },
};

function isDirectory(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function canSendFile(reply: FastifyReply): boolean {
  return typeof (reply as FastifyReply & { sendFile?: unknown }).sendFile === 'function';
}

function sendUiNotFound(reply: FastifyReply, logger: Logger, file: string): FastifyReply {
  logger.warn({ file }, 'UI file is unavailable');
  return reply.code(404).send(NOT_FOUND_BODY);
}

function sendUiFile(
  reply: FastifyReply,
  publicDir: string,
  relativePath: string,
  cacheControl: string,
  logger: Logger,
): FastifyReply {
  if (
    !isDirectory(publicDir) ||
    !isFile(path.join(publicDir, relativePath)) ||
    !canSendFile(reply)
  ) {
    return sendUiNotFound(reply, logger, relativePath);
  }
  reply.header('Cache-Control', cacheControl);
  return reply.sendFile(relativePath);
}

export async function registerStaticUi(
  app: ServerInstance,
  publicDir: string,
  logger: Logger,
): Promise<void> {
  if (!isDirectory(publicDir)) {
    logger.warn({ publicDir }, 'Public UI directory is missing; UI routes will return 404');
  } else {
    await app.register(fastifyStatic, {
      root: publicDir,
      serve: false,
      cacheControl: false,
    });

    const assetsDir = path.join(publicDir, 'assets');
    if (isDirectory(assetsDir)) {
      await app.register(fastifyStatic, {
        root: assetsDir,
        prefix: '/assets/',
        decorateReply: false,
        cacheControl: true,
        maxAge: ASSET_CACHE_CONTROL_MAX_AGE_MS,
      });
    }
  }

  app.get('/', async (_request, reply) =>
    sendUiFile(reply, publicDir, 'index.html', HTML_CACHE_CONTROL, logger),
  );

  app.get('/settings', async (_request, reply) =>
    sendUiFile(reply, publicDir, 'settings.html', HTML_CACHE_CONTROL, logger),
  );

  app.get('/settings/', async (_request, reply) =>
    sendUiFile(reply, publicDir, 'settings.html', HTML_CACHE_CONTROL, logger),
  );

  app.get('/favicon.svg', async (_request, reply) =>
    sendUiFile(reply, publicDir, 'favicon.svg', HTML_CACHE_CONTROL, logger),
  );
}
