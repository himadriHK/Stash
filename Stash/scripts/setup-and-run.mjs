#!/usr/bin/env node
/**
 * Stash local setup-and-run orchestrator.
 *
 * Prompts for (or derives) local values, renders each project's .env from its
 * .env.example, writes the files atomically, then installs dependencies, runs
 * build/validation checks, and starts the local services with health checks.
 * Every key in each project's .env gets a value (secrets are collected or
 * generated), and the React Native app's src/config/appconfig.json is synced
 * with every setting, including its S3 credentials.
 * Use --dry-run to print the full plan without changing or starting anything.
 */

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';

const MIN_NODE = { major: 22, minor: 18 };

const PROJECT_DIRS = {
  proxy: 'kafka_proxy_vercel',
  host: 'stash_host_node',
  expo: 'react_native_stash',
};

const VALID_ONLY = new Set(Object.keys(PROJECT_DIRS));
const VALID_PLATFORMS = new Set(['web', 'android', 'ios']);

const PROJECT_ORDER = ['proxy', 'host', 'expo'];
const EXPO_APP_CONFIG = path.join('src', 'config', 'appconfig.json');
const INSTALL_ARGS = ['install', '--no-audit', '--no-fund'];
const BUILD_COMMANDS = {
  proxy: { command: 'npm', args: ['run', 'typecheck'] },
  host: { command: 'npm', args: ['run', 'build'] },
  expo: { command: 'npm', args: ['run', 'typecheck'] },
};
const SERVICE_COLORS = { proxy: 36, host: 32, expo: 35 };
const HEALTH_TIMEOUT_MS = 30000;
const SHUTDOWN_KILL_DELAY_MS = 500;
const SHUTDOWN_GRACE_MS = 700;

const SECRET_KEYS = new Set([
  'JWT_SIGNING_KEY',
  'KAFKA_PASSWORD',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_SESSION_TOKEN',
  'EXPO_PUBLIC_S3_ACCESS_KEY_ID',
  'EXPO_PUBLIC_S3_SECRET_ACCESS_KEY',
  'EXPO_PUBLIC_S3_SESSION_TOKEN',
  'MONGODB_URI',
  'DASHBOARD_PASSWORD',
]);

// Secret values written into the React Native appconfig.json (dotted paths).
const SECRET_CONFIG_PATHS = new Set([
  'Storage.S3.AccessKeyId',
  'Storage.S3.SecretAccessKey',
  'Storage.S3.SessionToken',
]);

function isSecret(key) {
  return SECRET_KEYS.has(key) || SECRET_CONFIG_PATHS.has(key);
}

const DEFAULTS = {
  kafka: {
    enabled: true,
    brokers: 'localhost:9092',
    securityProtocol: 'SASL_SSL',
    saslMechanism: 'scram-sha-256',
    username: '',
    password: '',
    proxyClientId: 'stash-kafka-proxy-vercel',
    hostClientId: 'stash-host-node',
    hostGroupId: 'stash-upload-request',
    consumerGroupPrefix: 'stash-mobile',
    connectionTimeoutMs: 10000,
    requestTimeoutMs: 20000,
    consumerSessionTimeoutMs: 15000,
    consumerHeartbeatMs: 3000,
    commitTimeoutMs: 10000,
    fromBeginning: false,
    pauseHighWatermark: 500,
    resumeLowWatermark: 200,
    dlqMirrorFailures: false,
    topics: {
      request: 'stash.upload.request',
      response: 'stash.upload.response',
      dlq: 'stash.dlq',
    },
  },
  s3: {
    enabled: true,
    bucket: '',
    region: 'us-east-1',
    accessKeyId: '',
    secretAccessKey: '',
    sessionToken: '',
    endpoint: '',
    prefix: '',
    forcePathStyle: false,
    presignExpirySeconds: 3600,
    requestTimeoutMs: 300000,
  },
  jwt: {
    issuer: 'stash-auth',
    audience: 'stash-app',
    accessTokenExpiryMinutes: 15,
    refreshTokenExpiryDays: 7,
    authMaxBodyBytes: 65536,
    clockToleranceSeconds: 0,
  },
  mongo: {
    uri: 'mongodb://localhost:27017',
    database: 'stash',
  },
  proxy: {
    host: '127.0.0.1',
    port: 3000,
    corsOrigins: 'http://localhost:8081',
    maxBodyBytes: 1048576,
    pollTimeoutMs: 8000,
  },
  host: {
    nodeEnv: 'development',
    bind: '127.0.0.1',
    port: 8080,
    logLevel: 'info',
    libraryRoot: '~/StashLibrary',
    dbPath: './data/stash_host.db',
    tempDir: '',
    worker: {
      enabled: true,
      concurrency: 2,
      hashThreads: 2,
      imageConcurrency: 2,
      videoConcurrency: 1,
      jobMaxAttempts: 4,
      leaseSeconds: 120,
      hashTimeoutMs: 300000,
      mediaTimeoutMs: 600000,
      heartbeatSeconds: 30,
      recoveryIntervalSeconds: 30,
      diskMinFreeBytes: 5368709120,
      tempRetentionHours: 24,
      retryBaseMs: 2000,
      retryMaxMs: 300000,
      deleteTempOnFailure: true,
    },
    stageTimeouts: {
      download: 900000,
      verify: 300000,
      convertImage: 300000,
      convertVideo: 3600000,
      thumbnails: 600000,
      store: 600000,
      respond: 60000,
      delete: 60000,
    },
    media: {
      ffmpegPath: '',
      ffprobePath: '',
      videoCodec: 'libx264',
      crf: 23,
      preset: 'fast',
      thumbnailQuality: 90,
      imageJpegQuality: 90,
      maxImagePixels: 200000000,
      heicWorkerEnabled: true,
      rawDecoder: 'libraw',
    },
    dashboard: {
      authEnabled: false,
      user: '',
      password: '',
      metricsEnabled: true,
      componentCheckIntervalSeconds: 60,
    },
  },
  expo: {
    port: 8081,
    uploadMaxConcurrentBytes: 268435456,
    uploadMaxHostRetries: 3,
  },
  app: {
    identityTimeoutSeconds: 30,
    pollIntervalMs: 15000,
    maxRecordsPerPoll: 50,
    proxyRequestTimeoutSeconds: 45,
    batchSize: 10,
    maxRetries: 3,
    maxFileSizeBytes: 524288000,
    backgroundUploadEnabled: true,
    backgroundUploadIntervalMinutes: 15,
    backgroundUploadMaxFilesPerRun: 50,
  },
};

const KAFKA_SECURITY_PROTOCOLS = ['PLAINTEXT', 'SSL', 'SASL_PLAINTEXT', 'SASL_SSL'];
const KAFKA_SASL_MECHANISMS = ['plain', 'scram-sha-256', 'scram-sha-512'];

const ROOT = path.resolve(import.meta.dirname, '..');

class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupError';
  }
}

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map((part) => Number(part));
  if (major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor)) {
    return;
  }
  console.error(
    `setup-and-run: Node.js >=${MIN_NODE.major}.${MIN_NODE.minor} is required; found v${process.versions.node}.`,
  );
  process.exit(1);
}

function printHelp() {
  console.log(`Stash local setup-and-run

Usage:
  node scripts/setup-and-run.mjs [options]

Writes every value (secrets included) into each project's .env and into the
React Native app's src/config/appconfig.json, installs dependencies, runs
build/validation checks, and starts the local services with health checks.

Options:
  -h, --help               Show this help and exit.
      --dry-run            Preview .env values and every planned install, build,
                           and service command; writes nothing and starts nothing.
                           Installs, builds, and services are all skipped.
  -y, --yes                Non-interactive: use existing values and defaults.
                           Docker is never started in this mode (only a warning).
      --skip-install       Skip npm dependency installation.
      --skip-build         Skip build/validation checks (proxy typecheck, host
                           build, Expo typecheck).
      --skip-run           Do not start the proxy, host, or Expo services.
      --platform=<target>  web | android | ios (default: web); passed to Expo.
      --only=<targets>     Comma-separated subset of proxy,host,expo (default: all).
                           Limits installs, build checks, and running services.

Notes:
  - Dry-run prints the plan and returns without writing or starting anything.
  - Without --yes, an unreachable local MongoDB offers to start Docker.
  - Requires Node.js >=${MIN_NODE.major}.${MIN_NODE.minor}.`);
}

function parseOnly(raw) {
  const tokens = raw
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  if (tokens.length === 0) {
    throw new SetupError('--only must list at least one of: proxy,host,expo.');
  }

  const selected = new Set();
  for (const token of tokens) {
    if (!VALID_ONLY.has(token)) {
      throw new SetupError(`Invalid --only target "${token}". Expected proxy, host, or expo.`);
    }
    selected.add(token);
  }
  return selected;
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    yes: false,
    skipInstall: false,
    skipBuild: false,
    skipRun: false,
    platform: 'web',
    only: new Set(VALID_ONLY),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--yes' || arg === '-y') {
      options.yes = true;
    } else if (arg === '--skip-install') {
      options.skipInstall = true;
    } else if (arg === '--skip-build') {
      options.skipBuild = true;
    } else if (arg === '--skip-run') {
      options.skipRun = true;
    } else if (arg === '--platform' || arg.startsWith('--platform=')) {
      const value = arg.includes('=') ? arg.slice('--platform='.length) : argv[++index];
      if (!value) {
        throw new SetupError('Missing value for --platform. Expected web, android, or ios.');
      }
      const normalized = value.toLowerCase();
      if (!VALID_PLATFORMS.has(normalized)) {
        throw new SetupError(`Invalid --platform "${value}". Expected web, android, or ios.`);
      }
      options.platform = normalized;
    } else if (arg === '--only' || arg.startsWith('--only=')) {
      const value = arg.includes('=') ? arg.slice('--only='.length) : argv[++index];
      if (!value) {
        throw new SetupError('Missing value for --only. Expected a comma-separated list of proxy,host,expo.');
      }
      options.only = parseOnly(value);
    } else {
      throw new SetupError(`Unknown argument "${arg}". Run with --help for usage.`);
    }
  }

  return options;
}

function resolveProjectDirs() {
  if (!existsSync(ROOT)) {
    throw new SetupError(`Repository root not found: ${ROOT}`);
  }

  const dirs = {};
  for (const [key, name] of Object.entries(PROJECT_DIRS)) {
    const dir = path.join(ROOT, name);
    if (!existsSync(dir)) {
      throw new SetupError(`Required project directory not found: ${dir}`);
    }
    dirs[key] = dir;
  }
  return dirs;
}

function readText(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

function parseDotenv(content) {
  const result = {};

  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    if (line.startsWith('export ')) {
      line = line.slice('export '.length).trim();
    }

    const equals = line.indexOf('=');
    if (equals <= 0) {
      continue;
    }

    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    } else {
      const comment = value.search(/\s#/);
      if (comment !== -1) {
        value = value.slice(0, comment).trimEnd();
      }
    }

    result[key] = value;
  }

  return result;
}

