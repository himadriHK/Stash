import type { IncomingMessage, ServerResponse } from 'node:http';

import type { FastifyInstance, RawServerDefault } from 'fastify';
import type { Logger } from 'pino';

export type ServerInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  Logger
>;
