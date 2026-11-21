import pino, { type Logger, type LoggerOptions } from 'pino';

import type { AppEnv } from '../config/env';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.Authorization',
  'headers.authorization',
  'headers.Authorization',
  'authorization',
  'Authorization',
  '*.authorization',
  '*.Authorization',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'password',
  '*.password',
  'secret',
  '*.secret',
  'JWT_SIGNING_KEY',
  '*.JWT_SIGNING_KEY',
  'jwtSigningKey',
  '*.jwtSigningKey',
  'S3_SECRET_ACCESS_KEY',
  '*.S3_SECRET_ACCESS_KEY',
  'S3_SESSION_TOKEN',
  '*.S3_SESSION_TOKEN',
  's3SecretAccessKey',
  '*.s3SecretAccessKey',
  's3SessionToken',
  '*.s3SessionToken',
  'KAFKA_PASSWORD',
  '*.KAFKA_PASSWORD',
  'kafkaPassword',
  '*.kafkaPassword',
  'mongoUri',
  '*.mongoUri',
  'mongodbUrl',
  '*.mongodbUrl',
  'connectionString',
  '*.connectionString',
  'url',
  '*.url',
] as const;

export function createLogger(env: AppEnv): Logger {
  const options: LoggerOptions = {
    level: env.LOG_LEVEL,
    base: { service: 'stash-host-node', env: env.NODE_ENV },
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
  };

  if (env.NODE_ENV === 'development') {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        singleLine: true,
        ignore: 'pid,hostname',
      },
    };
  }

  return pino(options);
}

export interface JobLogContext {
  jobId?: string;
  correlationId?: string;
  stage?: string;
}

export function createJobLogger(parent: Logger, context: JobLogContext): Logger {
  const bindings: Record<string, string> = {};
  if (context.jobId) bindings['jobId'] = context.jobId;
  if (context.correlationId) bindings['correlationId'] = context.correlationId;
  if (context.stage) bindings['stage'] = context.stage;
  return parent.child(bindings);
}