function readExistingEnvs(dirs) {
  const envs = {};
  for (const [key, dir] of Object.entries(dirs)) {
    envs[key] = parseDotenv(readText(path.join(dir, '.env')));
  }
  return envs;
}

function buildChildEnv(projectDir) {
  const env = { ...process.env };
  const envPath = path.join(projectDir, '.env');
  if (!existsSync(envPath)) {
    return env;
  }
  for (const key of Object.keys(parseDotenv(readText(envPath)))) {
    delete env[key];
  }
  return env;
}

function redact(key, value) {
  if (!isSecret(key)) {
    return value;
  }
  return value ? '[set]' : '(empty)';
}

function toForwardSlashes(value) {
  return value.replace(/\\/g, '/');
}

function expandVariables(value) {
  return value.replace(/%([^%]+)%/g, (match, name) => {
    const envValue = process.env[name];
    return envValue === undefined ? match : envValue;
  });
}

function expandPath(value) {
  let expanded = value;
  if (expanded === '~') {
    expanded = os.homedir();
  } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  return expandVariables(expanded);
}

function parseBool(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

function firstValue(envs, candidates, fallback) {
  for (const [project, key] of candidates) {
    const value = envs[project]?.[key];
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return fallback;
}

function readNumber(envs, candidates, fallback) {
  const raw = firstValue(envs, candidates, '');
  if (raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBool(envs, candidates, fallback) {
  return parseBool(firstValue(envs, candidates, ''), fallback);
}

function validateNonEmpty(value) {
  return value.trim() ? undefined : 'Value is required.';
}

function normalizeKafkaProtocol(value) {
  return String(value).trim().toUpperCase();
}

function validateKafkaProtocol(value) {
  return KAFKA_SECURITY_PROTOCOLS.includes(normalizeKafkaProtocol(value))
    ? undefined
    : `Security protocol must be one of: ${KAFKA_SECURITY_PROTOCOLS.join(', ')}.`;
}

function normalizeKafkaMechanism(value) {
  return String(value).trim().toLowerCase();
}

function validateKafkaMechanism(value) {
  return KAFKA_SASL_MECHANISMS.includes(normalizeKafkaMechanism(value))
    ? undefined
    : `SASL mechanism must be one of: ${KAFKA_SASL_MECHANISMS.join(', ')}.`;
}

function validatePort(value) {
  if (!/^\d+$/.test(value)) {
    return 'Port must be an integer between 1 and 65535.';
  }
  const port = Number(value);
  return port >= 1 && port <= 65535 ? undefined : 'Port must be between 1 and 65535.';
}

function validateJwtKey(value) {
  if (value === '') {
    return undefined;
  }
  return value.length >= 32
    ? undefined
    : 'JWT signing key must be at least 32 characters (or leave blank to generate one).';
}

function validateAbsolutePath(value) {
  const expanded = expandPath(value);
  return path.isAbsolute(expanded)
    ? undefined
    : 'Must be an absolute path after expanding ~ and %VAR%.';
}

function validateUrlWithoutTrailingSlash(value) {
  if (value === '') {
    return undefined;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return 'Must be a valid URL.';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Must use http or https.';
  }
  if (value.endsWith('/')) {
    return 'URL must not end with a trailing slash.';
  }
  return undefined;
}

function validateMongoUri(value) {
  if (!value.trim()) {
    return 'MongoDB URI is required.';
  }
  if (!/^mongodb(\+srv)?:\/\//i.test(value)) {
    return 'MongoDB URI must start with mongodb:// or mongodb+srv://.';
  }
  return value.endsWith('/') ? 'MongoDB URI must not end with a trailing slash.' : undefined;
}

function validateCorsOrigins(value) {
  if (!value.trim()) {
    return 'CORS origins are required (use * to allow all).';
  }

  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    return 'CORS origins are required (use * to allow all).';
  }

  for (const part of parts) {
    if (part === '*') {
      continue;
    }
    const problem = validateUrlWithoutTrailingSlash(part);
    if (problem) {
      return `Invalid origin "${part}": ${problem}`;
    }
  }
  return undefined;
}

// Note: readline echoes input, so values entered at a "secret" prompt are typed
// visibly. Masking would require raw-mode handling, which this script avoids.
async function promptText(rl, label, { defaultValue = '', validate, secret = false } = {}) {
  const shownDefault = secret && defaultValue ? '[set]' : defaultValue;
  const suffix = shownDefault !== '' ? ` [${shownDefault}]` : '';

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const raw = (await rl.question(`${label}${suffix}: `)).trim();
    const value = raw === '' ? defaultValue : raw;
    const problem = validate ? validate(value) : undefined;
    if (!problem) {
      return value;
    }
    console.error(`  ${problem}`);
  }

  throw new SetupError(`Too many invalid attempts for "${label}".`);
}

async function promptBool(rl, label, defaultValue) {
  const suffix = ` [${defaultValue ? 'yes' : 'no'}]`;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const raw = (await rl.question(`${label}${suffix}: `)).trim().toLowerCase();
    if (raw === '') {
      return defaultValue;
    }
    if (['y', 'yes', 'true', '1'].includes(raw)) {
      return true;
    }
    if (['n', 'no', 'false', '0'].includes(raw)) {
      return false;
    }
    console.error('  Please answer yes or no.');
  }

  throw new SetupError(`Too many invalid attempts for "${label}".`);
}

async function choose(rl, label, defaultValue, options = {}) {
  if (!rl) {
    return defaultValue;
  }
  return promptText(rl, label, { ...options, defaultValue });
}

async function chooseBool(rl, label, defaultValue) {
  if (!rl) {
    return defaultValue;
  }
  return promptBool(rl, label, defaultValue);
}

async function collectConfig(rl, envs) {
  const kafkaEnabledDefault = parseBool(
    firstValue(envs, [['host', 'KAFKA_ENABLED']], ''),
    DEFAULTS.kafka.enabled,
  );
  const kafkaEnabled = await chooseBool(rl, 'Enable Kafka integration?', kafkaEnabledDefault);

  const existingKafkaBrokersRaw = firstValue(
    envs,
    [['proxy', 'KAFKA_BOOTSTRAP_SERVERS'], ['host', 'KAFKA_BROKERS']],
    '',
  );
  const kafka = {
    enabled: kafkaEnabled,
    brokers: existingKafkaBrokersRaw,
    securityProtocol: normalizeKafkaProtocol(
      firstValue(envs, [['proxy', 'KAFKA_SECURITY_PROTOCOL']], DEFAULTS.kafka.securityProtocol),
    ),
    saslMechanism: normalizeKafkaMechanism(
      firstValue(
        envs,
        [['proxy', 'KAFKA_SASL_MECHANISM'], ['host', 'KAFKA_SASL_MECHANISM']],
        DEFAULTS.kafka.saslMechanism,
      ),
    ),
    username: firstValue(envs, [['proxy', 'KAFKA_USERNAME'], ['host', 'KAFKA_USERNAME']], DEFAULTS.kafka.username),
    password: firstValue(envs, [['proxy', 'KAFKA_PASSWORD'], ['host', 'KAFKA_PASSWORD']], DEFAULTS.kafka.password),
    proxyClientId: firstValue(envs, [['proxy', 'KAFKA_CLIENT_ID']], DEFAULTS.kafka.proxyClientId),
    hostClientId: firstValue(envs, [['host', 'KAFKA_CLIENT_ID']], DEFAULTS.kafka.hostClientId),
    hostGroupId: firstValue(envs, [['host', 'KAFKA_GROUP_ID']], DEFAULTS.kafka.hostGroupId),
    consumerGroupPrefix: firstValue(
      envs,
      [['proxy', 'CONSUMER_GROUP_PREFIX']],
      DEFAULTS.kafka.consumerGroupPrefix,
    ),
    connectionTimeoutMs: readNumber(
      envs,
      [['proxy', 'KAFKA_CONNECTION_TIMEOUT_MS']],
      DEFAULTS.kafka.connectionTimeoutMs,
    ),
    requestTimeoutMs: readNumber(
      envs,
      [['proxy', 'KAFKA_REQUEST_TIMEOUT_MS']],
      DEFAULTS.kafka.requestTimeoutMs,
    ),
    consumerSessionTimeoutMs: readNumber(
      envs,
      [['proxy', 'KAFKA_CONSUMER_SESSION_TIMEOUT_MS']],
      DEFAULTS.kafka.consumerSessionTimeoutMs,
    ),
    consumerHeartbeatMs: readNumber(
      envs,
      [['proxy', 'KAFKA_CONSUMER_HEARTBEAT_MS']],
      DEFAULTS.kafka.consumerHeartbeatMs,
    ),
    commitTimeoutMs: readNumber(
      envs,
      [['host', 'KAFKA_COMMIT_TIMEOUT_MS']],
      DEFAULTS.kafka.commitTimeoutMs,
    ),
    fromBeginning: readBool(envs, [['host', 'KAFKA_FROM_BEGINNING']], DEFAULTS.kafka.fromBeginning),
    pauseHighWatermark: readNumber(
      envs,
      [['host', 'KAFKA_PAUSE_HIGH_WATERMARK']],
      DEFAULTS.kafka.pauseHighWatermark,
    ),
    resumeLowWatermark: readNumber(
      envs,
      [['host', 'KAFKA_RESUME_LOW_WATERMARK']],
      DEFAULTS.kafka.resumeLowWatermark,
    ),
    dlqMirrorFailures: readBool(
      envs,
      [['host', 'KAFKA_DLQ_MIRROR_FAILURES']],
      DEFAULTS.kafka.dlqMirrorFailures,
    ),
    topics: {
      request: await choose(
        rl,
        'Kafka upload-request topic',
        firstValue(
          envs,
          [['host', 'KAFKA_REQUEST_TOPIC'], ['app', 'Kafka.TopicUploadRequest']],
          DEFAULTS.kafka.topics.request,
        ),
        { validate: validateNonEmpty },
      ),
      response: await choose(
        rl,
        'Kafka upload-response topic',
        firstValue(
          envs,
          [['host', 'KAFKA_RESPONSE_TOPIC'], ['app', 'Kafka.TopicUploadResponse']],
          DEFAULTS.kafka.topics.response,
        ),
        { validate: validateNonEmpty },
      ),
      dlq: await choose(
        rl,
        'Kafka dead-letter topic',
        firstValue(
          envs,
          [['host', 'KAFKA_DLQ_TOPIC'], ['app', 'Kafka.TopicDeadLetter']],
          DEFAULTS.kafka.topics.dlq,
        ),
        { validate: validateNonEmpty },
      ),
    },
  };

  if (!rl) {
    if (validateKafkaProtocol(kafka.securityProtocol)) {
      console.log(
        `  Warning: existing KAFKA_SECURITY_PROTOCOL is invalid; using ${DEFAULTS.kafka.securityProtocol}.`,
      );
      kafka.securityProtocol = DEFAULTS.kafka.securityProtocol;
    }
    if (validateKafkaMechanism(kafka.saslMechanism)) {
      console.log(
        `  Warning: existing KAFKA_SASL_MECHANISM is invalid; using ${DEFAULTS.kafka.saslMechanism}.`,
      );
      kafka.saslMechanism = DEFAULTS.kafka.saslMechanism;
    }
  }

  if (kafkaEnabled) {
    kafka.brokers = await choose(
      rl,
      'Kafka bootstrap servers',
      rl ? existingKafkaBrokersRaw || DEFAULTS.kafka.brokers : existingKafkaBrokersRaw,
      { validate: validateNonEmpty },
    );
    kafka.securityProtocol = normalizeKafkaProtocol(
      await choose(rl, 'Kafka security protocol', kafka.securityProtocol, {
        validate: validateKafkaProtocol,
      }),
    );
    kafka.saslMechanism = normalizeKafkaMechanism(
      await choose(rl, 'Kafka SASL mechanism', kafka.saslMechanism, {
        validate: validateKafkaMechanism,
      }),
    );
    if (kafka.securityProtocol.startsWith('SASL')) {
      kafka.username = await choose(
        rl,
        'Kafka username',
        firstValue(envs, [['proxy', 'KAFKA_USERNAME'], ['host', 'KAFKA_USERNAME']], DEFAULTS.kafka.username),
        { validate: validateNonEmpty },
      );
      kafka.password = await choose(
        rl,
        'Kafka password',
        firstValue(envs, [['proxy', 'KAFKA_PASSWORD'], ['host', 'KAFKA_PASSWORD']], DEFAULTS.kafka.password),
        { validate: validateNonEmpty, secret: true },
      );
    } else {
      kafka.username = '';
      kafka.password = '';
    }
  }

  const s3EnabledDefault = parseBool(
    firstValue(envs, [['host', 'S3_ENABLED']], ''),
    DEFAULTS.s3.enabled,
  );
  const s3Enabled = await chooseBool(rl, 'Enable S3 staging?', s3EnabledDefault);

  const s3 = {
    enabled: s3Enabled,
    bucket: firstValue(envs, [['host', 'S3_BUCKET'], ['expo', 'EXPO_PUBLIC_S3_BUCKET']], DEFAULTS.s3.bucket),
    region: firstValue(envs, [['host', 'S3_REGION'], ['expo', 'EXPO_PUBLIC_S3_REGION']], DEFAULTS.s3.region),
    accessKeyId: firstValue(
      envs,
      [['host', 'S3_ACCESS_KEY_ID'], ['expo', 'EXPO_PUBLIC_S3_ACCESS_KEY_ID']],
      DEFAULTS.s3.accessKeyId,
    ),
    secretAccessKey: firstValue(
      envs,
      [['host', 'S3_SECRET_ACCESS_KEY'], ['expo', 'EXPO_PUBLIC_S3_SECRET_ACCESS_KEY']],
      DEFAULTS.s3.secretAccessKey,
    ),
    sessionToken: firstValue(
      envs,
      [['host', 'S3_SESSION_TOKEN'], ['expo', 'EXPO_PUBLIC_S3_SESSION_TOKEN']],
      DEFAULTS.s3.sessionToken,
    ),
    endpoint: firstValue(envs, [['host', 'S3_ENDPOINT'], ['expo', 'EXPO_PUBLIC_S3_ENDPOINT']], DEFAULTS.s3.endpoint),
    prefix: firstValue(envs, [['host', 'S3_PREFIX'], ['expo', 'EXPO_PUBLIC_S3_PREFIX']], DEFAULTS.s3.prefix),
    forcePathStyle: parseBool(
      firstValue(
        envs,
        [['host', 'S3_FORCE_PATH_STYLE'], ['expo', 'EXPO_PUBLIC_S3_FORCE_PATH_STYLE']],
        '',
      ),
      DEFAULTS.s3.forcePathStyle,
    ),
    presignExpirySeconds: readNumber(
      envs,
      [['expo', 'EXPO_PUBLIC_S3_PRESIGN_EXPIRY_SECONDS'], ['app', 'Storage.S3.PresignExpirySeconds']],
      DEFAULTS.s3.presignExpirySeconds,
    ),
    requestTimeoutMs: readNumber(
      envs,
      [['host', 'S3_REQUEST_TIMEOUT_MS']],
      DEFAULTS.s3.requestTimeoutMs,
    ),
  };

  if (s3Enabled) {
    s3.bucket = await choose(rl, 'S3 bucket', s3.bucket, { validate: validateNonEmpty });
    s3.region = await choose(rl, 'S3 region', s3.region, { validate: validateNonEmpty });
    s3.accessKeyId = await choose(rl, 'S3 access key ID', s3.accessKeyId, {
      validate: validateNonEmpty,
      secret: true,
    });
    s3.secretAccessKey = await choose(rl, 'S3 secret access key', s3.secretAccessKey, {
      validate: validateNonEmpty,
      secret: true,
    });
    s3.sessionToken = await choose(rl, 'S3 session token (blank for none)', s3.sessionToken, {
      secret: true,
    });
    s3.endpoint = await choose(rl, 'S3 endpoint (blank for AWS)', s3.endpoint, {
      validate: validateUrlWithoutTrailingSlash,
    });
    s3.prefix = await choose(rl, 'S3 key prefix', s3.prefix);
    s3.forcePathStyle = await chooseBool(rl, 'S3 force path style?', s3.forcePathStyle);
  }

  let jwtSigningKey = firstValue(
    envs,
    [['proxy', 'JWT_SIGNING_KEY'], ['host', 'JWT_SIGNING_KEY']],
    '',
  );
  if (rl) {
    jwtSigningKey = await choose(rl, 'JWT signing key (blank generates one)', jwtSigningKey, {
      validate: validateJwtKey,
      secret: true,
    });
  }
  if (jwtSigningKey === '') {
    jwtSigningKey = randomBytes(24).toString('hex');
    console.log('  Generated a 48-character JWT signing key.');
  } else if (!rl && jwtSigningKey.length < 32) {
    console.log('  Warning: existing JWT signing key is shorter than 32 characters; generating a fresh 48-character key.');
    jwtSigningKey = randomBytes(24).toString('hex');
  }

  const jwt = {
    signingKey: jwtSigningKey,
    issuer: await choose(
      rl,
      'JWT issuer',
      firstValue(envs, [['proxy', 'JWT_ISSUER'], ['host', 'JWT_ISSUER']], DEFAULTS.jwt.issuer),
      { validate: validateNonEmpty },
    ),
    audience: await choose(
      rl,
      'JWT audience',
      firstValue(envs, [['proxy', 'JWT_AUDIENCE'], ['host', 'JWT_AUDIENCE']], DEFAULTS.jwt.audience),
      { validate: validateNonEmpty },
    ),
    accessTokenExpiryMinutes: readNumber(
      envs,
      [['proxy', 'AUTH_ACCESS_TOKEN_EXPIRY_MINUTES']],
      DEFAULTS.jwt.accessTokenExpiryMinutes,
    ),
    refreshTokenExpiryDays: readNumber(
      envs,
      [['proxy', 'AUTH_REFRESH_TOKEN_EXPIRY_DAYS']],
      DEFAULTS.jwt.refreshTokenExpiryDays,
    ),
    authMaxBodyBytes: readNumber(
      envs,
      [['proxy', 'AUTH_MAX_BODY_BYTES']],
      DEFAULTS.jwt.authMaxBodyBytes,
    ),
    clockToleranceSeconds: readNumber(
      envs,
      [['host', 'JWT_CLOCK_TOLERANCE_SECONDS']],
      DEFAULTS.jwt.clockToleranceSeconds,
    ),
  };

  const mongo = {
    uri: await choose(
      rl,
      'MongoDB URI',
      firstValue(envs, [['proxy', 'MONGODB_URI']], DEFAULTS.mongo.uri),
      { validate: validateMongoUri, secret: true },
    ),
    database: await choose(
      rl,
      'MongoDB database',
      firstValue(envs, [['proxy', 'MONGODB_DATABASE']], DEFAULTS.mongo.database),
      { validate: validateNonEmpty },
    ),
  };

  const dashboardAuthEnabled = await chooseBool(
    rl,
    'Require auth for the host dashboard?',
    readBool(envs, [['host', 'DASHBOARD_AUTH_ENABLED']], DEFAULTS.host.dashboard.authEnabled),
  );
  let dashboardUser = firstValue(
    envs,
    [['host', 'DASHBOARD_USER']],
    DEFAULTS.host.dashboard.user,
  );
  let dashboardPassword = firstValue(
    envs,
    [['host', 'DASHBOARD_PASSWORD']],
    DEFAULTS.host.dashboard.password,
  );
  if (dashboardAuthEnabled) {
    dashboardUser = await choose(rl, 'Dashboard user', dashboardUser || 'admin', {
      validate: validateNonEmpty,
    });
    dashboardPassword = await choose(rl, 'Dashboard password', dashboardPassword, {
      validate: validateNonEmpty,
      secret: true,
    });
  }
  if (dashboardAuthEnabled) {
    if (dashboardUser.trim() === '') {
      dashboardUser = 'admin';
    }
    if (dashboardPassword === '') {
      // Non-interactive run: generate a password so the dashboard stays usable.
      dashboardPassword = randomBytes(12).toString('hex');
      console.log(`\n  Generated a host dashboard password for ${dashboardUser}: ${dashboardPassword}`);
    }
  }

  const proxyPort = await choose(
    rl,
    'Kafka proxy port',
    firstValue(envs, [['proxy', 'PORT']], String(DEFAULTS.proxy.port)),
    { validate: validatePort },
  );

  const expoPortRaw = await choose(
    rl,
    'Expo dev server port',
    firstValue(envs, [['expo', 'EXPO_DEV_PORT']], String(DEFAULTS.expo.port)),
    { validate: validatePort },
  );
  const expoPort = normalizePort(expoPortRaw, DEFAULTS.expo.port);

  const expo = {
    port: expoPort,
    uploadMaxConcurrentBytes: readNumber(
      envs,
      [['expo', 'EXPO_PUBLIC_UPLOAD_MAX_CONCURRENT_BYTES'], ['app', 'UploadSettings.MaxConcurrentBytes']],
      DEFAULTS.expo.uploadMaxConcurrentBytes,
    ),
    uploadMaxHostRetries: readNumber(
      envs,
      [['expo', 'EXPO_PUBLIC_UPLOAD_MAX_HOST_RETRIES'], ['app', 'UploadSettings.MaxHostRetries']],
      DEFAULTS.expo.uploadMaxHostRetries,
    ),
  };

  // App-level tuning the React Native app keeps in src/config/appconfig.json.
  const app = {
    identityTimeoutSeconds: readNumber(
      envs,
      [['app', 'IdentityApiTimeoutSeconds']],
      DEFAULTS.app.identityTimeoutSeconds,
    ),
    pollIntervalMs: readNumber(
      envs,
      [['app', 'Kafka.Proxy.PollIntervalMs']],
      DEFAULTS.app.pollIntervalMs,
    ),
    maxRecordsPerPoll: readNumber(
      envs,
      [['app', 'Kafka.Proxy.MaxRecordsPerPoll']],
      DEFAULTS.app.maxRecordsPerPoll,
    ),
    proxyRequestTimeoutSeconds: readNumber(
      envs,
      [['app', 'Kafka.Proxy.RequestTimeoutSeconds']],
      DEFAULTS.app.proxyRequestTimeoutSeconds,
    ),
    batchSize: readNumber(envs, [['app', 'UploadSettings.BatchSize']], DEFAULTS.app.batchSize),
    maxRetries: readNumber(envs, [['app', 'UploadSettings.MaxRetries']], DEFAULTS.app.maxRetries),
    maxFileSizeBytes: readNumber(
      envs,
      [['app', 'UploadSettings.MaxFileSizeBytes']],
      DEFAULTS.app.maxFileSizeBytes,
    ),
    backgroundUploadEnabled: readBool(
      envs,
      [['app', 'BackgroundUpload.Enabled']],
      DEFAULTS.app.backgroundUploadEnabled,
    ),
    backgroundUploadIntervalMinutes: readNumber(
      envs,
      [['app', 'BackgroundUpload.IntervalMinutes']],
      DEFAULTS.app.backgroundUploadIntervalMinutes,
    ),
    backgroundUploadMaxFilesPerRun: readNumber(
      envs,
      [['app', 'BackgroundUpload.MaxFilesPerRun']],
      DEFAULTS.app.backgroundUploadMaxFilesPerRun,
    ),
  };

  const expoOrigins = [`http://localhost:${expoPort}`, `http://127.0.0.1:${expoPort}`];
  const existingCorsOrigins = firstValue(envs, [['proxy', 'CORS_ALLOWED_ORIGINS']], '');
  const existingCorsList = existingCorsOrigins.split(',').map((part) => part.trim());
  const corsDefault = existingCorsList.includes('*') || expoOrigins.some((origin) => existingCorsList.includes(origin))
    ? existingCorsOrigins
    : `http://localhost:${expoPort}`;

  const proxy = {
    host: DEFAULTS.proxy.host,
    port: normalizePort(proxyPort, DEFAULTS.proxy.port),
    corsOrigins: await choose(rl, 'CORS allowed origins', corsDefault, {
      validate: validateCorsOrigins,
    }),
    maxBodyBytes: readNumber(envs, [['proxy', 'MAX_BODY_BYTES']], DEFAULTS.proxy.maxBodyBytes),
    pollTimeoutMs: readNumber(
      envs,
      [['proxy', 'POLL_TIMEOUT_MS']],
      DEFAULTS.proxy.pollTimeoutMs,
    ),
  };

  const hostBind = await choose(
    rl,
    'Host bind address',
    firstValue(envs, [['host', 'HOST']], DEFAULTS.host.bind),
    { validate: validateNonEmpty },
  );
  const hostPort = await choose(
    rl,
    'Host port',
    firstValue(envs, [['host', 'PORT']], String(DEFAULTS.host.port)),
    { validate: validatePort },
  );
  const libraryRootRaw = await choose(
    rl,
    'Library root',
    firstValue(envs, [['host', 'LOCAL_ROOT_PATH']], DEFAULTS.host.libraryRoot),
    { validate: validateAbsolutePath },
  );
  const dbPathRaw = await choose(
    rl,
    'Host database path',
    firstValue(envs, [['host', 'DB_PATH']], DEFAULTS.host.dbPath),
    { validate: validateNonEmpty },
  );
  const tempDirRaw = await choose(
    rl,
    'Temporary directory (blank = host default)',
    firstValue(envs, [['host', 'TEMP_DIR']], DEFAULTS.host.tempDir),
  );

  // In --yes mode there are no prompts (and therefore no validation), so a
  // relative LOCAL_ROOT_PATH from an existing .env would make mkdir create a
  // relative directory. Anchor it to the user's home instead.
  let libraryRoot = path.normalize(expandPath(libraryRootRaw));
  if (!rl && !path.isAbsolute(libraryRoot)) {
    const relative = libraryRoot.replace(/^\.[\\/]?/, '').trim();
    libraryRoot = path.join(os.homedir(), relative === '' ? 'StashLibrary' : relative);
  }

  const host = {
    nodeEnv: firstValue(envs, [['host', 'NODE_ENV']], DEFAULTS.host.nodeEnv),
    bind: hostBind,
    port: normalizePort(hostPort, DEFAULTS.host.port),
    logLevel: firstValue(envs, [['host', 'LOG_LEVEL']], DEFAULTS.host.logLevel),
    libraryRoot: toForwardSlashes(libraryRoot),
    dbPath: toForwardSlashes(expandPath(dbPathRaw)),
    tempDir: tempDirRaw === '' ? '' : toForwardSlashes(expandPath(tempDirRaw)),
    worker: {
      enabled: readBool(envs, [['host', 'WORKER_ENABLED']], DEFAULTS.host.worker.enabled),
      concurrency: readNumber(
        envs,
        [['host', 'WORKER_CONCURRENCY']],
        DEFAULTS.host.worker.concurrency,
      ),
      hashThreads: readNumber(envs, [['host', 'WORKER_HASH_THREADS']], DEFAULTS.host.worker.hashThreads),
      imageConcurrency: readNumber(
        envs,
        [['host', 'IMAGE_CONCURRENCY']],
        DEFAULTS.host.worker.imageConcurrency,
      ),
      videoConcurrency: readNumber(
        envs,
        [['host', 'VIDEO_CONCURRENCY']],
        DEFAULTS.host.worker.videoConcurrency,
      ),
      jobMaxAttempts: readNumber(
        envs,
        [['host', 'JOB_MAX_ATTEMPTS']],
        DEFAULTS.host.worker.jobMaxAttempts,
      ),
      leaseSeconds: readNumber(envs, [['host', 'LEASE_SECONDS']], DEFAULTS.host.worker.leaseSeconds),
      hashTimeoutMs: readNumber(
        envs,
        [['host', 'HASH_WORKER_TIMEOUT_MS']],
        DEFAULTS.host.worker.hashTimeoutMs,
      ),
      mediaTimeoutMs: readNumber(
        envs,
        [['host', 'MEDIA_WORKER_TIMEOUT_MS']],
        DEFAULTS.host.worker.mediaTimeoutMs,
      ),
      heartbeatSeconds: readNumber(
        envs,
        [['host', 'HEARTBEAT_SECONDS']],
        DEFAULTS.host.worker.heartbeatSeconds,
      ),
      recoveryIntervalSeconds: readNumber(
        envs,
        [['host', 'RECOVERY_INTERVAL_SECONDS']],
        DEFAULTS.host.worker.recoveryIntervalSeconds,
      ),
      diskMinFreeBytes: readNumber(
        envs,
        [['host', 'DISK_MIN_FREE_BYTES']],
        DEFAULTS.host.worker.diskMinFreeBytes,
      ),
      tempRetentionHours: readNumber(
        envs,
        [['host', 'TEMP_RETENTION_HOURS']],
        DEFAULTS.host.worker.tempRetentionHours,
      ),
      retryBaseMs: readNumber(envs, [['host', 'RETRY_BASE_MS']], DEFAULTS.host.worker.retryBaseMs),
      retryMaxMs: readNumber(envs, [['host', 'RETRY_MAX_MS']], DEFAULTS.host.worker.retryMaxMs),
      deleteTempOnFailure: readBool(
        envs,
        [['host', 'DELETE_TEMP_ON_FAILURE']],
        DEFAULTS.host.worker.deleteTempOnFailure,
      ),
    },
    stageTimeouts: {
      download: readNumber(
        envs,
        [['host', 'STAGE_TIMEOUT_DOWNLOAD_MS']],
        DEFAULTS.host.stageTimeouts.download,
      ),
      verify: readNumber(
        envs,
        [['host', 'STAGE_TIMEOUT_VERIFY_MS']],
        DEFAULTS.host.stageTimeouts.verify,
      ),
      convertImage: readNumber(
        envs,
        [['host', 'STAGE_TIMEOUT_CONVERT_IMAGE_MS']],
        DEFAULTS.host.stageTimeouts.convertImage,
      ),
      convertVideo: readNumber(
        envs,
        [['host', 'STAGE_TIMEOUT_CONVERT_VIDEO_MS']],
        DEFAULTS.host.stageTimeouts.convertVideo,
      ),
      thumbnails: readNumber(
        envs,
        [['host', 'STAGE_TIMEOUT_THUMBNAILS_MS']],
        DEFAULTS.host.stageTimeouts.thumbnails,
      ),
      store: readNumber(
        envs,
        [['host', 'STAGE_TIMEOUT_STORE_MS']],
        DEFAULTS.host.stageTimeouts.store,
      ),
      respond: readNumber(
        envs,
        [['host', 'STAGE_TIMEOUT_RESPOND_MS']],
        DEFAULTS.host.stageTimeouts.respond,
      ),
      delete: readNumber(
        envs,
        [['host', 'STAGE_TIMEOUT_DELETE_MS']],
        DEFAULTS.host.stageTimeouts.delete,
      ),
    },
    media: {
      ffmpegPath: firstValue(envs, [['host', 'FFMPEG_PATH']], DEFAULTS.host.media.ffmpegPath),
      ffprobePath: firstValue(envs, [['host', 'FFPROBE_PATH']], DEFAULTS.host.media.ffprobePath),
      videoCodec: firstValue(
        envs,
        [['host', 'FFMPEG_VIDEO_CODEC']],
        DEFAULTS.host.media.videoCodec,
      ),
      crf: readNumber(envs, [['host', 'FFMPEG_CRF']], DEFAULTS.host.media.crf),
      preset: firstValue(envs, [['host', 'FFMPEG_PRESET']], DEFAULTS.host.media.preset),
      thumbnailQuality: readNumber(
        envs,
        [['host', 'THUMBNAIL_QUALITY']],
        DEFAULTS.host.media.thumbnailQuality,
      ),
      imageJpegQuality: readNumber(
        envs,
        [['host', 'IMAGE_JPEG_QUALITY']],
        DEFAULTS.host.media.imageJpegQuality,
      ),
      maxImagePixels: readNumber(
        envs,
        [['host', 'MAX_IMAGE_PIXELS']],
        DEFAULTS.host.media.maxImagePixels,
      ),
      heicWorkerEnabled: readBool(
        envs,
        [['host', 'HEIC_WORKER_ENABLED']],
        DEFAULTS.host.media.heicWorkerEnabled,
      ),
      rawDecoder: firstValue(envs, [['host', 'RAW_DECODER']], DEFAULTS.host.media.rawDecoder),
    },
    dashboard: {
      authEnabled: dashboardAuthEnabled,
      user: dashboardAuthEnabled ? dashboardUser : '',
      password: dashboardAuthEnabled ? dashboardPassword : '',
      metricsEnabled: readBool(
        envs,
        [['host', 'METRICS_ENABLED']],
        DEFAULTS.host.dashboard.metricsEnabled,
      ),
      componentCheckIntervalSeconds: readNumber(
        envs,
        [['host', 'COMPONENT_CHECK_INTERVAL_SECONDS']],
        DEFAULTS.host.dashboard.componentCheckIntervalSeconds,
      ),
    },
  };

  if (!rl) {
    if (s3.enabled && (!s3.bucket.trim() || !s3.accessKeyId.trim() || !s3.secretAccessKey.trim())) {
      s3.enabled = false;
      console.log(
        '\nWarning: S3 was disabled because S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY\n'
          + '  must be set when S3 is enabled. Non-interactive mode cannot prompt for them, and\n'
          + '  stash_host_node fails to boot with S3_ENABLED=true when they are missing.',
      );
    }

    if (kafka.enabled && !kafka.brokers.trim()) {
      kafka.enabled = false;
      console.log(
        '\nWarning: Kafka was disabled because KAFKA_BROKERS is empty and non-interactive\n'
          + '  mode cannot prompt for it.',
      );
    }
  }

  return { kafka, s3, jwt, mongo, proxy, host, expo, app };
}

function printWarnings(config) {
  if (!config.kafka.enabled) {
    console.log('\nWarning: Kafka is disabled. The proxy /api/messages route will fail; auth and health routes still work.');
  } else if (/^SASL/.test(config.kafka.securityProtocol) && (!config.kafka.username || !config.kafka.password)) {
    console.log('\nWarning: Kafka is enabled but username/password are empty; the proxy and host may not connect.');
  }

  if (!config.s3.enabled) {
    console.log('\nWarning: S3 is disabled. Uploads will not work end-to-end.');
  } else if (!config.s3.bucket || !config.s3.accessKeyId || !config.s3.secretAccessKey) {
    console.log('\nWarning: S3 is enabled but bucket/access key/secret are empty; uploads will fail.');
  }
}

function buildUpdates(config) {
  const proxyBaseUrl = `http://localhost:${config.proxy.port}`;
  const { kafka, s3 } = config;
  const kafkaSsl = /SSL$/i.test(kafka.securityProtocol) ? 'true' : 'false';

  const proxy = {
    KAFKA_BOOTSTRAP_SERVERS: kafka.brokers,
    KAFKA_SECURITY_PROTOCOL: kafka.securityProtocol,
    KAFKA_SASL_MECHANISM: kafka.saslMechanism,
    KAFKA_USERNAME: kafka.username,
    KAFKA_PASSWORD: kafka.password,
    KAFKA_CLIENT_ID: kafka.proxyClientId,
    KAFKA_CONNECTION_TIMEOUT_MS: String(kafka.connectionTimeoutMs),
    KAFKA_REQUEST_TIMEOUT_MS: String(kafka.requestTimeoutMs),
    KAFKA_CONSUMER_SESSION_TIMEOUT_MS: String(kafka.consumerSessionTimeoutMs),
    KAFKA_CONSUMER_HEARTBEAT_MS: String(kafka.consumerHeartbeatMs),
    MONGODB_URI: config.mongo.uri,
    MONGODB_DATABASE: config.mongo.database,
    JWT_SIGNING_KEY: config.jwt.signingKey,
    JWT_ISSUER: config.jwt.issuer,
    JWT_AUDIENCE: config.jwt.audience,
    AUTH_ACCESS_TOKEN_EXPIRY_MINUTES: String(config.jwt.accessTokenExpiryMinutes),
    AUTH_REFRESH_TOKEN_EXPIRY_DAYS: String(config.jwt.refreshTokenExpiryDays),
    AUTH_MAX_BODY_BYTES: String(config.jwt.authMaxBodyBytes),
    ALLOWED_PRODUCE_TOPICS: `${kafka.topics.request},${kafka.topics.dlq}`,
    ALLOWED_CONSUME_TOPICS: kafka.topics.response,
    CONSUMER_GROUP_PREFIX: kafka.consumerGroupPrefix,
    CORS_ALLOWED_ORIGINS: config.proxy.corsOrigins,
    MAX_BODY_BYTES: String(config.proxy.maxBodyBytes),
    POLL_TIMEOUT_MS: String(config.proxy.pollTimeoutMs),
    HOST: config.proxy.host,
    PORT: String(config.proxy.port),
  };

  const hostConfig = config.host;
  const host = {
    NODE_ENV: hostConfig.nodeEnv,
    HOST: hostConfig.bind,
    PORT: String(hostConfig.port),
    LOG_LEVEL: hostConfig.logLevel,
    DB_PATH: hostConfig.dbPath,
    LOCAL_ROOT_PATH: hostConfig.libraryRoot,
    TEMP_DIR: hostConfig.tempDir,
    KAFKA_ENABLED: String(kafka.enabled),
    KAFKA_BROKERS: kafka.brokers,
    KAFKA_CLIENT_ID: kafka.hostClientId,
    KAFKA_GROUP_ID: kafka.hostGroupId,
    KAFKA_REQUEST_TOPIC: kafka.topics.request,
    KAFKA_RESPONSE_TOPIC: kafka.topics.response,
    KAFKA_DLQ_TOPIC: kafka.topics.dlq,
    KAFKA_SSL: kafkaSsl,
    KAFKA_SASL_MECHANISM: kafka.saslMechanism,
    KAFKA_USERNAME: kafka.username,
    KAFKA_PASSWORD: kafka.password,
    KAFKA_FROM_BEGINNING: String(kafka.fromBeginning),
    KAFKA_PAUSE_HIGH_WATERMARK: String(kafka.pauseHighWatermark),
    KAFKA_RESUME_LOW_WATERMARK: String(kafka.resumeLowWatermark),
    KAFKA_COMMIT_TIMEOUT_MS: String(kafka.commitTimeoutMs),
    KAFKA_DLQ_MIRROR_FAILURES: String(kafka.dlqMirrorFailures),
    S3_ENABLED: String(s3.enabled),
    S3_REGION: s3.region,
    S3_BUCKET: s3.bucket,
    S3_ENDPOINT: s3.endpoint,
    S3_FORCE_PATH_STYLE: String(s3.forcePathStyle),
    S3_ACCESS_KEY_ID: s3.accessKeyId,
    S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
    S3_SESSION_TOKEN: s3.sessionToken,
    S3_PREFIX: s3.prefix,
    S3_REQUEST_TIMEOUT_MS: String(s3.requestTimeoutMs),
    JWT_SIGNING_KEY: config.jwt.signingKey,
    JWT_ISSUER: config.jwt.issuer,
    JWT_AUDIENCE: config.jwt.audience,
    JWT_CLOCK_TOLERANCE_SECONDS: String(config.jwt.clockToleranceSeconds),
    WORKER_ENABLED: String(hostConfig.worker.enabled),
    WORKER_CONCURRENCY: String(hostConfig.worker.concurrency),
    WORKER_HASH_THREADS: String(hostConfig.worker.hashThreads),
    IMAGE_CONCURRENCY: String(hostConfig.worker.imageConcurrency),
    VIDEO_CONCURRENCY: String(hostConfig.worker.videoConcurrency),
    JOB_MAX_ATTEMPTS: String(hostConfig.worker.jobMaxAttempts),
    LEASE_SECONDS: String(hostConfig.worker.leaseSeconds),
    HASH_WORKER_TIMEOUT_MS: String(hostConfig.worker.hashTimeoutMs),
    MEDIA_WORKER_TIMEOUT_MS: String(hostConfig.worker.mediaTimeoutMs),
    HEARTBEAT_SECONDS: String(hostConfig.worker.heartbeatSeconds),
    RECOVERY_INTERVAL_SECONDS: String(hostConfig.worker.recoveryIntervalSeconds),
    DISK_MIN_FREE_BYTES: String(hostConfig.worker.diskMinFreeBytes),
    TEMP_RETENTION_HOURS: String(hostConfig.worker.tempRetentionHours),
    STAGE_TIMEOUT_DOWNLOAD_MS: String(hostConfig.stageTimeouts.download),
    STAGE_TIMEOUT_VERIFY_MS: String(hostConfig.stageTimeouts.verify),
    STAGE_TIMEOUT_CONVERT_IMAGE_MS: String(hostConfig.stageTimeouts.convertImage),
    STAGE_TIMEOUT_CONVERT_VIDEO_MS: String(hostConfig.stageTimeouts.convertVideo),
    STAGE_TIMEOUT_THUMBNAILS_MS: String(hostConfig.stageTimeouts.thumbnails),
    STAGE_TIMEOUT_STORE_MS: String(hostConfig.stageTimeouts.store),
    STAGE_TIMEOUT_RESPOND_MS: String(hostConfig.stageTimeouts.respond),
    STAGE_TIMEOUT_DELETE_MS: String(hostConfig.stageTimeouts.delete),
    RETRY_BASE_MS: String(hostConfig.worker.retryBaseMs),
    RETRY_MAX_MS: String(hostConfig.worker.retryMaxMs),
    DELETE_TEMP_ON_FAILURE: String(hostConfig.worker.deleteTempOnFailure),
    FFMPEG_PATH: hostConfig.media.ffmpegPath,
    FFPROBE_PATH: hostConfig.media.ffprobePath,
    FFMPEG_VIDEO_CODEC: hostConfig.media.videoCodec,
    FFMPEG_CRF: String(hostConfig.media.crf),
    FFMPEG_PRESET: hostConfig.media.preset,
    THUMBNAIL_QUALITY: String(hostConfig.media.thumbnailQuality),
    IMAGE_JPEG_QUALITY: String(hostConfig.media.imageJpegQuality),
    MAX_IMAGE_PIXELS: String(hostConfig.media.maxImagePixels),
    HEIC_WORKER_ENABLED: String(hostConfig.media.heicWorkerEnabled),
    RAW_DECODER: hostConfig.media.rawDecoder,
    DASHBOARD_AUTH_ENABLED: String(hostConfig.dashboard.authEnabled),
    DASHBOARD_USER: hostConfig.dashboard.user,
    DASHBOARD_PASSWORD: hostConfig.dashboard.password,
    METRICS_ENABLED: String(hostConfig.dashboard.metricsEnabled),
    COMPONENT_CHECK_INTERVAL_SECONDS: String(hostConfig.dashboard.componentCheckIntervalSeconds),
  };

  const expo = {
    EXPO_DEV_PORT: String(config.expo.port),
    EXPO_PUBLIC_IDENTITY_API_BASE_URL: proxyBaseUrl,
    EXPO_PUBLIC_KAFKA_PROXY_BASE_URL: proxyBaseUrl,
    EXPO_PUBLIC_S3_BUCKET: s3.bucket,
    EXPO_PUBLIC_S3_REGION: s3.region,
    EXPO_PUBLIC_S3_ACCESS_KEY_ID: s3.accessKeyId,
    EXPO_PUBLIC_S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
    EXPO_PUBLIC_S3_SESSION_TOKEN: s3.sessionToken,
    EXPO_PUBLIC_S3_ENDPOINT: s3.endpoint,
    EXPO_PUBLIC_S3_PREFIX: s3.prefix,
    EXPO_PUBLIC_S3_FORCE_PATH_STYLE: String(s3.forcePathStyle),
    EXPO_PUBLIC_S3_PRESIGN_EXPIRY_SECONDS: String(s3.presignExpirySeconds),
    EXPO_PUBLIC_UPLOAD_MAX_CONCURRENT_BYTES: String(config.expo.uploadMaxConcurrentBytes),
    EXPO_PUBLIC_UPLOAD_MAX_HOST_RETRIES: String(config.expo.uploadMaxHostRetries),
  };

  return { proxy, host, expo };
}

function formatEnvValue(value) {
  const text = String(value);
  if (text === '') {
    return '';
  }

  if (!/[\s#"'\\]/.test(text)) {
    return text;
  }

  if (!text.includes("'")) {
    return `'${text}'`;
  }

  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function renderEnv(template, updates) {
  const applied = new Set();
  const lines = [];

  for (const line of template.split(/\r?\n/)) {
    const match = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match && Object.prototype.hasOwnProperty.call(updates, match[2])) {
      const key = match[2];
      lines.push(`${match[1]}${key}=${formatEnvValue(updates[key])}`);
      applied.add(key);
    } else {
      lines.push(line);
    }
  }

  const missing = Object.keys(updates).filter((key) => !applied.has(key));
  if (missing.length > 0) {
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('# added by setup');
    for (const key of missing) {
      lines.push(`${key}=${formatEnvValue(updates[key])}`);
    }
  }

  return `${lines.join('\n').replace(/\n*$/, '')}\n`;
}

function writeEnvFile(projectDir, content) {
  const envPath = path.join(projectDir, '.env');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let backupPath;

  if (existsSync(envPath)) {
    backupPath = path.join(projectDir, `.env.bak-${stamp}`);
    let counter = 1;
    while (existsSync(backupPath)) {
      backupPath = path.join(projectDir, `.env.bak-${stamp}-${counter}`);
      counter += 1;
    }
    copyFileSync(envPath, backupPath);
  }

  const tempPath = path.join(projectDir, `.env.tmp-${process.pid}`);
  let renamed = false;

  try {
    writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    try {
      renameSync(tempPath, envPath);
    } catch (error) {
      if (error.code === 'EEXIST' || error.code === 'EPERM') {
        try {
          unlinkSync(envPath);
          renameSync(tempPath, envPath);
        } catch (retryError) {
          if (backupPath && existsSync(backupPath)) {
            try {
              copyFileSync(backupPath, envPath);
            } catch {
              // Best effort restore; the backup file still exists.
            }
          }
          throw retryError;
        }
      } else {
        throw error;
      }
    }
    renamed = true;
  } catch (error) {
    throw new SetupError(
      `Failed to write ${envPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (!renamed && existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best effort cleanup; the original .env is restored or untouched.
      }
    }
  }

  return { envPath, backupPath };
}

function writeTextFile(filePath, content) {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  let renamed = false;

  try {
    writeFileSync(tempPath, content, 'utf8');
    try {
      renameSync(tempPath, filePath);
    } catch (error) {
      if (error.code === 'EEXIST' || error.code === 'EPERM') {
        unlinkSync(filePath);
        renameSync(tempPath, filePath);
      } else {
        throw error;
      }
    }
    renamed = true;
  } catch (error) {
    throw new SetupError(
      `Failed to write ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (!renamed && existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best effort cleanup; the original file is untouched.
      }
    }
  }
}

function prepareDirectories(config, dirs) {
  const created = [];

  try {
    if (!existsSync(config.host.libraryRoot)) {
      mkdirSync(config.host.libraryRoot, { recursive: true });
      created.push(config.host.libraryRoot);
    }

    const dbPath = path.isAbsolute(config.host.dbPath)
      ? config.host.dbPath
      : path.resolve(dirs.host, config.host.dbPath);
    const dbParent = path.dirname(dbPath);
    if (dbParent && !existsSync(dbParent)) {
      mkdirSync(dbParent, { recursive: true });
      created.push(dbParent);
    }
  } catch (error) {
    throw new SetupError(
      `Failed to create runtime directories: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return created;
}

function displayChange(key, value) {
  return isSecret(key) ? key : `${key}=${value}`;
}

function printDryRun(label, updates) {
  console.log(`  ${label}`);
  for (const [key, value] of Object.entries(updates)) {
    console.log(`    ${key}=${redact(key, value)}`);
  }
}

function printChanges(label, existingEnv, updates) {
  const added = [];
  const changed = [];
  let unchanged = 0;

  for (const [key, value] of Object.entries(updates)) {
    if (!Object.prototype.hasOwnProperty.call(existingEnv, key)) {
      added.push(key);
    } else if (existingEnv[key] !== value) {
      changed.push(key);
    } else {
      unchanged += 1;
    }
  }

  console.log(`  ${label}`);
  if (changed.length > 0) {
    console.log(`    changed:   ${changed.map((key) => displayChange(key, updates[key])).join(', ')}`);
  }
  if (added.length > 0) {
    console.log(`    added:     ${added.map((key) => displayChange(key, updates[key])).join(', ')}`);
  }
  if (changed.length === 0 && added.length === 0) {
    console.log('    unchanged.');
  } else if (unchanged > 0) {
    console.log(`    unchanged: ${unchanged} keys`);
  }
}

function parseJsonConfig(text, filePath) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SetupError(
      `Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SetupError(`Expected ${filePath} to contain a JSON object.`);
  }
  return parsed;
}

function flattenJsonConfig(value, prefix = '', flat = {}) {
  for (const [key, entry] of Object.entries(value)) {
    const dottedPath = prefix === '' ? key : `${prefix}.${key}`;
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      flattenJsonConfig(entry, dottedPath, flat);
    } else {
      flat[dottedPath] = entry;
    }
  }
  return flat;
}

function readAppConfigSettings(dirs) {
  const filePath = path.join(dirs.expo, EXPO_APP_CONFIG);
  const text = readText(filePath);
  if (!text.trim()) {
    return {};
  }
  return flattenJsonConfig(parseJsonConfig(text, filePath));
}

function assignConfigValue(target, dottedPath, value) {
  const keys = dottedPath.split('.');
  let cursor = target;
  for (const key of keys.slice(0, -1)) {
    if (cursor[key] === null || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
}

// Every value the app reads from src/config/appconfig.json, including the S3
// credentials, so the app works with or without an EXPO_PUBLIC_* overlay.
function appConfigUpdates(config) {
  const proxyBaseUrl = `http://localhost:${config.proxy.port}`;
  const { kafka, s3, expo, app } = config;
  const updates = {
    IdentityApiBaseUrl: proxyBaseUrl,
    IdentityApiTimeoutSeconds: app.identityTimeoutSeconds,
    'Kafka.TopicUploadRequest': kafka.topics.request,
    'Kafka.TopicUploadResponse': kafka.topics.response,
    'Kafka.TopicDeadLetter': kafka.topics.dlq,
    'Kafka.Proxy.BaseUrl': proxyBaseUrl,
    'Kafka.Proxy.PollIntervalMs': app.pollIntervalMs,
    'Kafka.Proxy.PollTimeoutMs': config.proxy.pollTimeoutMs,
    'Kafka.Proxy.MaxRecordsPerPoll': app.maxRecordsPerPoll,
    'Kafka.Proxy.RequestTimeoutSeconds': app.proxyRequestTimeoutSeconds,
    'Storage.Provider': 'S3',
    'UploadSettings.BatchSize': app.batchSize,
    'UploadSettings.MaxRetries': app.maxRetries,
    'UploadSettings.MaxHostRetries': expo.uploadMaxHostRetries,
    'UploadSettings.MaxFileSizeBytes': app.maxFileSizeBytes,
    'UploadSettings.MaxConcurrentBytes': expo.uploadMaxConcurrentBytes,
    'BackgroundUpload.Enabled': app.backgroundUploadEnabled,
    'BackgroundUpload.IntervalMinutes': app.backgroundUploadIntervalMinutes,
    'BackgroundUpload.MaxFilesPerRun': app.backgroundUploadMaxFilesPerRun,
  };

  if (s3.enabled) {
    updates['Storage.S3.Bucket'] = s3.bucket;
    updates['Storage.S3.Region'] = s3.region;
    updates['Storage.S3.AccessKeyId'] = s3.accessKeyId;
    updates['Storage.S3.SecretAccessKey'] = s3.secretAccessKey;
    updates['Storage.S3.SessionToken'] = s3.sessionToken;
    updates['Storage.S3.Endpoint'] = s3.endpoint;
    updates['Storage.S3.ForcePathStyle'] = s3.forcePathStyle;
    updates['Storage.S3.Prefix'] = s3.prefix;
    updates['Storage.S3.PresignExpirySeconds'] = s3.presignExpirySeconds;
  }

  return updates;
}

function writeAppConfig(config, dirs, options) {
  const filePath = path.join(dirs.expo, EXPO_APP_CONFIG);
  const label = toDisplayPath(filePath);
  const original = readText(filePath);
  if (!original) {
    throw new SetupError(`Missing React Native app config: ${filePath}`);
  }

  const updates = appConfigUpdates(config);

  if (options.dryRun) {
    printDryRun(label, updates);
    return null;
  }

  const existing = flattenJsonConfig(parseJsonConfig(original, filePath));
  const parsed = parseJsonConfig(original, filePath);
  for (const [dottedPath, value] of Object.entries(updates)) {
    assignConfigValue(parsed, dottedPath, value);
  }

  const rendered = `${JSON.stringify(parsed, null, 2)}\n`;
  if (rendered !== original) {
    writeTextFile(filePath, rendered);
  }
  printChanges(label, existing, updates);
  return { filePath };
}

function printSummary(written, createdDirs, dryRun, runMode = false, appConfigWrites = []) {
  console.log(`\n${runMode ? 'Environment summary' : 'Summary'}`);
  if (dryRun) {
    console.log('  Dry run: no .env files or app config files were written and no directories were created.');
  } else {
    for (const item of written) {
      const relative = path.relative(ROOT, item.envPath).replace(/\\/g, '/');
      const backup = item.backupPath ? ` (backup ${path.basename(item.backupPath)})` : '';
      console.log(`  wrote ${relative}${backup}`);
    }
    if (written.length === 0) {
      console.log('  No .env files written.');
    }
    for (const item of appConfigWrites) {
      console.log(`  synced ${toDisplayPath(item.filePath)}`);
    }
  }

  for (const dir of createdDirs) {
    console.log(`  created ${dir}`);
  }
}

function toDisplayPath(target) {
  const relative = path.relative(ROOT, target);
  if (!relative) {
    return '.';
  }
  return (relative.startsWith('..') ? target : relative).replace(/\\/g, '/');
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function selectedProjects(options) {
  return PROJECT_ORDER.filter((key) => options.only.has(key));
}

function selectedServicePorts(config, options) {
  const services = [];
  if (options.only.has('proxy')) {
    services.push({ name: 'proxy', port: config.proxy.port });
  }
  if (options.only.has('host')) {
    services.push({ name: 'host', port: config.host.port });
  }
  if (options.only.has('expo')) {
    services.push({ name: 'expo', port: config.expo.port });
  }
  return services;
}

function assertNoPortCollisions(config, options) {
  const services = selectedServicePorts(config, options);
  for (let i = 0; i < services.length; i += 1) {
    for (let j = i + 1; j < services.length; j += 1) {
      if (services[i].port === services[j].port) {
        throw new SetupError(
          `Port ${services[i].port} is assigned to both ${services[i].name} and ${services[j].name}. `
            + 'Choose different ports before continuing.',
        );
      }
    }
  }
}

async function assertPortsFree(config, options) {
  for (const service of selectedServicePorts(config, options)) {
    if (await checkTcp('127.0.0.1', service.port, 400)) {
      throw new SetupError(
        `Port ${service.port} for ${service.name} is already in use. `
          + 'Stop the other process listening on that port or choose another port.',
      );
    }
  }
}

function parseMongoHostPort(uri) {
  const srv = /^mongodb\+srv:\/\//i.test(uri);
  const rest = uri.replace(/^mongodb(\+srv)?:\/\//i, '');
  const authority = rest.split(/[/?#]/)[0] ?? '';
  const hostPort = authority.includes('@')
    ? authority.slice(authority.lastIndexOf('@') + 1)
    : authority;
  const first = hostPort.split(',')[0]?.trim() ?? '';

  if (srv) {
    return { srv, host: first, port: 27017 };
  }

  if (first.startsWith('[')) {
    const close = first.indexOf(']');
    const host = close === -1 ? first.slice(1) : first.slice(1, close);
    const after = close === -1 ? '' : first.slice(close + 1);
    const parsed = after.startsWith(':') ? Number(after.slice(1)) : 27017;
    return { srv, host, port: Number.isInteger(parsed) && parsed > 0 ? parsed : 27017 };
  }

  const colon = first.lastIndexOf(':');
  if (colon === -1) {
    return { srv, host: first, port: 27017 };
  }

  const parsed = Number(first.slice(colon + 1));
  return {
    srv,
    host: first.slice(0, colon),
    port: Number.isInteger(parsed) && parsed > 0 ? parsed : 27017,
  };
}

function isLocalMongoHost(host) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase());
}

function checkTcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host, port });

    const finish = (reachable) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitForTcp(host, port, timeoutMs = 15000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkTcp(host, port, 1000)) {
      return true;
    }
    await delay(intervalMs);
  }
  return false;
}

function dockerAvailable() {
  const result = spawnSync('docker', ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function dockerContainerExists() {
  const result = spawnSync(
    'docker',
    ['ps', '-a', '--filter', 'name=^/stash-mongo$', '--format', '{{.Names}}'],
    { encoding: 'utf8' },
  );
  if (result.error || result.status !== 0) {
    return false;
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .includes('stash-mongo');
}

async function startMongoContainer(host, port) {
  console.log('  Docker detected; preparing container "stash-mongo"...');

  let outcome;
  if (dockerContainerExists()) {
    console.log('  Starting existing container "stash-mongo"...');
    outcome = spawnSync('docker', ['start', 'stash-mongo'], { stdio: 'inherit' });
  } else {
    console.log('  Creating container "stash-mongo" (mongo:7)...');
    outcome = spawnSync(
      'docker',
      ['run', '-d', '--name', 'stash-mongo', '-p', `127.0.0.1:${port}:27017`, 'mongo:7'],
      { stdio: 'inherit' },
    );
  }

  if (outcome.error) {
    throw new Error(`docker command failed: ${outcome.error.message}`);
  }
  if (outcome.status !== 0) {
    throw new Error(`docker exited with code ${outcome.status}.`);
  }

  const ready = await waitForTcp(host, port, 15000, 1000);
  if (ready) {
    console.log(`  MongoDB is reachable at ${host}:${port}.`);
  } else {
    console.log(`  MongoDB is not reachable yet at ${host}:${port}; it may still be starting. Continuing.`);
  }
}

async function ensureMongo(config, options, rl) {
  const { srv, host, port } = parseMongoHostPort(config.mongo.uri);
  const target = `${host}:${port}`;
  const local = isLocalMongoHost(host);
  const probeHost = local && host.toLowerCase() === 'localhost' ? '127.0.0.1' : host;

  console.log('\nMongoDB readiness');
  if (!host) {
    console.log('  Warning: could not determine a MongoDB host from the URI; skipping the readiness check.');
    return;
  }

  if (await checkTcp(probeHost, port)) {
    console.log(
      options.dryRun
        ? `  reachable at ${target}; dry run would take no MongoDB action.`
        : `  reachable at ${target}`,
    );
    return;
  }

  if (srv) {
    console.log(`  Warning: MongoDB SRV host ${target} is not reachable; SRV/TLS endpoints often reject raw TCP. Continuing.`);
    return;
  }

  if (!local) {
    console.log(`  Warning: MongoDB at ${target} is not a local host; Docker cannot fix a remote or unreachable database. Continuing.`);
    return;
  }

  const plannedAction = `start Docker container "stash-mongo" (mongo:7) mapping 127.0.0.1:${port}:27017`;

  if (options.dryRun) {
    if (options.yes) {
      console.log(
        `  not reachable at ${target}; a non-interactive run would not start Docker. `
          + `Start MongoDB yourself (loopback mapping would be 127.0.0.1:${port}:27017).`,
      );
    } else {
      console.log(`  not reachable at ${target}; dry run would ${plannedAction}.`);
    }
    return;
  }

  if (options.yes) {
    console.log(`  Warning: MongoDB is not reachable at ${target}. Non-interactive mode does not start Docker; start MongoDB yourself.`);
    return;
  }

  let shouldStart;
  try {
    shouldStart = await promptBool(rl, `MongoDB is not reachable at ${target}. Start a Docker container?`, true);
  } catch (error) {
    console.log(`  Warning: ${error instanceof Error ? error.message : String(error)} Continuing without MongoDB.`);
    return;
  }

  if (!shouldStart) {
    console.log('  Continuing without MongoDB.');
    return;
  }

  if (!dockerAvailable()) {
    console.log('  Warning: docker was not found on PATH; start MongoDB yourself. Continuing.');
    return;
  }

  try {
    await startMongoContainer(probeHost, port);
  } catch (error) {
    console.log(`  Warning: ${error instanceof Error ? error.message : String(error)} Continuing without MongoDB.`);
  }
}

function runCommand(label, command, args, cwd, options = {}) {
  const printable = `${command} ${args.join(' ')}`.trim();
  console.log(`\n== ${label} ==`);
  console.log(`  $ ${printable}`);
  console.log(`  cwd: ${toDisplayPath(cwd)}`);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        stdio: 'inherit',
        shell: true,
        env: { ...process.env },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reject(new SetupError(`${label} could not start (${printable}): ${message}`));
      return;
    }

    child.once('error', (error) => {
      reject(new SetupError(`${label} could not start (${printable}): ${error.message}`));
    });

    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve(0);
        return;
      }
      const reason = code === null ? `signal ${signal}` : `exit code ${code}`;
      const hint = options.hint ? `\n  ${options.hint}` : '';
      reject(
        new SetupError(
          `${label} failed (${reason}): ${printable}\n  Project: ${toDisplayPath(cwd)}${hint}`,
        ),
      );
    });
  });
}

