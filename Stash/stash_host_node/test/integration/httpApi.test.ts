import fs from 'node:fs';
import path from 'node:path';

import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppEnv } from '../../src/config/env';
import { SETTINGS, SETTING_GROUPS } from '../../src/config/settingsCatalog';
import { closeDatabase, openDatabase } from '../../src/db/database';
import type { Db } from '../../src/db/database';
import { buildServer } from '../../src/server/index';
import { SettingsService } from '../../src/settings/settingsService';
import type {
  SettingsSnapshot,
  SettingsUpdateResult,
} from '../../src/settings/settingsService';
import { createWorkspace } from '../helpers/env';
import type { TestWorkspace } from '../helpers/env';

const VERSION = '9.9.9-test';
const FIXTURE_INDEX = 'HTTP_API_INDEX_MARKER_7f3a';
const FIXTURE_SETTINGS = 'HTTP_API_SETTINGS_MARKER_9c21';
const AUTH_USER = 'dashboard';
const AUTH_PASSWORD = 'dashboard-password-123';

type ServerApp = Awaited<ReturnType<typeof buildServer>>['app'];

interface TestServer {
  app: ServerApp;
  db: Db;
  workspace: TestWorkspace;
  envPath: string;
  publicDir: string;
  settings: SettingsService;
  close: () => Promise<void>;
}

const activeServers: TestServer[] = [];

function toProcessEnv(env: AppEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    result[key] = Array.isArray(value) ? value.join(',') : String(value);
  }
  return result;
}

