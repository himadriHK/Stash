import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const DEFAULT_TEMP_DIR = path.join(os.tmpdir(), 'stash-host-node');

const booleanFromEnv = (defaultValue: boolean) =>
  z.preprocess(
    (value) => (value === undefined || value === null || value === '' ? String(defaultValue) : value),
    z
      .union([z.boolean(), z.string()])
      .transform((value) =>
        typeof value === 'boolean' ? String(value) : value.trim().toLowerCase(),
      )
      .pipe(
        z.enum(['true', 'false', '1', '0']).transform((value) => value === 'true' || value === '1'),
      ),
  );

const integerFromEnv = (defaultValue: number, min: number, max: number) =>
  z.preprocess(
    (value) => (value === undefined || value === null || value === '' ? String(defaultValue) : value),
    z
      .union([z.string(), z.number()])
      .transform((value) => {
        if (typeof value === 'number') return value;
        const trimmed = value.trim();
        return trimmed === '' ? Number.NaN : Number(trimmed);
      })
      .pipe(z.number().int().min(min).max(max)),
  );

const optionalString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

const requiredString = z.string().trim().min(1, 'Required');

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const defaultedString = (defaultValue: string) =>
  z.preprocess(emptyToUndefined, z.string().trim().min(1, 'Required').default(defaultValue));

const requiredAbsolutePath = requiredString.refine(
  (value) => path.isAbsolute(value),
  'Must be an absolute path',
);

const splitCsv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const normalizePrefix = (value: string | undefined): string =>
  (value ?? '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');