async function runInstalls(dirs, options) {
  for (const key of selectedProjects(options)) {
    await runCommand(`Install ${PROJECT_DIRS[key]}`, 'npm', INSTALL_ARGS, dirs[key], {
      hint: 'Fix the install error above, or re-run with --skip-install to bypass installation.',
    });
  }
}

async function runBuilds(dirs, options) {
  for (const key of selectedProjects(options)) {
    const { command, args } = BUILD_COMMANDS[key];
    const label = key === 'host' ? `Build ${PROJECT_DIRS[key]}` : `Typecheck ${PROJECT_DIRS[key]}`;
    await runCommand(label, command, args, dirs[key], {
      hint: 'Fix the errors above, or re-run with --skip-build to bypass build/validation checks.',
    });
  }
}

function expoArgs(config, options) {
  const args = ['expo', 'start'];
  if (options.platform === 'web') {
    args.push('--web');
  } else if (options.platform === 'android') {
    args.push('--android');
  } else if (options.platform === 'ios') {
    args.push('--ios');
  }
  args.push('--port', String(config.expo.port));
  return args;
}

function buildServiceSpecs(config, dirs, options) {
  const specs = [];

  if (options.only.has('proxy')) {
    specs.push({
      name: 'proxy',
      color: SERVICE_COLORS.proxy,
      command: process.execPath,
      args: ['--experimental-strip-types', 'scripts/local-server.ts'],
      cwd: dirs.proxy,
      shell: false,
    });
  }

  if (options.only.has('host')) {
    const distEntry = path.join(dirs.host, 'dist', 'server', 'index.js');
    if (existsSync(distEntry)) {
      specs.push({
        name: 'host',
        color: SERVICE_COLORS.host,
        command: 'npm',
        args: ['start'],
        cwd: dirs.host,
      });
    } else {
      specs.push({
        name: 'host',
        color: SERVICE_COLORS.host,
        command: 'npm',
        args: ['run', 'dev'],
        cwd: dirs.host,
        warn: 'host build not found at dist/server/index.js; starting `npm run dev` instead of `npm start`.',
      });
    }
  }

  if (options.only.has('expo')) {
    specs.push({
      name: 'expo',
      color: SERVICE_COLORS.expo,
      command: 'npx',
      args: expoArgs(config, options),
      cwd: dirs.expo,
    });
  }

  return specs;
}