function createPublicFixture(root: string): string {
  const publicDir = path.join(root, 'public');
  fs.mkdirSync(path.join(publicDir, 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(publicDir, 'index.html'),
    `<!doctype html><html><body><h1>${FIXTURE_INDEX}</h1></body></html>`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(publicDir, 'settings.html'),
    `<!doctype html><html><body><h1>${FIXTURE_SETTINGS}</h1></body></html>`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(publicDir, 'assets', 'styles.css'),
    'body { color: #123456; }\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(publicDir, 'favicon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    'utf8',
  );
  return publicDir;
}

interface StartServerOptions {
  envOverrides?: Record<string, string | undefined>;
  createPublic?: boolean;
}

async function startServer(options: StartServerOptions = {}): Promise<TestServer> {
  const workspace = createWorkspace(options.envOverrides);
  const envPath = path.join(workspace.root, '.env');
  const publicDir =
    options.createPublic === false
      ? path.join(workspace.root, 'missing-public')
      : createPublicFixture(workspace.root);

  const db = openDatabase(workspace.env.DB_PATH);
  const logger = pino({ level: 'info', enabled: false });
  const settings = new SettingsService({
    envPath,
    environment: {},
    runtimeEnv: toProcessEnv(workspace.env),
    logger,
  });

  const { app } = await buildServer(workspace.env, db, logger, {
    publicDir,
    envPath,
    environment: {},
    startedAt: Date.now() - 5_000,
    version: VERSION,
    settingsService: settings,
  });

  const server: TestServer = {
    app,
    db,
    workspace,
    envPath,
    publicDir,
    settings,
    close: async () => {
      await app.close();
      closeDatabase(db);
      workspace.cleanup();
    },
  };
  activeServers.push(server);
  return server;
}

function parseBody<T>(payload: string): T {
  return JSON.parse(payload) as T;
}

async function putSettings(
  server: TestServer,
  payload: unknown,
  headers: Record<string, string> = { 'content-type': 'application/json' },
) {
  return server.app.inject({
    method: 'PUT',
    url: '/api/settings',
    headers,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

afterEach(async () => {
  while (activeServers.length > 0) {
    const server = activeServers.pop();
    if (server) await server.close();
  }
});

describe('static dashboard UI', () => {
  it('serves the index, settings page, favicon, and cached assets', async () => {
    const server = await startServer();

    const index = await server.app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(String(index.headers['content-type'])).toContain('text/html');
    expect(index.body).toContain(FIXTURE_INDEX);
    expect(index.headers['cache-control']).toBe('no-cache');

    const settingsPage = await server.app.inject({ method: 'GET', url: '/settings' });
    expect(settingsPage.statusCode).toBe(200);
    expect(settingsPage.body).toContain(FIXTURE_SETTINGS);

    const settingsSlash = await server.app.inject({ method: 'GET', url: '/settings/' });
    expect(settingsSlash.statusCode).toBe(200);
    expect(settingsSlash.body).toContain(FIXTURE_SETTINGS);

    const favicon = await server.app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(favicon.statusCode).toBe(200);
    expect(favicon.body).toContain('<svg');

    const asset = await server.app.inject({ method: 'GET', url: '/assets/styles.css' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain('#123456');
    expect(String(asset.headers['cache-control'])).toContain('max-age=3600');
  });

  it('returns a JSON 404 for missing assets and has no SPA fallback', async () => {
    const server = await startServer();

    const missing = await server.app.inject({ method: 'GET', url: '/assets/missing.css' });
    expect(missing.statusCode).toBe(404);
    const missingBody = parseBody<{ ok: boolean; error: { code: string } }>(missing.body);
    expect(missingBody.ok).toBe(false);
    expect(missingBody.error.code).toBe('not_found');

    const unknownPage = await server.app.inject({ method: 'GET', url: '/nope' });
    expect(unknownPage.statusCode).toBe(404);
    expect(unknownPage.body).not.toContain(FIXTURE_INDEX);
  });

  it('does not crash when the public directory is missing', async () => {
    const server = await startServer({ createPublic: false });

    const index = await server.app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(404);
    const indexBody = parseBody<{ ok: boolean; error: { code: string } }>(index.body);
    expect(indexBody.error.code).toBe('not_found');

    const health = await server.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
  });
});

describe('GET /api/dashboard', () => {
  it('returns a snapshot without leaking absolute paths', async () => {
    const server = await startServer();

    const response = await server.app.inject({ method: 'GET', url: '/api/dashboard' });
    expect(response.statusCode).toBe(200);

    const parsed = parseBody<{
      ok: boolean;
      data: { service: { name: string; version: string }; jobs: { total: number } };
    }>(response.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.service.name).toBe('stash-host-node');
    expect(parsed.data.service.version).toBe(VERSION);
    expect(parsed.data.jobs.total).toBe(0);

    expect(response.body).not.toContain(server.workspace.root);
    expect(response.body).not.toContain(server.workspace.env.DB_PATH);
    expect(response.body).not.toContain(server.workspace.env.TEMP_DIR);
    expect(response.body).not.toContain(server.workspace.env.LOCAL_ROOT_PATH);
    expect(response.body).not.toContain(server.workspace.env.JWT_SIGNING_KEY);
  });
});

describe('GET /api/settings', () => {
  it('returns every catalog key grouped and redacts secret values', async () => {
    const server = await startServer();

    const response = await server.app.inject({ method: 'GET', url: '/api/settings' });
    expect(response.statusCode).toBe(200);

    const parsed = parseBody<{ ok: boolean; data: SettingsSnapshot }>(response.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.groups.map((group) => group.id)).toEqual(
      SETTING_GROUPS.map((group) => group.id),
    );

    const fields = parsed.data.groups.flatMap((group) => group.fields);
    expect(fields.map((field) => field.key).sort()).toEqual(
      SETTINGS.map((setting) => setting.key).sort(),
    );

    const secretDefinitions = SETTINGS.filter((setting) => setting.secret);
    expect(secretDefinitions.length).toBeGreaterThan(0);
    for (const definition of secretDefinitions) {
      const field = fields.find((entry) => entry.key === definition.key);
      expect(field).toBeDefined();
      expect(field?.value).toBeNull();
    }

    expect(response.body).not.toContain(server.workspace.root);
    expect(response.body).not.toContain(server.workspace.env.JWT_SIGNING_KEY);
  });
});

describe('PUT /api/settings', () => {
  it('applies LOG_LEVEL live and writes the temporary env file', async () => {
    const server = await startServer();

    const response = await putSettings(server, { values: { LOG_LEVEL: 'debug' } });
    expect(response.statusCode).toBe(200);

    const parsed = parseBody<{ ok: boolean; data: SettingsUpdateResult }>(response.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.updated).toContain('LOG_LEVEL');
    expect(parsed.data.applied).toContain('LOG_LEVEL');
    expect(parsed.data.restartRequired).toBe(false);
    expect(fs.readFileSync(server.envPath, 'utf8')).toContain('LOG_LEVEL=debug');
  });

  it('reports restart keys for listener changes', async () => {
    const server = await startServer();

    const response = await putSettings(server, { values: { PORT: 9999 } });
    expect(response.statusCode).toBe(200);

    const parsed = parseBody<{ ok: boolean; data: SettingsUpdateResult }>(response.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.restartRequired).toBe(true);
    expect(parsed.data.restartKeys).toContain('PORT');
    expect(fs.readFileSync(server.envPath, 'utf8')).toContain('PORT=9999');
  });

  it('rejects an out-of-range port with field errors', async () => {
    const server = await startServer();

    const response = await putSettings(server, { values: { PORT: 99999 } });
    expect(response.statusCode).toBe(400);

    const parsed = parseBody<{
      ok: boolean;
      error: { code: string; fields: Record<string, string> };
    }>(response.body);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('invalid_settings');
    expect(parsed.error.fields['PORT']).toBeTruthy();
    expect(fs.existsSync(server.envPath)).toBe(false);
  });

  it('rejects unknown settings keys', async () => {
    const server = await startServer();

    const response = await putSettings(server, { values: { NOT_A_SETTING: 'x' } });
    expect(response.statusCode).toBe(400);

    const parsed = parseBody<{
      ok: boolean;
      error: { code: string; fields: Record<string, string> };
    }>(response.body);
    expect(parsed.error.code).toBe('invalid_settings');
    expect(parsed.error.fields['NOT_A_SETTING']).toBeTruthy();
  });

  it('rejects non-JSON content types and non-object values', async () => {
    const server = await startServer();

    const text = await putSettings(server, 'LOG_LEVEL=debug', {
      'content-type': 'text/plain',
    });
    expect(text.statusCode).toBe(400);
    expect(parseBody<{ error: { code: string } }>(text.body).error.code).toBe('invalid_request');

    const arrayBody = await putSettings(server, []);
    expect(arrayBody.statusCode).toBe(400);
    expect(parseBody<{ error: { code: string } }>(arrayBody.body).error.code).toBe(
      'invalid_request',
    );

    const arrayValues = await putSettings(server, { values: [] });
    expect(arrayValues.statusCode).toBe(400);
    expect(parseBody<{ error: { code: string } }>(arrayValues.body).error.code).toBe(
      'invalid_request',
    );
  });

  it('rejects cross-origin updates', async () => {
    const server = await startServer();

    const response = await putSettings(
      server,
      { values: { LOG_LEVEL: 'debug' } },
      { 'content-type': 'application/json', origin: 'http://evil.example' },
    );
    expect(response.statusCode).toBe(403);

    const parsed = parseBody<{ ok: boolean; error: { code: string } }>(response.body);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('forbidden_origin');
    expect(fs.existsSync(server.envPath)).toBe(false);
  });
});

describe('dashboard authentication', () => {
  it('requires Basic credentials but keeps liveness open', async () => {
    const server = await startServer({
      envOverrides: {
        DASHBOARD_AUTH_ENABLED: 'true',
        DASHBOARD_USER: AUTH_USER,
        DASHBOARD_PASSWORD: AUTH_PASSWORD,
      },
    });

    const unauthorized = await server.app.inject({ method: 'GET', url: '/' });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers['www-authenticate']).toBe(
      'Basic realm="Stash Host", charset="UTF-8"',
    );

    const unauthorizedApi = await server.app.inject({ method: 'GET', url: '/api/dashboard' });
    expect(unauthorizedApi.statusCode).toBe(401);
    const unauthorizedApiBody = parseBody<{
      ok: boolean;
      error: { code: string };
    }>(unauthorizedApi.body);
    expect(unauthorizedApiBody.ok).toBe(false);
    expect(unauthorizedApiBody.error.code).toBe('unauthorized');

    const credentials = Buffer.from(`${AUTH_USER}:${AUTH_PASSWORD}`, 'utf8').toString('base64');
    const authorized = await server.app.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: `Basic ${credentials}` },
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.body).toContain(FIXTURE_INDEX);

    const live = await server.app.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
    expect(parseBody<{ status: string }>(live.body).status).toBe('ok');
  });

  it('rejects invalid credentials', async () => {
    const server = await startServer({
      envOverrides: {
        DASHBOARD_AUTH_ENABLED: 'true',
        DASHBOARD_USER: AUTH_USER,
        DASHBOARD_PASSWORD: AUTH_PASSWORD,
      },
    });

    const credentials = Buffer.from(`${AUTH_USER}:wrong-password`, 'utf8').toString('base64');
    const response = await server.app.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: `Basic ${credentials}` },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('HTTP envelope and security headers', () => {
  it('returns a JSON 404 for unknown API routes', async () => {
    const server = await startServer();

    const response = await server.app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);

    const parsed = parseBody<{ ok: boolean; error: { code: string; message: string } }>(
      response.body,
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('not_found');
    expect(parsed.error.message.length).toBeGreaterThan(0);
  });

  it('sets a strict same-origin CSP without upgrade-insecure-requests', async () => {
    const server = await startServer();

    const response = await server.app.inject({ method: 'GET', url: '/' });
    const csp = String(response.headers['content-security-policy'] ?? '');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('keeps /api/health unchanged', async () => {
    const server = await startServer();

    const response = await server.app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);

    const parsed = parseBody<{ status: string; components: unknown[] }>(response.body);
    expect(parsed.status).toBeDefined();
    expect(Array.isArray(parsed.components)).toBe(true);
    expect(parsed).not.toHaveProperty('ok');
  });
});
