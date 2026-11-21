/**
 * HTTP handler for /api/auth/*. Keeps the Identity API contract flat:
 * `{ "error": "message" }` on failure and camelCase token fields on success.
 */
import { readBearerToken, verifyAccessToken } from '../auth.ts';
import {
  HttpError,
  buildCorsHeaders,
  readJsonBody,
  type HeaderMap,
} from '../http.ts';
import {
  IdentityConfigError,
  loadIdentityConfig,
  type IdentityConfig,
} from './config.ts';
import { getMongoIdentityStore } from './mongoStore.ts';
import {
  IdentityConflictError,
  IdentityService,
  IdentityUnauthorizedError,
  IdentityValidationError,
} from './service.ts';
import type { IdentityStore } from './store.ts';

export interface IdentityHandlerOptions {
  config?: IdentityConfig;
  getStore?: (config: IdentityConfig) => Promise<IdentityStore>;
}

type RouteName = 'health' | 'register' | 'login' | 'refresh' | 'revoke';

const ROUTES: Record<string, RouteName> = {
  health: 'health',
  register: 'register',
  login: 'login',
  refresh: 'refresh',
  revoke: 'revoke',
};

function baseHeaders(cors: HeaderMap): HeaderMap {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...cors,
  };
}

function writeJson(
  body: unknown,
  status: number,
  cors: HeaderMap,
  extra: HeaderMap = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...baseHeaders(cors), ...extra },
  });
}

function writeError(
  message: string,
  status: number,
  cors: HeaderMap,
  extra: HeaderMap = {},
): Response {
  return writeJson({ error: message }, status, cors, extra);
}

function writeEmpty(status: number, cors: HeaderMap): Response {
  return new Response(null, { status, headers: baseHeaders(cors) });
}

function routeNameFromPath(pathname: string): RouteName | null {
  let path = pathname;
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  const prefix = '/api/auth/';
  if (!path.startsWith(prefix)) {
    return null;
  }

  const suffix = path.slice(prefix.length);
  if (!suffix || suffix.includes('/')) {
    return null;
  }

  return ROUTES[suffix] ?? null;
}

function isAuthPath(pathname: string): boolean {
  return pathname === '/api/auth' || pathname.startsWith('/api/auth/');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

function methodNotAllowed(allowed: string, cors: HeaderMap): Response {
  return writeError('Method not allowed.', 405, cors, { Allow: allowed });
}

function mapError(error: unknown, cors: HeaderMap): Response {
  if (
    error instanceof IdentityValidationError ||
    error instanceof IdentityConflictError ||
    error instanceof IdentityUnauthorizedError
  ) {
    return writeError(error.message, error.status, cors);
  }

  if (error instanceof HttpError) {
    return writeError(error.message, error.status, cors);
  }

  if (error instanceof IdentityConfigError) {
    console.error(`[identity] configuration error: ${error.message}`);
    return writeError('Identity API is not configured correctly.', 500, cors);
  }

  const detail = error instanceof Error ? error.name : 'UnknownError';
  console.error(`[identity] service error: ${detail}`);
  return writeError('Identity service error.', 500, cors);
}

export function createIdentityHandler(options: IdentityHandlerOptions = {}): {
  fetch(request: Request): Promise<Response>;
} {
  const getStore = options.getStore ?? getMongoIdentityStore;

  return {
    async fetch(request: Request): Promise<Response> {
      let cors: HeaderMap = {};

      try {
        const config = options.config ?? loadIdentityConfig(process.env);
        cors = buildCorsHeaders(request.headers.get('origin'), config.corsOrigins);

        const pathname = new URL(request.url).pathname;
        if (!isAuthPath(pathname)) {
          return writeError('Not found.', 404, cors);
        }

        if (request.method === 'OPTIONS') {
          return writeEmpty(204, cors);
        }

        const route = routeNameFromPath(pathname);
        if (!route) {
          return writeError('Not found.', 404, cors);
        }

        if (route === 'health') {
          if (request.method !== 'GET') {
            return methodNotAllowed('GET, OPTIONS', cors);
          }
          return writeJson(
            { status: 'healthy', timestamp: new Date().toISOString() },
            200,
            cors,
          );
        }

        if (request.method !== 'POST') {
          return methodNotAllowed('POST, OPTIONS', cors);
        }

        const store = await getStore(config);
        const service = new IdentityService(store, config);

        if (route === 'revoke') {
          const token = readBearerToken(request);
          const auth = verifyAccessToken(token, config);

          const revokeBody = await readJsonBody(request, config.maxBodyBytes);
          if (!isPlainObject(revokeBody)) {
            return writeError('Body must be a JSON object.', 400, cors);
          }

          await service.revoke(auth.userId, readString(revokeBody, 'deviceId'));
          return writeJson({ message: 'Device revoked successfully' }, 200, cors);
        }

        const parsedBody = await readJsonBody(request, config.maxBodyBytes);
        if (!isPlainObject(parsedBody)) {
          return writeError('Body must be a JSON object.', 400, cors);
        }

        if (route === 'register') {
          const pair = await service.register(
            readString(parsedBody, 'email'),
            readString(parsedBody, 'password'),
            readString(parsedBody, 'deviceId'),
          );
          return writeJson(pair, 200, cors);
        }

        if (route === 'login') {
          const pair = await service.login(
            readString(parsedBody, 'email'),
            readString(parsedBody, 'password'),
            readString(parsedBody, 'deviceId'),
          );
          return writeJson(pair, 200, cors);
        }

        if (route === 'refresh') {
          const pair = await service.refresh(readString(parsedBody, 'refreshToken'));
          return writeJson(pair, 200, cors);
        }

        return writeError('Not found.', 404, cors);
      } catch (error) {
        return mapError(error, cors);
      }
    },
  };
}