function printCommandPlan(label, command, args, cwd) {
  const printable = `${command} ${args.join(' ')}`.trim();
  console.log(`    ${label ? `${label}: ` : ''}${printable}`);
  console.log(`      cwd: ${toDisplayPath(cwd)}`);
}

function printPlan(config, dirs, options) {
  console.log('\nPlanned commands (dry run)');

  console.log('\n  Dependency installs');
  if (options.skipInstall) {
    console.log('    skipped (--skip-install)');
  } else {
    for (const key of selectedProjects(options)) {
      printCommandPlan(PROJECT_DIRS[key], 'npm', INSTALL_ARGS, dirs[key]);
    }
  }

  console.log('\n  Build checks');
  if (options.skipBuild) {
    console.log('    skipped (--skip-build)');
  } else {
    for (const key of selectedProjects(options)) {
      const { command, args } = BUILD_COMMANDS[key];
      printCommandPlan(PROJECT_DIRS[key], command, args, dirs[key]);
    }
  }

  console.log('\n  Services');
  if (options.skipRun) {
    console.log('    skipped (--skip-run)');
  } else {
    for (const spec of buildServiceSpecs(config, dirs, options)) {
      printCommandPlan(spec.name, spec.command, spec.args, spec.cwd);
      if (spec.warn) {
        console.log(`      warning: ${spec.warn}`);
      }
    }
  }

  console.log('\n  Service URLs');
  if (options.skipRun) {
    console.log('    skipped (--skip-run)');
  } else {
    if (options.only.has('proxy')) {
      console.log(`    Identity + proxy: http://localhost:${config.proxy.port}`);
    }
    if (options.only.has('host')) {
      console.log(`    Host dashboard: http://${healthHostForBind(config.host.bind)}:${config.host.port}/`);
      console.log(`    Host health: http://${healthHostForBind(config.host.bind)}:${config.host.port}/api/health`);
    }
    if (options.only.has('expo')) {
      console.log(`    Expo (${options.platform}): http://localhost:${config.expo.port}`);
    }
  }

  console.log('\n  Port checks');
  if (options.skipRun) {
    console.log('    skipped (--skip-run)');
  } else {
    for (const service of selectedServicePorts(config, options)) {
      console.log(`    ${service.name}: check 127.0.0.1:${service.port} is free`);
    }
  }
}

