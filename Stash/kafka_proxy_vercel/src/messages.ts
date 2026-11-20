/**
 * The proxy's HTTP routes.
 *
 *   OPTIONS /api/messages              CORS preflight
 *   POST    /api/messages              produce one record
 *   GET     /api/messages?topic=…      poll for new records
 *
 * Keep this module free of the native Kafka dependency: the gateway is injected
 * so the routes can be unit-tested without a broker.
 */
import { randomUUID } from 'node:crypto';

import { readBearerToken, verifyAccessToken } from './auth.ts';
import type { AppConfig } from './config.ts';
import { loadConfig } from './config.ts';
import type { KafkaGateway } from './gateway.ts';
import type { HeaderMap } from './http.ts';
import {
  HttpError,
  buildCorsHeaders,
  clampInt,
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  parseCorsOrigins,
  readJsonBody,
} from './http.ts';
import { buildRecordHeaders, parseProduceRequest } from './records.ts';
import { assertTopicAllowed } from './topics.ts';

const SERVICE = 'stash-kafka-proxy-vercel';

export interface MessagesHandlerOptions {
  gateway: (config: AppConfig) => KafkaGateway;
}

function consumerGroupFor(config: AppConfig, deviceId: string): string {
  const suffix = deviceId.replace(/[^A-Za-z0-9_.-]/g, '_') || 'device';
  return `${config.consumerGroupPrefix}-${suffix}`;
}

async function handleProduce(
  request: Request,
  config: AppConfig,
  cors: HeaderMap,
  gateway: KafkaGateway,
): Promise<Response> {
  const auth = verifyAccessToken(readBearerToken(request), config);
  const body = await readJsonBody(request, config.maxBodyBytes);
  const parsed = parseProduceRequest(body);
  assertTopicAllowed(parsed.topic, config.produceTopics, 'produce');

  const result = await gateway.produce({
    topic: parsed.topic,
    key: parsed.key,
    value: parsed.value,
    headers: buildRecordHeaders(parsed.headers, auth, randomUUID()),
  });

  return jsonResponse(
    { ok: true, topic: parsed.topic, partition: result.partition, offset: result.offset },
    202,
    cors,
  );
}

async function handlePoll(
  request: Request,
  url: URL,
  config: AppConfig,
  cors: HeaderMap,
  gateway: KafkaGateway,
): Promise<Response> {
  const auth = verifyAccessToken(readBearerToken(request), config);
  const topic = (url.searchParams.get('topic') ?? '').trim();
  assertTopicAllowed(topic, config.consumeTopics, 'consume');

  const timeoutMs = clampInt(
    url.searchParams.get('timeoutMs') ?? undefined,
    config.pollTimeoutMs,
    0,
    config.pollTimeoutMs,
  );
  const maxRecords = clampInt(url.searchParams.get('maxRecords') ?? undefined, 50, 1, 200);
  const groupId = consumerGroupFor(config, auth.deviceId);

  const records = await gateway.poll({ groupId, topic, timeoutMs, maxRecords });

  return jsonResponse(
    { records, topic, group: groupId, polledAt: new Date().toISOString() },
    200,
    cors,
  );
}

export function createMessagesHandler(options: MessagesHandlerOptions) {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const origin = request.headers.get('Origin');
      let cors: HeaderMap = {};

      try {
        const config = loadConfig(process.env);
        cors = buildCorsHeaders(origin, config.corsOrigins);

        if (request.method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: cors });
        }

        switch (request.method) {
          case 'POST':
            return await handleProduce(request, config, cors, options.gateway(config));
          case 'GET':
            return await handlePoll(request, url, config, cors, options.gateway(config));
          default:
            throw methodNotAllowed(['GET', 'POST', 'OPTIONS']);
        }
      } catch (error) {
        const httpError =
          error instanceof HttpError
            ? error
            : new HttpError(500, 'internal_error', 'Unexpected proxy error.');

        if (httpError.status >= 500) {
          console.error(
            JSON.stringify({
              service: SERVICE,
              path: url.pathname,
              code: httpError.code,
              message: httpError.message,
            }),
          );
        }

        const headers =
          Object.keys(cors).length > 0
            ? cors
            : buildCorsHeaders(origin, parseCorsOrigins(process.env.CORS_ALLOWED_ORIGINS));
        return errorResponse(httpError.status, httpError.code, httpError.message, headers);
      }
    },
  };
}
