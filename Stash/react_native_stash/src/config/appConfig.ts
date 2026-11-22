/**
 * Strongly typed configuration for the Stash app.
 *
 * Non-secret defaults (topics, timeouts, batch sizes, proxy tuning) live in
 * `src/config/appconfig.json`. Secrets and machine-specific endpoints are
 * supplied at build time through `EXPO_PUBLIC_*` environment variables loaded
 * from a local `.env` file (see `.env.example`); the overlay below applies them
 * on top of the JSON defaults.
 *
 * Expo/Metro only inlines literal `process.env.EXPO_PUBLIC_*` member accesses,
 * so each variable is referenced explicitly rather than via a dynamic key.
 */
import rawConfig from './appconfig.json';

export interface KafkaProxyConfig {
  /** Base URL of the Stash Kafka proxy, e.g. https://stash-kafka-proxy.vercel.app. */
  BaseUrl: string;
  /** How long the app waits between polls once a poll comes back empty. */
  PollIntervalMs: number;
  /** Server-side long-poll window per request. */
  PollTimeoutMs: number;
  MaxRecordsPerPoll: number;
  RequestTimeoutSeconds: number;
}

export interface KafkaConfig {
  TopicUploadRequest: string;
  TopicUploadResponse: string;
  TopicDeadLetter: string;
  Proxy: KafkaProxyConfig;
}

export interface S3Config {
  Bucket: string;
  Region: string;
  AccessKeyId: string;
  SecretAccessKey: string;
  /** Optional temporary-credential token (STS / IAM role). */
  SessionToken: string;
  /** Custom endpoint, e.g. https://minio.example.com or R2. Empty = AWS. */
  Endpoint: string;
  /** Path-style is required by MinIO and most S3-compatible servers. */
  ForcePathStyle: boolean;
  /** Optional key prefix, no leading/trailing slash. */
  Prefix: string;
  /** Presigned URL lifetime in seconds (1..604800). */
  PresignExpirySeconds: number;
}

export interface StorageConfig {
  Provider: string;
  S3: S3Config;
}

export interface UploadSettings {
  BatchSize: number;
  /** Host processing attempts, tracked separately from transfer retries. */
  MaxHostRetries: number;
  MaxRetries: number;
  MaxFileSizeBytes: number;
  /** Max declared bytes in one upload batch; 0 or less means unlimited. */
  MaxConcurrentBytes: number;
}

export interface BackgroundUploadConfig {
  Enabled: boolean;
  IntervalMinutes: number;
  MaxFilesPerRun: number;
}

export interface StashConfig {
  Kafka: KafkaConfig;
  Storage: StorageConfig;
  IdentityApiBaseUrl: string;
  IdentityApiTimeoutSeconds: number;
  UploadSettings: UploadSettings;
  BackgroundUpload: BackgroundUploadConfig;
}

const resolveEnv = (value: string | undefined, fallback: string): string =>
  value !== undefined && value !== '' ? value : fallback;

/** Treats `1`/`true`/`yes`/`on` (case-insensitive) as true; empty keeps the default. */
const resolveBool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
};

/** Parses a numeric override; empty or non-numeric values keep the default. */
const resolveNumber = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const appConfig: StashConfig = {
  ...(rawConfig as StashConfig),
  IdentityApiBaseUrl: resolveEnv(
    process.env.EXPO_PUBLIC_IDENTITY_API_BASE_URL,
    rawConfig.IdentityApiBaseUrl,
  ),
  Kafka: {
    ...rawConfig.Kafka,
    Proxy: {
      ...rawConfig.Kafka.Proxy,
      BaseUrl: resolveEnv(
        process.env.EXPO_PUBLIC_KAFKA_PROXY_BASE_URL,
        rawConfig.Kafka.Proxy.BaseUrl,
      ),
    },
  },
  Storage: {
    ...rawConfig.Storage,
    S3: {
      ...rawConfig.Storage.S3,
      Bucket: resolveEnv(process.env.EXPO_PUBLIC_S3_BUCKET, rawConfig.Storage.S3.Bucket),
      Region: resolveEnv(process.env.EXPO_PUBLIC_S3_REGION, rawConfig.Storage.S3.Region),
      AccessKeyId: resolveEnv(
        process.env.EXPO_PUBLIC_S3_ACCESS_KEY_ID,
        rawConfig.Storage.S3.AccessKeyId,
      ),
      SecretAccessKey: resolveEnv(
        process.env.EXPO_PUBLIC_S3_SECRET_ACCESS_KEY,
        rawConfig.Storage.S3.SecretAccessKey,
      ),
      SessionToken: resolveEnv(
        process.env.EXPO_PUBLIC_S3_SESSION_TOKEN,
        rawConfig.Storage.S3.SessionToken,
      ),
      Endpoint: resolveEnv(process.env.EXPO_PUBLIC_S3_ENDPOINT, rawConfig.Storage.S3.Endpoint),
      ForcePathStyle: resolveBool(
        process.env.EXPO_PUBLIC_S3_FORCE_PATH_STYLE,
        rawConfig.Storage.S3.ForcePathStyle,
      ),
      Prefix: resolveEnv(process.env.EXPO_PUBLIC_S3_PREFIX, rawConfig.Storage.S3.Prefix),
      PresignExpirySeconds: resolveNumber(
        process.env.EXPO_PUBLIC_S3_PRESIGN_EXPIRY_SECONDS,
        rawConfig.Storage.S3.PresignExpirySeconds,
      ),
    },
  },
  UploadSettings: {
    ...rawConfig.UploadSettings,
    MaxHostRetries: resolveNumber(
      process.env.EXPO_PUBLIC_UPLOAD_MAX_HOST_RETRIES,
      rawConfig.UploadSettings.MaxHostRetries,
    ),
    MaxConcurrentBytes: resolveNumber(
      process.env.EXPO_PUBLIC_UPLOAD_MAX_CONCURRENT_BYTES,
      rawConfig.UploadSettings.MaxConcurrentBytes,
    ),
  },
};

export function identityApiBaseUrl(): string | null {
  const raw = appConfig.IdentityApiBaseUrl.trim();
  if (!raw) {
    return null;
  }
  return trimTrailingSlash(raw);
}

/** Proxy base URL, or null when it is unset or still the documented placeholder. */
export function kafkaProxyUrl(): string | null {
  const raw = appConfig.Kafka.Proxy.BaseUrl.trim();
  if (!raw || /[<>]/.test(raw)) {
    return null;
  }
  return trimTrailingSlash(raw);
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** Resolves a relative API path against a normalized base (no double slashes). */
export function resolveUrl(base: string, path: string): string {
  return `${trimTrailingSlash(base)}/${path.replace(/^\/+/, '')}`;
}