const runningServices = [];
let shuttingDown = false;

function killTree(child) {
  if (!child || !child.pid) {
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill();
      } catch {
        // Best effort; the child may have already exited.
      }
    }
    setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Best effort; the process group may have already exited.
      }
    }, SHUTDOWN_KILL_DELAY_MS);
  }
}

function stopAll() {
  shuttingDown = true;
  for (const child of runningServices) {
    killTree(child);
  }
}

function pipeLines(stream, prefix, target) {
  let buffer = '';

  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      target.write(`${prefix}${line}\n`);
      newline = buffer.indexOf('\n');
    }
  });

  stream.on('end', () => {
    if (buffer !== '') {
      target.write(`${prefix}${buffer.replace(/\r$/, '')}\n`);
    }
  });
}

function startService(name, colorCode, command, args, cwd, options = {}) {
  const printable = `${command} ${args.join(' ')}`.trim();
  console.log(`\nStarting ${name}: ${printable}`);
  console.log(`  cwd: ${toDisplayPath(cwd)}`);

  const child = spawn(command, args, {
    cwd,
    shell: options.shell ?? true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildChildEnv(cwd),
  });

  child.displayName = name;
  const prefix = process.env.NO_COLOR
    ? `[${name}] `
    : `\x1b[${colorCode}m[${name}]\x1b[0m `;

  pipeLines(child.stdout, prefix, process.stdout);
  pipeLines(child.stderr, prefix, process.stderr);

  child.once('error', (error) => {
    console.error(`${prefix}failed to start: ${error.message}`);
  });

  child.once('exit', async (code, signal) => {
    if (shuttingDown) {
      return;
    }
    const reason = code === null ? `signal ${signal}` : `exit code ${code}`;
    console.error(`\n${prefix}exited unexpectedly (${reason}). Stopping remaining services...`);
    stopAll();
    process.exitCode = Number.isInteger(code) ? code : 1;
    // Wait past the SIGKILL escalation so teardown can finish before exiting.
    await delay(SHUTDOWN_GRACE_MS);
    process.exit();
  });

  runningServices.push(child);
  return child;
}