export const envSchema = z
  .object({
    NODE_ENV: z.preprocess(
      emptyToUndefined,
      z.enum(['development', 'test', 'production']).default('development'),
    ),
    HOST: defaultedString('127.0.0.1'),
    PORT: integerFromEnv(8080, 1, 65535),
    LOG_LEVEL: z.preprocess(
      emptyToUndefined,
      z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    ),
    DB_PATH: defaultedString('./data/stash_host.db'),
    LOCAL_ROOT_PATH: requiredAbsolutePath,
    TEMP_DIR: defaultedString(DEFAULT_TEMP_DIR),

    KAFKA_ENABLED: booleanFromEnv(true),
    KAFKA_BROKERS: z
      .string()
      .optional()
      .transform((value) => splitCsv(value)),
    KAFKA_CLIENT_ID: defaultedString('stash-host-node'),
    KAFKA_GROUP_ID: defaultedString('stash-upload-request'),
    KAFKA_REQUEST_TOPIC: defaultedString('stash.upload.request'),
    KAFKA_RESPONSE_TOPIC: defaultedString('stash.upload.response'),
    KAFKA_DLQ_TOPIC: defaultedString('stash.dlq'),
    KAFKA_SSL: booleanFromEnv(true),
    KAFKA_SASL_MECHANISM: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .default('scram-sha-256')
        .transform((value) => value.trim().toLowerCase())
        .pipe(z.enum(['plain', 'scram-sha-256', 'scram-sha-512'])),
    ),
    KAFKA_USERNAME: optionalString,
    KAFKA_PASSWORD: optionalString,
    KAFKA_FROM_BEGINNING: booleanFromEnv(false),
    KAFKA_PAUSE_HIGH_WATERMARK: integerFromEnv(500, 1, 1_000_000),
    KAFKA_RESUME_LOW_WATERMARK: integerFromEnv(200, 0, 1_000_000),
    KAFKA_COMMIT_TIMEOUT_MS: integerFromEnv(10_000, 1_000, 600_000),
    KAFKA_DLQ_MIRROR_FAILURES: booleanFromEnv(false),

    S3_ENABLED: booleanFromEnv(true),
    S3_REGION: defaultedString('us-east-1'),
    S3_BUCKET: optionalString,
    S3_ENDPOINT: optionalString,
    S3_FORCE_PATH_STYLE: booleanFromEnv(false),
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    S3_SESSION_TOKEN: optionalString,
    S3_PREFIX: z
      .string()
      .optional()
      .transform((value) => normalizePrefix(value)),
    S3_REQUEST_TIMEOUT_MS: integerFromEnv(300_000, 1_000, 3_600_000),

    JWT_SIGNING_KEY: z
      .string()
      .refine((value) => value.trim().length > 0, 'Required')
      .pipe(z.string().min(32, 'Must be at least 32 characters')),
    JWT_ISSUER: defaultedString('stash-auth'),
    JWT_AUDIENCE: defaultedString('stash-app'),
    JWT_CLOCK_TOLERANCE_SECONDS: integerFromEnv(0, 0, 300),

    WORKER_ENABLED: booleanFromEnv(true),
    WORKER_CONCURRENCY: integerFromEnv(2, 1, 64),
    WORKER_HASH_THREADS: integerFromEnv(2, 1, 64),
    IMAGE_CONCURRENCY: integerFromEnv(2, 1, 64),
    VIDEO_CONCURRENCY: integerFromEnv(1, 1, 64),
    JOB_MAX_ATTEMPTS: integerFromEnv(4, 1, 20),
    LEASE_SECONDS: integerFromEnv(120, 10, 3_600),
    HASH_WORKER_TIMEOUT_MS: integerFromEnv(300_000, 1_000, 3_600_000),
    MEDIA_WORKER_TIMEOUT_MS: integerFromEnv(600_000, 1_000, 3_600_000),
    HEARTBEAT_SECONDS: integerFromEnv(30, 5, 600),
    RECOVERY_INTERVAL_SECONDS: integerFromEnv(30, 5, 3_600),
    DISK_MIN_FREE_BYTES: integerFromEnv(5_368_709_120, 0, 1_099_511_627_776),
    TEMP_RETENTION_HOURS: integerFromEnv(24, 1, 8_760),
    STAGE_TIMEOUT_DOWNLOAD_MS: integerFromEnv(900_000, 1_000, 86_400_000),
    STAGE_TIMEOUT_VERIFY_MS: integerFromEnv(300_000, 1_000, 86_400_000),
    STAGE_TIMEOUT_CONVERT_IMAGE_MS: integerFromEnv(300_000, 1_000, 86_400_000),
    STAGE_TIMEOUT_CONVERT_VIDEO_MS: integerFromEnv(3_600_000, 1_000, 86_400_000),
    STAGE_TIMEOUT_THUMBNAILS_MS: integerFromEnv(600_000, 1_000, 86_400_000),
    STAGE_TIMEOUT_STORE_MS: integerFromEnv(600_000, 1_000, 86_400_000),
    STAGE_TIMEOUT_RESPOND_MS: integerFromEnv(60_000, 1_000, 86_400_000),
    STAGE_TIMEOUT_DELETE_MS: integerFromEnv(60_000, 1_000, 86_400_000),
    RETRY_BASE_MS: integerFromEnv(2_000, 100, 3_600_000),
    RETRY_MAX_MS: integerFromEnv(300_000, 100, 3_600_000),
    DELETE_TEMP_ON_FAILURE: booleanFromEnv(true),

    FFMPEG_PATH: optionalString,
    FFPROBE_PATH: optionalString,
    FFMPEG_VIDEO_CODEC: defaultedString('libx264'),
    FFMPEG_CRF: integerFromEnv(23, 0, 51),
    FFMPEG_PRESET: defaultedString('fast'),
    THUMBNAIL_QUALITY: integerFromEnv(90, 1, 100),
    IMAGE_JPEG_QUALITY: integerFromEnv(90, 1, 100),
    MAX_IMAGE_PIXELS: integerFromEnv(200_000_000, 1, 1_000_000_000),
    HEIC_WORKER_ENABLED: booleanFromEnv(true),
    RAW_DECODER: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .default('libraw')
        .transform((value) => value.trim().toLowerCase())
        .pipe(z.enum(['libraw', 'wasm', 'imagemagick'])),
    ),

    DASHBOARD_AUTH_ENABLED: booleanFromEnv(false),
    DASHBOARD_USER: optionalString,
    DASHBOARD_PASSWORD: optionalString,
    METRICS_ENABLED: booleanFromEnv(true),
    COMPONENT_CHECK_INTERVAL_SECONDS: integerFromEnv(60, 5, 86_400),
  })
  .superRefine((value, context) => {
    if (value.KAFKA_ENABLED && value.KAFKA_BROKERS.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['KAFKA_BROKERS'],
        message: 'Required when KAFKA_ENABLED=true',
      });
    }

    if (value.S3_ENABLED && !value.S3_BUCKET) {
      context.addIssue({
        code: 'custom',
        path: ['S3_BUCKET'],
        message: 'Required when S3_ENABLED=true',
      });
    }

    if (value.DASHBOARD_AUTH_ENABLED) {
      if (!value.DASHBOARD_USER) {
        context.addIssue({
          code: 'custom',
          path: ['DASHBOARD_USER'],
          message: 'Required when DASHBOARD_AUTH_ENABLED=true',
        });
      }
      if (!value.DASHBOARD_PASSWORD) {
        context.addIssue({
          code: 'custom',
          path: ['DASHBOARD_PASSWORD'],
          message: 'Required when DASHBOARD_AUTH_ENABLED=true',
        });
      } else if (value.DASHBOARD_PASSWORD.length < 12) {
        context.addIssue({
          code: 'custom',
          path: ['DASHBOARD_PASSWORD'],
          message: 'Must be at least 12 characters',
        });
      }
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const formatIssue = (issue: z.ZodIssue): string => {
  const key = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
  const message =
    issue.code === 'invalid_type' && /undefined/i.test(issue.message)
      ? 'Required'
      : issue.message;
  return `${key}: ${message}`;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map(formatIssue);
    throw new ConfigError(`Invalid configuration: ${issues.join('; ')}`, issues);
  }
  return result.data;
}

