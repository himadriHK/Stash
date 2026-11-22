import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase } from '../../src/db/database';
import { buildServer } from '../../src/server/index';
import { createWorkspace } from '../helpers/env';

const VERSION = '9.9.9-test';
const FRAME_TIMEOUT_MS = 15_000;

interface StreamFrame {
  statusCode: number;
  headers: IncomingHttpHeaders;
  frame: string;
  close: () => void;
}

function openDashboardStream(port: number): Promise<StreamFrame> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/api/dashboard/stream',
        headers: { accept: 'text/event-stream' },
      },
      (response) => {
        let buffer = '';
        const timer = setTimeout(() => {
          request.destroy();
          reject(new Error('Timed out waiting for a dashboard stream frame'));
        }, FRAME_TIMEOUT_MS);

        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          buffer += chunk;
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary + 2);
            buffer = buffer.slice(boundary + 2);
            if (frame.includes('event: dashboard\n')) {
              clearTimeout(timer);
              response.pause();
              resolve({
                statusCode: response.statusCode ?? 0,
                headers: response.headers,
                frame,
                close: () => request.destroy(),
              });
              return;
            }
            boundary = buffer.indexOf('\n\n');
          }
        });
        response.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      },
    );
    request.on('error', (error) => reject(error));
  });
}

function parseDataFrame(frame: string): unknown {
  for (const line of frame.split('\n')) {
    if (line.startsWith('data: ')) return JSON.parse(line.slice('data: '.length));
  }
  throw new Error('Stream frame has no data line');
}

describe('GET /api/dashboard/stream', () => {
  it('streams a dashboard snapshot as server-sent events', async () => {
    const workspace = createWorkspace();
    const db = openDatabase(workspace.env.DB_PATH);
    const logger = pino({ level: 'info', enabled: false });
    let stream: StreamFrame | null = null;
    let app: Awaited<ReturnType<typeof buildServer>>['app'] | null = null;

    try {
      const built = await buildServer(workspace.env, db, logger, {
        startedAt: Date.now() - 5_000,
        version: VERSION,
      });
      app = built.app;
      await app.listen({ host: '127.0.0.1', port: 0 });

      const address = app.server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected the server to listen on a TCP port');
      }

      stream = await openDashboardStream(address.port);

      expect(stream.statusCode).toBe(200);
      expect(String(stream.headers['content-type'])).toMatch(/^text\/event-stream/);

      const parsed = parseDataFrame(stream.frame) as {
        ok: boolean;
        data: {
          service: { name: string };
          jobs: { total: number };
          health: { status: string; components: Array<{ component: string }> };
        };
      };

      expect(parsed.ok).toBe(true);
      expect(parsed.data.service.name).toBe('stash-host-node');
      expect(parsed.data.jobs.total).toBe(0);
      expect(parsed.data.health.status).toBe('ok');
      expect(parsed.data.health.components.map((component) => component.component)).toEqual([
        'database',
        'temp_dir',
        'config',
      ]);
      expect(stream.frame.toLowerCase()).not.toContain('phase 4');
      expect(stream.frame).not.toContain('Not implemented');
    } finally {
      stream?.close();
      if (app) await app.close();
      closeDatabase(db);
      workspace.cleanup();
    }
  }, 15_000);
});