function installSignalHandlers() {
  const stop = async (signal) => {
    if (shuttingDown) {
      return;
    }
    console.log(`\nReceived ${signal}; stopping services...`);
    stopAll();
    await delay(SHUTDOWN_GRACE_MS);
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void stop('SIGINT');
  });
  process.on('SIGTERM', () => {
    void stop('SIGTERM');
  });
}

async function waitForUrl(url, timeoutMs = HEALTH_TIMEOUT_MS, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      const detail = 'HTTP ' + response.status;
      return { ok: response.ok, detail };
    } catch {
      // Not ready yet; retry until the deadline.
    }
    await delay(intervalMs);
  }
  return { ok: false, detail: 'no response' };
}

async function waitForExpo(url, port, timeoutMs = HEALTH_TIMEOUT_MS, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return { ok: response.ok, detail: 'HTTP ' + response.status };
    } catch {
      if (await checkTcp('127.0.0.1', port, 750)) {
        return { ok: true, detail: 'TCP' };
      }
    }
    await delay(intervalMs);
  }
  return { ok: false, detail: 'no response' };
}

function healthHostForBind(bind) {
  if (!bind || bind === '0.0.0.0' || bind === '::' || bind === '[::]') {
    return '127.0.0.1';
  }
  if (bind.startsWith('[') && bind.endsWith(']')) {
    return bind;
  }
  if (net.isIPv6(bind)) {
    return '[' + bind + ']';
  }
  return bind;
}
function healthTargets(config, options) {
  const targets = [];
  if (options.only.has('proxy')) {
    targets.push({
      label: 'Identity + proxy',
      url: `http://127.0.0.1:${config.proxy.port}/api/health`,
    });
  }
  if (options.only.has('host')) {
    targets.push({
      label: 'Host health',
      url: 'http://' + healthHostForBind(config.host.bind) + ':' + config.host.port + '/api/health',
    });
  }
  if (options.only.has('expo')) {
    targets.push({
      label: `Expo (${options.platform})`,
      url: `http://127.0.0.1:${config.expo.port}/`,
      kind: 'expo',
    });
  }
  return targets;
}