export const REDACTED = '[redacted]';

export interface RedactedConfigSummary {
  nodeEnv: AppEnv['NODE_ENV'];
  host: string;
  port: number;
  logLevel: AppEnv['LOG_LEVEL'];
  dbPath: string;
  localRootPath: string;
  tempDir: string;
  kafka: {
    enabled: boolean;
    brokers: string[];
    clientId: string;
    groupId: string;
    requestTopic: string;
    responseTopic: string;
    dlqTopic: string;
    ssl: boolean;
    saslMechanism: AppEnv['KAFKA_SASL_MECHANISM'];
    username: string;
    password: string;
    fromBeginning: boolean;
    pauseHighWatermark: number;
    resumeLowWatermark: number;
    commitTimeoutMs: number;
    dlqMirrorFailures: boolean;
  };
  s3: {
    enabled: boolean;
    region: string;
    bucket: string | null;
    endpoint: string | null;
    forcePathStyle: boolean;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    prefix: string;
    requestTimeoutMs: number;
  };
  jwt: {
    signingKey: string;
    issuer: string;
    audience: string;
    clockToleranceSeconds: number;
  };
  worker: {
    enabled: boolean;
    concurrency: number;
    hashThreads: number;
    imageConcurrency: number;
    videoConcurrency: number;
    jobMaxAttempts: number;
    leaseSeconds: number;
    hashWorkerTimeoutMs: number;
    mediaWorkerTimeoutMs: number;
    heartbeatSeconds: number;
    recoveryIntervalSeconds: number;
    diskMinFreeBytes: number;
    tempRetentionHours: number;
    retryBaseMs: number;
    retryMaxMs: number;
    deleteTempOnFailure: boolean;
  };
  media: {
    ffmpegPath: string | null;
    ffprobePath: string | null;
    videoCodec: string;
    crf: number;
    preset: string;
    thumbnailQuality: number;
    imageJpegQuality: number;
    maxImagePixels: number;
    heicWorkerEnabled: boolean;
    rawDecoder: AppEnv['RAW_DECODER'];
  };
  dashboard: {
    authEnabled: boolean;
    user: string;
    password: string;
    metricsEnabled: boolean;
    componentCheckIntervalSeconds: number;
  };
}

const secretOrNull = (value: string | undefined): string => (value ? REDACTED : '');

