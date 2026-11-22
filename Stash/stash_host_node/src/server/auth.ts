import crypto from 'node:crypto';

import type { FastifyReply } from 'fastify';

import type { AppEnv } from '../config/env';
import type { ServerInstance } from './types';

const AUTHENTICATION_REQUIRED = 'Authentication required.';

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function requestPath(url: string): string {
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

function isAuthorized(
  header: string | undefined,
  expectedUser: Buffer,
  expectedPassword: Buffer,
): boolean {
  if (typeof header !== 'string') return false;
  const trimmed = header.trim();
  const separator = trimmed.indexOf(' ');
  if (separator < 0) return false;
  if (trimmed.slice(0, separator).toLowerCase() !== 'basic') return false;
  const encoded = trimmed.slice(separator + 1).trim();
  if (encoded === '') return false;

  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const credentialsSeparator = decoded.indexOf(':');
  if (credentialsSeparator < 0) return false;

  const user = decoded.slice(0, credentialsSeparator);
  const password = decoded.slice(credentialsSeparator + 1);
  const userMatches = crypto.timingSafeEqual(sha256(user), expectedUser);
  const passwordMatches = crypto.timingSafeEqual(sha256(password), expectedPassword);
  return userMatches && passwordMatches;
}

function sendUnauthorized(pathname: string, reply: FastifyReply): FastifyReply {
  reply.header('WWW-Authenticate', 'Basic realm="Stash Host", charset="UTF-8"');
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return reply.code(401).send({
      ok: false,
      error: { code: 'unauthorized', message: AUTHENTICATION_REQUIRED },
    });
  }
  return reply.code(401).type('text/plain; charset=utf-8').send(AUTHENTICATION_REQUIRED);
}

export function registerDashboardAuth(app: ServerInstance, env: AppEnv): void {
  if (!env.DASHBOARD_AUTH_ENABLED) return;

  const expectedUser = sha256(env.DASHBOARD_USER ?? '');
  const expectedPassword = sha256(env.DASHBOARD_PASSWORD ?? '');

  app.addHook('onRequest', async (request, reply) => {
    const pathname = requestPath(request.url);
    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      pathname === '/health/live'
    ) {
      return;
    }
    if (isAuthorized(request.headers.authorization, expectedUser, expectedPassword)) {
      return;
    }
    return sendUnauthorized(pathname, reply);
  });
}