async function runHealthChecks(config, options) {
  const targets = healthTargets(config, options);
  if (targets.length === 0) {
    return;
  }

  console.log('\nWaiting for health checks...');
  const results = await Promise.all(
    targets.map(async (target) => {
      const result = target.kind === 'expo'
        ? await waitForExpo(target.url, config.expo.port)
        : await waitForUrl(target.url);
      return { ...target, ...result };
    }),
  );

  console.log('\nHealth');
  for (const result of results) {
    const status = result.ok
      ? 'ok'
      : result.detail.startsWith('HTTP ')
        ? 'unhealthy (' + result.detail + ')'
        : 'timeout (' + result.detail + ')';
    console.log('  ' + status + ' ' + result.label + ': ' + result.url);
  }

  for (const result of results.filter((item) => !item.ok)) {
    console.log('\n  Warning: ' + result.label + ' is not healthy (' + result.detail + '): ' + result.url);
    console.log('  The service may be running but unhealthy; check its logs above.');
  }
}

function printRunSummary(config, options, written, { started, appConfigWrites = [] }) {
  console.log('\nDone');
  console.log('  Configuration files:');
  for (const item of written) {
    const backup = item.backupPath ? ` (backup ${path.basename(item.backupPath)})` : '';
    console.log(`    ${toDisplayPath(item.envPath)}${backup}`);
  }
  for (const item of appConfigWrites) {
    console.log(`    ${toDisplayPath(item.filePath)}`);
  }
  if (written.length === 0 && appConfigWrites.length === 0) {
    console.log('    (none written)');
  }

  if (options.skipRun) {
    console.log('\n  Services were not started (--skip-run).');
  } else if (!started) {
    console.log('\n  No services were started.');
  } else {
    console.log('\n  URLs:');
    if (options.only.has('proxy')) {
      console.log(`    Identity + proxy: http://localhost:${config.proxy.port}`);
    }
    if (options.only.has('host')) {
      console.log(`    Host dashboard:   http://${healthHostForBind(config.host.bind)}:${config.host.port}/`);
    }
    if (options.only.has('expo')) {
      console.log(`    Expo (${options.platform}): http://localhost:${config.expo.port}`);
    }
    console.log('\n  Press Ctrl+C to stop.');
  }

  console.log('\n  Re-run without re-installing or re-building:');
  console.log('    node scripts/setup-and-run.mjs --skip-install --skip-build');
}

