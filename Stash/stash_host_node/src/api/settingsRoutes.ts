import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

import type { ServerInstance } from '../server/types';

import type { SettingsService } from '../settings/settingsService';
import { SettingsValidationError, SettingsWriteError } from '../settings/settingsService';

type SettingValue = string | number | boolean | null;

export interface SettingsRoutesOptions {
  settings: SettingsService;
  logger: Logger;
}

const INVALID_REQUEST_MESSAGE = 'The request body must be a JSON object with a values object.';
const FORBIDDEN_ORIGIN_MESSAGE = 'Cross-origin requests are not allowed.';

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mediaType(value: string | undefined): string {
  if (value === undefined) return '';
  return value.split(';')[0]?.trim().toLowerCase() ?? '';
}

function toSettingValues(input: unknown): Record<string, SettingValue> | null {
  if (!isPlainObject(input)) return null;

  const values: Record<string, SettingValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      values[key] = value;
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      values[key] = value;
      continue;
    }
    return null;
  }
  return values;
}

function isSameOriginRequest(request: FastifyRequest): boolean {
  const origin = headerValue(request.headers.origin);
  if (origin !== undefined) {
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return false;
    }
    if (originHost === '' || originHost !== request.host.toLowerCase()) return false;
  }

  const fetchSite = headerValue(request.headers['sec-fetch-site']);
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return false;
  }
  return true;
}

function invalidRequest(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({
    ok: false,
    error: { code: 'invalid_request', message: INVALID_REQUEST_MESSAGE },
  });
}

export function registerSettingsRoutes(
  app: ServerInstance,
  options: SettingsRoutesOptions,
): void {
  const { settings, logger } = options;

  app.get('/api/settings', async (_request, reply) => {
    try {
      return { ok: true, data: settings.snapshot() };
    } catch (error) {
      logger.error({ err: error }, 'Failed to read settings');
      return reply.code(500).send({
        ok: false,
        error: { code: 'settings_failed', message: 'Unable to load settings.' },
      });
    }
  });

  app.put<{ Body: unknown }>('/api/settings', async (request, reply) => {
    if (mediaType(headerValue(request.headers['content-type'])) !== 'application/json') {
      return invalidRequest(reply);
    }

    const body = request.body;
    if (!isPlainObject(body)) return invalidRequest(reply);

    const values = toSettingValues(body['values']);
    if (values === null) return invalidRequest(reply);

    if (!isSameOriginRequest(request)) {
      return reply.code(403).send({
        ok: false,
        error: { code: 'forbidden_origin', message: FORBIDDEN_ORIGIN_MESSAGE },
      });
    }

    try {
      const result = await settings.update({ values });
      return { ok: true, data: result };
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'invalid_settings',
            message: error.message,
            fields: error.fields,
          },
        });
      }
      if (error instanceof SettingsWriteError) {
        logger.error({ err: error }, 'Failed to write the settings environment file');
        return reply.code(500).send({
          ok: false,
          error: {
            code: 'settings_write_failed',
            message: 'Unable to save settings.',
          },
        });
      }
      logger.error({ err: error }, 'Failed to update settings');
      return reply.code(500).send({
        ok: false,
        error: { code: 'settings_failed', message: 'Unable to update settings.' },
      });
    }
  });
}