export function summarizeEnv(env: AppEnv): RedactedConfigSummary {
  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dbPath: env.DB_PATH,
    localRootPath: env.LOCAL_ROOT_PATH,
    tempDir: env.TEMP_DIR,
    kafka: {
      enabled: env.KAFKA_ENABLED,
      brokers: [...env.KAFKA_BROKERS],
      clientId: env.KAFKA_CLIENT_ID,
      groupId: env.KAFKA_GROUP_ID,
      requestTopic: env.KAFKA_REQUEST_TOPIC,
      responseTopic: env.KAFKA_RESPONSE_TOPIC,
      dlqTopic: env.KAFKA_DLQ_TOPIC,
      ssl: env.KAFKA_SSL,
      saslMechanism: env.KAFKA_SASL_MECHANISM,
      username: secretOrNull(env.KAFKA_USERNAME),
      password: secretOrNull(env.KAFKA_PASSWORD),
      fromBeginning: env.KAFKA_FROM_BEGINNING,
      pauseHighWatermark: env.KAFKA_PAUSE_HIGH_WATERMARK,
      resumeLowWatermark: env.KAFKA_RESUME_LOW_WATERMARK,
      commitTimeoutMs: env.KAFKA_COMMIT_TIMEOUT_MS,
      dlqMirrorFailures: env.KAFKA_DLQ_MIRROR_FAILURES,
    },
    s3: {
      enabled: env.S3_ENABLED,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET ?? null,
      endpoint: env.S3_ENDPOINT ?? null,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      accessKeyId: secretOrNull(env.S3_ACCESS_KEY_ID),
      secretAccessKey: secretOrNull(env.S3_SECRET_ACCESS_KEY),
      sessionToken: secretOrNull(env.S3_SESSION_TOKEN),
      prefix: env.S3_PREFIX,
      requestTimeoutMs: env.S3_REQUEST_TIMEOUT_MS,
    },
    jwt: {
      signingKey: REDACTED,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      clockToleranceSeconds: env.JWT_CLOCK_TOLERANCE_SECONDS,
    },
    worker: {
      enabled: env.WORKER_ENABLED,
      concurrency: env.WORKER_CONCURRENCY,
      hashThreads: env.WORKER_HASH_THREADS,
      imageConcurrency: env.IMAGE_CONCURRENCY,
      videoConcurrency: env.VIDEO_CONCURRENCY,
      jobMaxAttempts: env.JOB_MAX_ATTEMPTS,
      leaseSeconds: env.LEASE_SECONDS,
      hashWorkerTimeoutMs: env.HASH_WORKER_TIMEOUT_MS,
      mediaWorkerTimeoutMs: env.MEDIA_WORKER_TIMEOUT_MS,
      heartbeatSeconds: env.HEARTBEAT_SECONDS,
      recoveryIntervalSeconds: env.RECOVERY_INTERVAL_SECONDS,
      diskMinFreeBytes: env.DISK_MIN_FREE_BYTES,
      tempRetentionHours: env.TEMP_RETENTION_HOURS,
      retryBaseMs: env.RETRY_BASE_MS,
      retryMaxMs: env.RETRY_MAX_MS,
      deleteTempOnFailure: env.DELETE_TEMP_ON_FAILURE,
    },
    media: {
      ffmpegPath: env.FFMPEG_PATH ?? null,
      ffprobePath: env.FFPROBE_PATH ?? null,
      videoCodec: env.FFMPEG_VIDEO_CODEC,
      crf: env.FFMPEG_CRF,
      preset: env.FFMPEG_PRESET,
      thumbnailQuality: env.THUMBNAIL_QUALITY,
      imageJpegQuality: env.IMAGE_JPEG_QUALITY,
      maxImagePixels: env.MAX_IMAGE_PIXELS,
      heicWorkerEnabled: env.HEIC_WORKER_ENABLED,
      rawDecoder: env.RAW_DECODER,
    },
    dashboard: {
      authEnabled: env.DASHBOARD_AUTH_ENABLED,
      user: secretOrNull(env.DASHBOARD_USER),
      password: secretOrNull(env.DASHBOARD_PASSWORD),
      metricsEnabled: env.METRICS_ENABLED,
      componentCheckIntervalSeconds: env.COMPONENT_CHECK_INTERVAL_SECONDS,
    },
  };
}





