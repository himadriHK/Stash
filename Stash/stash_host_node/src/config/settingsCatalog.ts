import os from 'node:os';
import path from 'node:path';

export type SettingType = 'text' | 'number' | 'boolean' | 'select' | 'csv' | 'secret' | 'path';

export type SettingGroupId =
  | 'runtime'
  | 'kafka'
  | 's3'
  | 'jwt'
  | 'worker'
  | 'media'
  | 'dashboard';

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingGroup {
  id: SettingGroupId;
  label: string;
  description: string;
}

export interface SettingDefinition {
  key: string;
  label: string;
  description: string;
  group: SettingGroupId;
  type: SettingType;
  defaultValue: string | null;
  min?: number;
  max?: number;
  options?: readonly SettingOption[];
  secret: boolean;
  requiresRestart: boolean;
  unit?: 'ms' | 'seconds' | 'bytes' | 'percent' | 'pixels';
  placeholder?: string;
}

const DEFAULT_TEMP_DIR = path.join(os.tmpdir(), 'stash-host-node');

const SECRET_KEYS = new Set([
  'JWT_SIGNING_KEY',
  'KAFKA_USERNAME',
  'KAFKA_PASSWORD',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_SESSION_TOKEN',
  'DASHBOARD_USER',
  'DASHBOARD_PASSWORD',
]);

const NODE_ENV_OPTIONS: readonly SettingOption[] = [
  { value: 'development', label: 'Development' },
  { value: 'test', label: 'Test' },
  { value: 'production', label: 'Production' },
];

const LOG_LEVEL_OPTIONS: readonly SettingOption[] = [
  { value: 'fatal', label: 'Fatal' },
  { value: 'error', label: 'Error' },
  { value: 'warn', label: 'Warn' },
  { value: 'info', label: 'Info' },
  { value: 'debug', label: 'Debug' },
  { value: 'trace', label: 'Trace' },
];

const SASL_MECHANISM_OPTIONS: readonly SettingOption[] = [
  { value: 'plain', label: 'PLAIN' },
  { value: 'scram-sha-256', label: 'SCRAM-SHA-256' },
  { value: 'scram-sha-512', label: 'SCRAM-SHA-512' },
];

const RAW_DECODER_OPTIONS: readonly SettingOption[] = [
  { value: 'libraw', label: 'LibRaw' },
  { value: 'wasm', label: 'WASM' },
  { value: 'imagemagick', label: 'ImageMagick' },
];

type SettingDefinitionInput = Omit<SettingDefinition, 'secret' | 'requiresRestart'>;

interface CommonSettingInput {
  key: string;
  label: string;
  description: string;
  group: SettingGroupId;
  unit?: SettingDefinition['unit'];
  placeholder?: string;
}

function define(input: SettingDefinitionInput): SettingDefinition {
  const secret = SECRET_KEYS.has(input.key);
  return {
    ...input,
    type: secret && input.type === 'text' ? 'secret' : input.type,
    secret,
    requiresRestart: input.key !== 'LOG_LEVEL',
  };
}

function text(input: CommonSettingInput, defaultValue: string | null = null): SettingDefinition {
  return define({ ...input, type: 'text', defaultValue });
}

function numberSetting(
  input: CommonSettingInput,
  defaultValue: string,
  min: number,
  max: number,
): SettingDefinition {
  return define({ ...input, type: 'number', defaultValue, min, max });
}

function booleanSetting(input: CommonSettingInput, defaultValue: boolean): SettingDefinition {
  return define({ ...input, type: 'boolean', defaultValue: String(defaultValue) });
}

function select(
  input: CommonSettingInput,
  defaultValue: string,
  options: readonly SettingOption[],
): SettingDefinition {
  return define({ ...input, type: 'select', defaultValue, options });
}

function csv(input: CommonSettingInput, defaultValue: string | null = null): SettingDefinition {
  return define({ ...input, type: 'csv', defaultValue });
}

