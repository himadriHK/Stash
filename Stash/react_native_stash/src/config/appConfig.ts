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
  /** Route produce/consume through the Stash Kafka proxy (Vercel Function). */
  Enabled: boolean;
  /** Base URL of the deployed proxy, e.g. https://stash-kafka-proxy.vercel.app. */
  BaseUrl: string;
  /** How long the app waits between polls once a poll comes back empty. */
  PollIntervalMs: number;
  /** Server-side long-poll window per request. */
  PollTimeoutMs: number;
  MaxRecordsPerPoll: number;
  RequestTimeoutSeconds: number;
}

export interface KafkaConfig {
  BootstrapServers: string;
  Username: string;
  Password: string;
  /** Base URL of the Confluent REST Proxy, optionally with a path prefix. */
  RestUrl: string;
  RestUsername: string;
  RestPassword: string;
  RestTimeoutSeconds: number;
  /** Optional cluster id for the v3 produce endpoint; discovered when empty. */
  ClusterId: string;
  TopicUploadRequest: string;
  TopicUploadResponse: string;
  TopicDeadLetter: string;
  Proxy: KafkaProxyConfig;
}

export interface MegaConfig {
  /** MEGA account the app logs into with react-native-mega. */
  Email: string;
  Password: string;
  /** Optional TOTP code for accounts with two-factor authentication. */
  SecondFactorCode: string;
}

export interface StorageConfig {
  Provider: string;
  Mega: MegaConfig;
}

export interface JwtConfig {
  Issuer: string;
  Audience: string;
}

export interface UploadSettings {
  BatchSize: number;
  MaxRetries: number;
  MaxFileSizeBytes: number;
}

export interface BackgroundUploadConfig {
  Enabled: boolean;
  IntervalMinutes: number;
  MaxFilesPerRun: number;
}

export interface ApplicationInsightsConfig {
  Enabled: boolean;
  ConnectionString: string;
}

export interface StashConfig {
  Kafka: KafkaConfig;
  Storage: StorageConfig;
  Auth: { Jwt: JwtConfig };
  IdentityApiBaseUrl: string;
  IdentityApiTimeoutSeconds: number;
  UploadSettings: UploadSettings;
  BackgroundUpload: BackgroundUploadConfig;
  ApplicationInsights: ApplicationInsightsConfig;
}

const resolveEnv = (value: string | undefined, fallback: string): string =>
  value !== undefined && value !== '' ? value : fallback;

export const appConfig: StashConfig = {
  ...(rawConfig as StashConfig),
  IdentityApiBaseUrl: resolveEnv(
    process.env.EXPO_PUBLIC_IDENTITY_API_BASE_URL,
    rawConfig.IdentityApiBaseUrl,
  ),
  Kafka: {
    ...rawConfig.Kafka,
    BootstrapServers: resolveEnv(
      process.env.EXPO_PUBLIC_KAFKA_BOOTSTRAP_SERVERS,
      rawConfig.Kafka.BootstrapServers,
    ),
    Username: resolveEnv(process.env.EXPO_PUBLIC_KAFKA_USERNAME, rawConfig.Kafka.Username),
    Password: resolveEnv(process.env.EXPO_PUBLIC_KAFKA_PASSWORD, rawConfig.Kafka.Password),
    RestUrl: resolveEnv(process.env.EXPO_PUBLIC_KAFKA_REST_URL, rawConfig.Kafka.RestUrl),
    RestUsername: resolveEnv(
      process.env.EXPO_PUBLIC_KAFKA_REST_USERNAME,
      rawConfig.Kafka.RestUsername,
    ),
    RestPassword: resolveEnv(
      process.env.EXPO_PUBLIC_KAFKA_REST_PASSWORD,
      rawConfig.Kafka.RestPassword,
    ),
    ClusterId: resolveEnv(process.env.EXPO_PUBLIC_KAFKA_CLUSTER_ID, rawConfig.Kafka.ClusterId),
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
    Mega: {
      ...rawConfig.Storage.Mega,
      Email: resolveEnv(process.env.EXPO_PUBLIC_MEGA_EMAIL, rawConfig.Storage.Mega.Email),
      Password: resolveEnv(
        process.env.EXPO_PUBLIC_MEGA_PASSWORD,
        rawConfig.Storage.Mega.Password,
      ),
      SecondFactorCode: resolveEnv(
        process.env.EXPO_PUBLIC_MEGA_SECOND_FACTOR_CODE,
        rawConfig.Storage.Mega.SecondFactorCode,
      ),
    },
  },
  ApplicationInsights: {
    ...rawConfig.ApplicationInsights,
    ConnectionString: resolveEnv(
      process.env.EXPO_PUBLIC_APPINSIGHTS_CONNECTION_STRING,
      rawConfig.ApplicationInsights.ConnectionString,
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

export function kafkaRestUrl(): string | null {
  const raw = appConfig.Kafka.RestUrl.trim();
  if (!raw) {
    return null;
  }
  return trimTrailingSlash(raw) + '/';
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