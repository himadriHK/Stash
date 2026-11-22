import type { ServerResponse } from 'node:http';

import type { Logger } from 'pino';

import type { DashboardService } from '../dashboard/dashboardService';
import type { ServerInstance } from '../server/types';

export interface DashboardRoutesOptions {
  dashboard: DashboardService;
  logger: Logger;
}

export const DASHBOARD_STREAM_INTERVAL_MS = 2_000;

const STREAM_ERROR_PAYLOAD = JSON.stringify({
  ok: false,
  error: {
    code: 'dashboard_failed',
    message: 'Unable to load dashboard data.',
  },
});

export function registerDashboardRoutes(
  app: ServerInstance,
  options: DashboardRoutesOptions,
): void {
  const { dashboard, logger } = options;

  const clients = new Set<ServerResponse>();
  let interval: NodeJS.Timeout | null = null;
  let sending = false;

  const stopInterval = (): void => {
    if (interval === null) return;
    clearInterval(interval);
    interval = null;
  };

  const removeClient = (client: ServerResponse): void => {
    clients.delete(client);
    if (clients.size === 0) stopInterval();
  };

  const writeFrame = (client: ServerResponse, event: string, data: string): void => {
    try {
      if (client.writableEnded || client.destroyed) {
        removeClient(client);
        return;
      }
      client.write(`event: ${event}\ndata: ${data}\n\n`);
    } catch {
      removeClient(client);
    }
  };

  const broadcast = async (): Promise<void> => {
    if (sending || clients.size === 0) return;
    sending = true;
    try {
      const snapshot = await dashboard.snapshot();
      const payload = JSON.stringify({ ok: true, data: snapshot });
      for (const client of [...clients]) {
        writeFrame(client, 'dashboard', payload);
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to stream the dashboard snapshot');
      for (const client of [...clients]) {
        writeFrame(client, 'dashboard-error', STREAM_ERROR_PAYLOAD);
      }
    } finally {
      sending = false;
    }
  };

  const startInterval = (): void => {
    if (interval !== null) return;
    interval = setInterval(() => {
      void broadcast();
    }, DASHBOARD_STREAM_INTERVAL_MS);
  };

  app.get('/api/dashboard', async (_request, reply) => {
    try {
      const data = await dashboard.snapshot();
      return { ok: true, data };
    } catch (error) {
      logger.error({ err: error }, 'Failed to build the dashboard snapshot');
      return reply.code(500).send({
        ok: false,
        error: {
          code: 'dashboard_failed',
          message: 'Unable to load dashboard data.',
        },
      });
    }
  });

  app.get('/api/dashboard/stream', async (request, reply) => {
    reply.hijack();
    request.raw.setTimeout(0);

    const response = reply.raw;
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.write('retry: 2000\n\n');

    clients.add(response);
    const cleanup = (): void => removeClient(response);
    request.raw.on('close', cleanup);
    response.on('close', cleanup);
    response.on('error', cleanup);

    startInterval();
    void broadcast();
  });

  app.addHook('onClose', async () => {
    stopInterval();
    for (const client of [...clients]) {
      try {
        client.end();
      } catch {}
    }
    clients.clear();
  });
}
