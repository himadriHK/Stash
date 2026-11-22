/**
 * Local development server for the Vercel Functions.
 *
 * Serves the same routes as the deployed functions without `vercel dev`:
 *   GET/POST /api/messages, GET /api/health, /api/auth/*
 *
 * Run with: npm run dev:local
 */
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { clampInt } from '../src/http.ts';

interface RouteHandler {
  fetch(request: Request): Response | Promise<Response>;
}

interface HandlerCache {
  current: Promise<RouteHandler> | undefined;
}

type RouteKind = 'health' | 'messages' | 'auth';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const MAX_BODY_BYTES_DEFAULT = 1_048_576;
const MAX_BODY_BYTES_MIN = 1_024;
const MAX_BODY_BYTES_MAX = 8_388_608;

const NOT_FOUND_BODY = JSON.stringify({
  ok: false,
  error: { code: 'not_found', message: 'Not found.' },
});

const INTERNAL_ERROR_BODY = JSON.stringify({
  ok: false,
  error: { code: 'internal_error', message: 'Unexpected local server error.' },
});

class BodyTooLargeError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`Body exceeds ${limit} bytes.`);
    this.name = 'BodyTooLargeError';
    this.limit = limit;
  }
}

function bodyTooLargeBody(limit: number): string {
  return JSON.stringify({
    ok: false,
    error: { code: 'body_too_large', message: `Body exceeds ${limit} bytes.` },
  });
}

function hasEnv(name: string): boolean {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0;
}

/** Loads kafka_proxy_vercel/.env relative to this script; ambient values win. */
function loadEnvironment(): boolean {
  const envUrl = new URL('../.env', import.meta.url);
  if (!existsSync(envUrl)) {
    return false;
  }

  try {
    process.loadEnvFile(envUrl);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[local-server] Failed to load ${envUrl.pathname}: ${message}`);
    process.exit(1);
  }
}

function parsePort(raw: string | undefined): number {
  const value = (raw ?? String(DEFAULT_PORT)).trim();
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[local-server] Invalid PORT "${value}"; expected an integer 1..65535.`);
    process.exit(1);
  }
  return port;
}

function formatHost(host: string): string {
  if (host.includes(':') && !host.startsWith('[')) {
    return `[${host}]`;
  }
  return host;
}

function createCache(): HandlerCache {
  return { current: undefined };
}

async function resolveHandler(
  cache: HandlerCache,
  load: () => Promise<RouteHandler>,
): Promise<RouteHandler> {
  const existing = cache.current;
  if (existing) {
    try {
      return await existing;
    } catch (error) {
      cache.current = undefined;
      throw error;
    }
  }

  const created = load();
  cache.current = created;
  try {
    return await created;
  } catch (error) {
    cache.current = undefined;
    throw error;
  }
}

const healthCache = createCache();
const messagesCache = createCache();
const identityCache = createCache();

function getHealthHandler(): Promise<RouteHandler> {
  return resolveHandler(healthCache, async () => {
    const { createHealthHandler } = await import('../src/health.ts');
    return createHealthHandler();
  });
}

function getMessagesHandler(): Promise<RouteHandler> {
  return resolveHandler(messagesCache, async () => {
    const [{ createMessagesHandler }, { getConfluentGateway }] = await Promise.all([
      import('../src/messages.ts'),
      import('../src/kafka.ts'),
    ]);
    return createMessagesHandler({ gateway: getConfluentGateway });
  });
}

function getIdentityHandler(): Promise<RouteHandler> {
  return resolveHandler(identityCache, async () => {
    const { createIdentityHandler } = await import('../src/identity/handler.ts');
    return createIdentityHandler();
  });
}

function routeKind(pathname: string): RouteKind | null {
  if (pathname === '/api/health') {
    return 'health';
  }
  if (pathname === '/api/messages') {
    return 'messages';
  }
  if (pathname === '/api/auth' || pathname.startsWith('/api/auth/')) {
    return 'auth';
  }
  return null;
}

async function handlerFor(pathname: string): Promise<RouteHandler | null> {
  switch (routeKind(pathname)) {
    case 'health':
      return getHealthHandler();
    case 'messages':
      return getMessagesHandler();
    case 'auth':
      return getIdentityHandler();
    default:
      return null;
  }
}

function buildRequestUrl(req: IncomingMessage, defaultAuthority: string): URL {
  const authority = req.headers.host ?? defaultAuthority;
  return new URL(req.url ?? '/', `http://${authority}`);
}