function pathSetting(input: CommonSettingInput, defaultValue: string | null = null): SettingDefinition {
  return define({ ...input, type: 'path', defaultValue });
}

export const SETTING_GROUPS: readonly SettingGroup[] = [
  {
    id: 'runtime',
    label: 'Runtime',
    description: 'Process, HTTP listener, logging, and local storage settings.',
  },
  {
    id: 'kafka',
    label: 'Kafka',
    description: 'Broker connection, consumer group, and topic routing settings.',
  },
  {
    id: 's3',
    label: 'S3',
    description: 'Staging bucket, credentials, and request settings.',
  },
  {
    id: 'jwt',
    label: 'JWT',
    description: 'Access token verification and issuer settings.',
  },
  {
    id: 'worker',
    label: 'Worker and pipeline',
    description: 'Concurrency, leases, stage deadlines, retries, and temp retention.',
  },
  {
    id: 'media',
    label: 'Media',
    description: 'FFmpeg and image conversion settings.',
  },
  {
    id: 'dashboard',
    label: 'Dashboard and observability',
    description: 'Dashboard authentication, metrics, and health checks.',
  },
];

export const SETTINGS: readonly SettingDefinition[] = [
  select(
    {
      key: 'NODE_ENV',
      label: 'Environment',
      description: 'Selects development, test, or production runtime behavior.',
      group: 'runtime',
    },
    'development',
    NODE_ENV_OPTIONS,
  ),
  text(
    {
      key: 'HOST',
      label: 'Bind address',
      description: 'Network address the HTTP server binds to.',
      group: 'runtime',
      placeholder: '127.0.0.1',
    },
    '127.0.0.1',
  ),
  numberSetting(
    {
      key: 'PORT',
      label: 'HTTP port',
      description: 'TCP port the host HTTP server listens on.',
      group: 'runtime',
    },
    '8080',
    1,
    65_535,
  ),
  select(
    {
      key: 'LOG_LEVEL',
      label: 'Log level',
      description: 'Minimum severity for host log output.',
      group: 'runtime',
    },
    'info',
    LOG_LEVEL_OPTIONS,
  ),
  pathSetting(
    {
      key: 'DB_PATH',
      label: 'Database path',
      description: 'Path to the SQLite database file.',
      group: 'runtime',
      placeholder: './data/stash_host.db',
    },
    './data/stash_host.db',
  ),
  pathSetting({
    key: 'LOCAL_ROOT_PATH',
    label: 'Local library root',
    description: 'Absolute path to the local media library root.',
    group: 'runtime',
    placeholder: 'D:\\StashLibrary',
  }),
  pathSetting(
    {
      key: 'TEMP_DIR',
      label: 'Temporary directory',
      description: 'Directory used for staging downloads and intermediate files.',
      group: 'runtime',
    },
    DEFAULT_TEMP_DIR,
  ),

  booleanSetting(
    {
      key: 'KAFKA_ENABLED',
      label: 'Kafka enabled',
      description: 'Enables the Kafka consumer and producer.',
      group: 'kafka',
    },
    true,
  ),
  csv(
    {
      key: 'KAFKA_BROKERS',
      label: 'Brokers',
      description: 'Comma-separated list of Kafka broker addresses.',
      group: 'kafka',
      placeholder: 'localhost:9092',
    },
    null,
  ),
  text(
    {
      key: 'KAFKA_CLIENT_ID',
      label: 'Client ID',
      description: 'Kafka client identifier reported to brokers.',
      group: 'kafka',
    },
    'stash-host-node',
  ),
  text(
    {
      key: 'KAFKA_GROUP_ID',
      label: 'Consumer group ID',
      description: 'Consumer group used for upload request messages.',
      group: 'kafka',
    },
    'stash-upload-request',
  ),
  text(
    {
      key: 'KAFKA_REQUEST_TOPIC',
      label: 'Request topic',
      description: 'Topic that carries upload requests.',
      group: 'kafka',
    },
    'stash.upload.request',
  ),
  text(
    {
      key: 'KAFKA_RESPONSE_TOPIC',
      label: 'Response topic',
      description: 'Topic used to publish upload responses.',
      group: 'kafka',
    },
    'stash.upload.response',
  ),
  text(
    {
      key: 'KAFKA_DLQ_TOPIC',
      label: 'Dead-letter topic',
      description: 'Topic for messages that exhaust processing retries.',
      group: 'kafka',
    },
    'stash.dlq',
  ),
  booleanSetting(
    {
      key: 'KAFKA_SSL',
      label: 'SSL',
      description: 'Enables TLS for Kafka broker connections.',
      group: 'kafka',
    },
    true,
  ),
  select(
    {
      key: 'KAFKA_SASL_MECHANISM',
      label: 'SASL mechanism',
      description: 'SASL authentication mechanism used for Kafka connections.',
      group: 'kafka',
    },
    'scram-sha-256',
    SASL_MECHANISM_OPTIONS,
  ),
  text({
    key: 'KAFKA_USERNAME',
    label: 'Username',
    description: 'Username for Kafka SASL authentication.',
    group: 'kafka',
  }),
  text({
    key: 'KAFKA_PASSWORD',
    label: 'Password',
    description: 'Password for Kafka SASL authentication.',
    group: 'kafka',
  }),
  booleanSetting(
    {
      key: 'KAFKA_FROM_BEGINNING',
      label: 'Read from beginning',
      description: 'Starts the consumer from the earliest offset when no committed offset exists.',
      group: 'kafka',
    },
    false,
  ),
  numberSetting(
    {
      key: 'KAFKA_PAUSE_HIGH_WATERMARK',
      label: 'Pause high watermark',
      description: 'Queued message count at which the consumer pauses fetching.',
      group: 'kafka',
    },
    '500',
    1,
    1_000_000,
  ),
  numberSetting(
    {
      key: 'KAFKA_RESUME_LOW_WATERMARK',
      label: 'Resume low watermark',
      description: 'Queued message count at which the consumer resumes fetching.',
      group: 'kafka',
    },
    '200',
    0,
    1_000_000,
  ),
  numberSetting(
    {
      key: 'KAFKA_COMMIT_TIMEOUT_MS',
      label: 'Commit timeout',
      description: 'Maximum time to wait for a producer commit.',
      group: 'kafka',
      unit: 'ms',
    },
    '10000',
    1_000,
    600_000,
  ),
  booleanSetting(
    {
      key: 'KAFKA_DLQ_MIRROR_FAILURES',
      label: 'Mirror failures to DLQ',
      description: 'Publishes failed response messages to the dead-letter topic.',
      group: 'kafka',
    },
    false,
  ),

  booleanSetting(
    {
      key: 'S3_ENABLED',
      label: 'S3 enabled',
      description: 'Enables S3 staging storage.',
      group: 's3',
    },
    true,
  ),
  text(
    {
      key: 'S3_REGION',
      label: 'Region',
      description: 'AWS region for the S3 bucket.',
      group: 's3',
    },
    'us-east-1',
  ),
  text({
    key: 'S3_BUCKET',
    label: 'Bucket',
    description: 'Name of the S3 bucket used for staging.',
    group: 's3',
  }),
  text({
    key: 'S3_ENDPOINT',
    label: 'Endpoint',
    description: 'Custom S3-compatible endpoint URL.',
    group: 's3',
    placeholder: 'https://s3.example.com',
  }),
  booleanSetting(
    {
      key: 'S3_FORCE_PATH_STYLE',
      label: 'Force path style',
      description: 'Uses path-style bucket addressing for S3-compatible services.',
      group: 's3',
    },
    false,
  ),
  text({
    key: 'S3_ACCESS_KEY_ID',
    label: 'Access key ID',
    description: 'Access key ID for S3 authentication.',
    group: 's3',
  }),
  text({
    key: 'S3_SECRET_ACCESS_KEY',
    label: 'Secret access key',
    description: 'Secret access key for S3 authentication.',
    group: 's3',
  }),
  text({
    key: 'S3_SESSION_TOKEN',
    label: 'Session token',
    description: 'Optional session token for temporary S3 credentials.',
    group: 's3',
  }),
  text({
    key: 'S3_PREFIX',
    label: 'Object prefix',
    description: 'Key prefix applied to objects written to the bucket.',
    group: 's3',
  }),
  numberSetting(
    {
      key: 'S3_REQUEST_TIMEOUT_MS',
      label: 'Request timeout',
      description: 'Maximum time to wait for an S3 request.',
      group: 's3',
      unit: 'ms',
    },
    '300000',
    1_000,
    3_600_000,
  ),

  text({
    key: 'JWT_SIGNING_KEY',
    label: 'Signing key',
    description: 'Shared HS256 secret used to verify access tokens.',
    group: 'jwt',
  }),
  text(
    {
      key: 'JWT_ISSUER',
      label: 'Issuer',
      description: 'Expected issuer claim on access tokens.',
      group: 'jwt',
    },
    'stash-auth',
  ),
  text(
    {
      key: 'JWT_AUDIENCE',
      label: 'Audience',
      description: 'Expected audience claim on access tokens.',
      group: 'jwt',
    },
    'stash-app',
  ),
  numberSetting(
    {
      key: 'JWT_CLOCK_TOLERANCE_SECONDS',
      label: 'Clock tolerance',
      description: 'Allowed clock skew when verifying token timestamps.',
      group: 'jwt',
      unit: 'seconds',
    },
    '0',
    0,
    300,
  ),

  booleanSetting(
    {
      key: 'WORKER_ENABLED',
      label: 'Workers enabled',
      description: 'Runs background job workers inside the host process.',
      group: 'worker',
    },
    true,
  ),
  numberSetting(
    {
      key: 'WORKER_CONCURRENCY',
      label: 'Worker concurrency',
      description: 'Number of jobs processed concurrently by the worker pool.',
      group: 'worker',
    },
    '2',
    1,
    64,
  ),
  numberSetting(
    {
      key: 'WORKER_HASH_THREADS',
      label: 'Hash threads',
      description: 'Number of threads used for file hashing.',
      group: 'worker',
    },
    '2',
    1,
    64,
  ),
  numberSetting(
    {
      key: 'IMAGE_CONCURRENCY',
      label: 'Image concurrency',
      description: 'Maximum concurrent image conversion tasks.',
      group: 'worker',
    },
    '2',
    1,
    64,
  ),
  numberSetting(
    {
      key: 'VIDEO_CONCURRENCY',
      label: 'Video concurrency',
      description: 'Maximum concurrent video conversion tasks.',
      group: 'worker',
    },
    '1',
    1,
    64,
  ),
  numberSetting(
    {
      key: 'JOB_MAX_ATTEMPTS',
      label: 'Job max attempts',
      description: 'Maximum processing attempts before a job is marked failed.',
      group: 'worker',
    },
    '4',
    1,
    20,
  ),
  numberSetting(
    {
      key: 'LEASE_SECONDS',
      label: 'Lease duration',
      description: 'How long a worker holds a job lease before another worker may reclaim it.',
      group: 'worker',
      unit: 'seconds',
    },
    '120',
    10,
    3_600,
  ),
  numberSetting(
    {
      key: 'HASH_WORKER_TIMEOUT_MS',
      label: 'Hash timeout',
      description: 'Per-job deadline for the hashing worker.',
      group: 'worker',
      unit: 'ms',
    },
    '300000',
    1_000,
    3_600_000,
  ),
  numberSetting(
    {
      key: 'MEDIA_WORKER_TIMEOUT_MS',
      label: 'Media timeout',
      description: 'Per-job deadline for the media worker.',
      group: 'worker',
      unit: 'ms',
    },
    '600000',
    1_000,
    3_600_000,
  ),
  numberSetting(
    {
      key: 'HEARTBEAT_SECONDS',
      label: 'Heartbeat interval',
      description: 'Interval between worker lease heartbeats.',
      group: 'worker',
      unit: 'seconds',
    },
    '30',
    5,
    600,
  ),
  numberSetting(
    {
      key: 'RECOVERY_INTERVAL_SECONDS',
      label: 'Recovery interval',
      description: 'Interval between scans for expired job leases.',
      group: 'worker',
      unit: 'seconds',
    },
    '30',
    5,
    3_600,
  ),
  numberSetting(
    {
      key: 'DISK_MIN_FREE_BYTES',
      label: 'Minimum free disk',
      description: 'Minimum free space required before accepting new jobs.',
      group: 'worker',
      unit: 'bytes',
    },
    '5368709120',
    0,
    1_099_511_627_776,
  ),
  numberSetting(
    {
      key: 'TEMP_RETENTION_HOURS',
      label: 'Temp retention',
      description: 'Hours to keep staged temporary files before cleanup.',
      group: 'worker',
    },
    '24',
    1,
    8_760,
  ),
  numberSetting(
    {
      key: 'STAGE_TIMEOUT_DOWNLOAD_MS',
      label: 'Download stage timeout',
      description: 'Per-stage deadline for the download stage.',
      group: 'worker',
      unit: 'ms',
    },
    '900000',
    1_000,
    86_400_000,
  ),
  numberSetting(
    {
      key: 'STAGE_TIMEOUT_VERIFY_MS',
      label: 'Verify stage timeout',
      description: 'Per-stage deadline for the verify stage.',
      group: 'worker',
      unit: 'ms',
    },
    '300000',
    1_000,
    86_400_000,
  ),
  numberSetting(
    {
      key: 'STAGE_TIMEOUT_CONVERT_IMAGE_MS',
      label: 'Image conversion stage timeout',
      description: 'Per-stage deadline for the image conversion stage.',
      group: 'worker',
      unit: 'ms',
    },
    '300000',
    1_000,
    86_400_000,
  ),
  numberSetting(
    {
      key: 'STAGE_TIMEOUT_CONVERT_VIDEO_MS',
      label: 'Video conversion stage timeout',
      description: 'Per-stage deadline for the video conversion stage.',
      group: 'worker',
      unit: 'ms',
    },
    '3600000',
    1_000,
    86_400_000,
  ),
  numberSetting(
    {
      key: 'STAGE_TIMEOUT_THUMBNAILS_MS',
      label: 'Thumbnail stage timeout',
      description: 'Per-stage deadline for the thumbnail stage.',
      group: 'worker',
      unit: 'ms',
    },
    '600000',
    1_000,
    86_400_000,
  ),
  numberSetting(
    {
      key: 'STAGE_TIMEOUT_STORE_MS',
      label: 'Store stage timeout',
      description: 'Per-stage deadline for the store stage.',
      group: 'worker',
      unit: 'ms',
    },
    '600000',
    1_000,
    86_400_000,
  ),
  numberSetting(
    {
      key: 'STAGE_TIMEOUT_RESPOND_MS',
      label: 'Respond stage timeout',
      description: 'Per-stage deadline for the respond stage.',
      group: 'worker',
      unit: 'ms',
    },
    '60000',
    1_000,
    86_400_000,
  ),
  numberSetting(
    {
      key: 'STAGE_TIMEOUT_DELETE_MS',
      label: 'Delete stage timeout',
      description: 'Per-stage deadline for the delete stage.',
      group: 'worker',
      unit: 'ms',
    },
    '60000',
    1_000,
    86_400_000,
  ),
  numberSetting(
    {
      key: 'RETRY_BASE_MS',
      label: 'Retry base',
      description: 'Base delay for exponential retry backoff.',
      group: 'worker',
      unit: 'ms',
    },
    '2000',
    100,
    3_600_000,
  ),
  numberSetting(
    {
      key: 'RETRY_MAX_MS',
      label: 'Retry maximum',
      description: 'Maximum delay between job retry attempts.',
      group: 'worker',
      unit: 'ms',
    },
    '300000',
    100,
    3_600_000,
  ),
  booleanSetting(
    {
      key: 'DELETE_TEMP_ON_FAILURE',
      label: 'Delete temp on failure',
      description: 'Deletes the staged S3 object on failure when true; keeps it when false.',
      group: 'worker',
    },
    true,
  ),

  pathSetting({
    key: 'FFMPEG_PATH',
    label: 'FFmpeg path',
    description: 'Explicit path to the FFmpeg binary.',
    group: 'media',
  }),
  pathSetting({
    key: 'FFPROBE_PATH',
    label: 'FFprobe path',
    description: 'Explicit path to the FFprobe binary.',
    group: 'media',
  }),
  text(
    {
      key: 'FFMPEG_VIDEO_CODEC',
      label: 'Video codec',
      description: 'FFmpeg video codec used for transcoding.',
      group: 'media',
    },
    'libx264',
  ),
  numberSetting(
    {
      key: 'FFMPEG_CRF',
      label: 'CRF',
      description: 'FFmpeg constant rate factor controlling video quality.',
      group: 'media',
    },
    '23',
    0,
    51,
  ),
  text(
    {
      key: 'FFMPEG_PRESET',
      label: 'Preset',
      description: 'FFmpeg encoding speed preset.',
      group: 'media',
    },
    'fast',
  ),
  numberSetting(
    {
      key: 'THUMBNAIL_QUALITY',
      label: 'Thumbnail quality',
      description: 'JPEG quality for generated thumbnails.',
      group: 'media',
      unit: 'percent',
    },
    '90',
    1,
    100,
  ),
  numberSetting(
    {
      key: 'IMAGE_JPEG_QUALITY',
      label: 'JPEG quality',
      description: 'JPEG quality for converted images.',
      group: 'media',
      unit: 'percent',
    },
    '90',
    1,
    100,
  ),
  numberSetting(
    {
      key: 'MAX_IMAGE_PIXELS',
      label: 'Maximum image pixels',
      description: 'Maximum decoded pixel count allowed for images.',
      group: 'media',
      unit: 'pixels',
    },
    '200000000',
    1,
    1_000_000_000,
  ),
  booleanSetting(
    {
      key: 'HEIC_WORKER_ENABLED',
      label: 'HEIC worker',
      description: 'Enables HEIC decoding in the media worker.',
      group: 'media',
    },
    true,
  ),
  select(
    {
      key: 'RAW_DECODER',
      label: 'RAW decoder',
      description: 'Backend used to decode RAW camera images.',
      group: 'media',
    },
    'libraw',
    RAW_DECODER_OPTIONS,
  ),

  booleanSetting(
    {
      key: 'DASHBOARD_AUTH_ENABLED',
      label: 'Dashboard auth',
      description: 'Requires credentials to access the dashboard.',
      group: 'dashboard',
    },
    false,
  ),
  text({
    key: 'DASHBOARD_USER',
    label: 'Dashboard user',
    description: 'Username for dashboard basic authentication.',
    group: 'dashboard',
  }),
  text({
    key: 'DASHBOARD_PASSWORD',
    label: 'Dashboard password',
    description: 'Password for dashboard basic authentication.',
    group: 'dashboard',
  }),
  booleanSetting(
    {
      key: 'METRICS_ENABLED',
      label: 'Metrics enabled',
      description: 'Exposes Prometheus metrics from the host.',
      group: 'dashboard',
    },
    true,
  ),
  numberSetting(
    {
      key: 'COMPONENT_CHECK_INTERVAL_SECONDS',
      label: 'Component check interval',
      description: 'Interval between dashboard component health checks.',
      group: 'dashboard',
      unit: 'seconds',
    },
    '60',
    5,
    86_400,
  ),
];

export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingDefinition> = new Map(
  SETTINGS.map((setting) => [setting.key, setting]),
);

export const MANAGED_ENV_KEYS: readonly string[] = SETTINGS.map((setting) => setting.key);

export function getSetting(key: string): SettingDefinition | undefined {
  return SETTINGS_BY_KEY.get(key);
}