async function main() {
  assertNodeVersion();

  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    printHelp();
    return;
  }

  const options = parseArgs(rawArgs);
  const dirs = resolveProjectDirs();

  if (!options.yes && !process.stdin.isTTY) {
    throw new SetupError(
      'Interactive prompts require a TTY. Re-run with --yes to use existing values and documented defaults.',
    );
  }

  const envs = readExistingEnvs(dirs);
  const appConfigDefaults = readAppConfigSettings(dirs);
  if (Object.keys(appConfigDefaults).length > 0) {
    envs.app = appConfigDefaults;
  }

  let rl;
  let config;
  const written = [];
  const appConfigWrites = [];
  let createdDirs = [];

  try {
    if (!options.yes) {
      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    }

    config = await collectConfig(rl, envs);

    assertNoPortCollisions(config, options);

    printWarnings(config);

    const updatesByProject = buildUpdates(config);
    createdDirs = options.dryRun || !options.only.has('host')
      ? []
      : prepareDirectories(config, dirs);

    console.log(options.dryRun ? '\nEnvironment preview (dry run)' : '\nEnvironment files');

    for (const project of selectedProjects(options)) {
      const templatePath = path.join(dirs[project], '.env.example');
      if (!existsSync(templatePath)) {
        throw new SetupError(`Missing .env.example template: ${templatePath}`);
      }

      const updates = updatesByProject[project];
      const envLabel = `${PROJECT_DIRS[project]}/.env`;

      if (options.dryRun) {
        printDryRun(envLabel, updates);
        if (project === 'expo') {
          writeAppConfig(config, dirs, options);
        }
        continue;
      }

      const existingEnv = parseDotenv(readText(path.join(dirs[project], '.env')));
      const content = renderEnv(readFileSync(templatePath, 'utf8'), updates);
      written.push(writeEnvFile(dirs[project], content));
      printChanges(envLabel, existingEnv, updates);

      if (project === 'expo') {
        const appConfigWrite = writeAppConfig(config, dirs, options);
        if (appConfigWrite) {
          appConfigWrites.push(appConfigWrite);
        }
      }
    }

    printSummary(written, createdDirs, options.dryRun, !options.dryRun, appConfigWrites);

    if (options.only.has('proxy')) {
      await ensureMongo(config, options, rl);
    }

    if (options.dryRun) {
      printPlan(config, dirs, options);
      console.log('\nDry run complete: nothing was written, installed, built, or started.');
      return;
    }
  } finally {
    if (rl) {
      rl.close();
    }
  }

  if (!options.skipInstall) {
    await runInstalls(dirs, options);
  } else {
    console.log('\nSkipping dependency installation (--skip-install).');
  }

  if (!options.skipBuild) {
    await runBuilds(dirs, options);
  } else {
    console.log('\nSkipping build/validation checks (--skip-build).');
  }

  if (options.skipRun) {
    console.log('\nSkipping service startup (--skip-run).');
    printRunSummary(config, options, written, { started: false, appConfigWrites });
    return;
  }

  await assertPortsFree(config, options);

  const specs = buildServiceSpecs(config, dirs, options);
  if (specs.length === 0) {
    console.log('\nNo services selected; nothing to start.');
    printRunSummary(config, options, written, { started: false, appConfigWrites });
    return;
  }

  installSignalHandlers();

  let started = 0;
  for (const spec of specs) {
    if (spec.warn) {
      console.log(`\nWarning: ${spec.warn}`);
    }
    startService(spec.name, spec.color, spec.command, spec.args, spec.cwd, { shell: spec.shell ?? true });
    started += 1;
    if (started < specs.length) {
      await delay(800);
    }
  }

  await runHealthChecks(config, options);
  printRunSummary(config, options, written, { started: true, appConfigWrites });
}

main().catch(async (error) => {
  if (runningServices.length > 0) {
    stopAll();
    // Wait past the SIGKILL escalation so teardown can finish before exiting.
    await delay(SHUTDOWN_GRACE_MS);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`setup-and-run: ${message}`);
  process.exitCode = 1;
});