function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.on('error', () => undefined);
    req.resume();
    return Promise.reject(new BodyTooLargeError(maxBytes));
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const rejectOnce = (error: Error): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) {
        return;
      }
      total += chunk.byteLength;
      if (total > maxBytes) {
        rejectOnce(new BodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error: Error) => {
      rejectOnce(error);
    });
  });
}

async function toWebRequest(
  req: IncomingMessage,
  url: URL,
  method: string,
  maxBytes: number,
): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else {
      headers.set(name, value);
    }
  }

  const body =
    method === 'GET' || method === 'HEAD' ? undefined : await readRequestBody(req, maxBytes);

  return new Request(url, { method, headers, body });
}

async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  res.statusCode = response.status;

  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === 'set-cookie') {
      return;
    }
    res.setHeader(name, value);
  });

  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) {
    res.setHeader('set-cookie', setCookies);
  }

  res.setHeader('Content-Length', String(body.byteLength));
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', String(Buffer.byteLength(body, 'utf8')));
  res.end(body);
}

function logFailure(method: string, pathname: string, error: unknown): void {
  const name = error instanceof Error ? error.name : 'UnknownError';
  console.error(`[local-server] ${method} ${pathname} failed (${name})`);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  defaultAuthority: string,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  let pathname = req.url ?? '/';

  try {
    const url = buildRequestUrl(req, defaultAuthority);
    pathname = url.pathname;

    const handler = await handlerFor(pathname);
    if (!handler) {
      sendJson(res, 404, NOT_FOUND_BODY);
      return;
    }

    const request = await toWebRequest(req, url, method, maxBodyBytes);
    const response = await handler.fetch(request);
    await sendWebResponse(res, response);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      req.resume();
      if (!res.headersSent) {
        sendJson(res, 413, bodyTooLargeBody(error.limit));
      } else {
        res.destroy();
      }
      return;
    }

    logFailure(method, pathname, error);
    if (!res.headersSent) {
      sendJson(res, 500, INTERNAL_ERROR_BODY);
    } else {
      res.destroy();
    }
  }
}

function printBanner(envFileLoaded: boolean, authority: string): void {
  console.log('[local-server] Stash Kafka proxy + Identity (local)');
  console.log(`[local-server] Listening on http://${authority}`);
  console.log(
    `[local-server] .env: ${envFileLoaded ? 'loaded' : 'not found (using ambient environment)'}`,
  );
  console.log('[local-server] Routes:');
  console.log('  GET     /api/health');
  console.log('  POST    /api/messages');
  console.log('  GET     /api/messages?topic=...');
  console.log('  OPTIONS /api/messages');
  console.log('  GET     /api/auth/health');
  console.log('  POST    /api/auth/register|login|refresh|revoke');
  console.log('  OPTIONS /api/auth/*');
  console.log(
    `[local-server] Env present: KAFKA_BOOTSTRAP_SERVERS=${hasEnv('KAFKA_BOOTSTRAP_SERVERS')}, ` +
      `MONGODB_URI=${hasEnv('MONGODB_URI')}, JWT_SIGNING_KEY=${hasEnv('JWT_SIGNING_KEY')}`,
  );
}

const envFileLoaded = loadEnvironment();
const host = (process.env.HOST ?? '').trim() || DEFAULT_HOST;
const port = parsePort(process.env.PORT);
const authority = `${formatHost(host)}:${port}`;
const maxBodyBytes = clampInt(
  process.env.MAX_BODY_BYTES,
  MAX_BODY_BYTES_DEFAULT,
  MAX_BODY_BYTES_MIN,
  MAX_BODY_BYTES_MAX,
);

const server = createServer((req, res) => {
  handleRequest(req, res, authority).catch((error: unknown) => {
    logFailure(req.method ?? 'GET', req.url ?? '/', error);
    if (!res.headersSent) {
      sendJson(res, 500, INTERNAL_ERROR_BODY);
    } else {
      res.destroy();
    }
  });
});

server.on('error', (error: Error) => {
  console.error(`[local-server] Server error: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  printBanner(envFileLoaded, authority);
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[local-server] ${signal} received; shutting down.`);

  const fallback = setTimeout(() => process.exit(0), 1000);
  fallback.unref();

  server.close(() => {
    process.exit(0);
  });
  server.closeAllConnections();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
