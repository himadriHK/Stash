/**
 * Typed configuration from Vercel environment variables.
 *
 * Secrets live only in the deployment's environment (KAFKA_PASSWORD,
 * JWT_SIGNING_KEY); nothing sensitive is ever returned to the app.
 */
import { HttpError, clampInt, parseCorsOrigins } from './http.ts';
import { parseTopicList } from './topics.ts';

export type SecurityProtocol = 'PLAINTEXT' | 'SSL' | 'SASL_PLAINTEXT' | 'SASL_SSL';
export type SaslMechanism = 'plain' | 'scram-sha-256' | 'scram-sha-512';

const SECURITY_PROTOCOLS = new Set<SecurityProtocol>([
  'PLAINTEXT',
  'SSL',
  'SASL_PLAINTEXT',
  'SASL_SSL',
]);
const SASL_MECHANISMS = new Set<SaslMechanism>(['plain', 'scram-sha-256', 'scram-sha-512']);

export interface AppConfig {
  brokers: string[];
  securityProtocol: SecurityProtocol;
  saslMechanism: SaslMechanism;
  saslUsername: string;
  saslPassword: string;
  clientId: string;
  connectionTimeoutMs: number;
  requestTimeoutMs: number;
  consumerSessionTimeoutMs: number;
  consumerHeartbeatMs: number;
  jwtSigningKey: string;
  jwtIssuer: string;
  jwtAudience: string;
  produceTopics: Set<string>;
  consumeTopics: Set<string>;
  consumerGroupPrefix: string;
  corsOrigins: '*' | string[];
  maxBodyBytes: number;
  pollTimeoutMs: number;
}

function misconfigured(name: string): HttpError {
  return new HttpError(500, 'proxy_misconfigured', `${name} is not configured correctly.`);
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const brokers = (env.KAFKA_BOOTSTRAP_SERVERS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (brokers.length === 0) {
    throw misconfigured('KAFKA_BOOTSTRAP_SERVERS');
  }

  const protocolRaw = (env.KAFKA_SECURITY_PROTOCOL ?? 'SASL_SSL').trim().toUpperCase();
  if (!SECURITY_PROTOCOLS.has(protocolRaw as SecurityProtocol)) {
    throw misconfigured('KAFKA_SECURITY_PROTOCOL');
  }
  const securityProtocol = protocolRaw as SecurityProtocol;

  const mechanismRaw = (env.KAFKA_SASL_MECHANISM ?? 'scram-sha-256').trim().toLowerCase();
  if (!SASL_MECHANISMS.has(mechanismRaw as SaslMechanism)) {
    throw misconfigured('KAFKA_SASL_MECHANISM');
  }

  const saslUsername = (env.KAFKA_USERNAME ?? '').trim();
  const saslPassword = env.KAFKA_PASSWORD ?? '';
  if (securityProtocol.startsWith('SASL') && (!saslUsername || !saslPassword)) {
    throw misconfigured('KAFKA_USERNAME / KAFKA_PASSWORD');
  }

  const jwtSigningKey = env.JWT_SIGNING_KEY ?? '';
  if (!jwtSigningKey) {
    throw misconfigured('JWT_SIGNING_KEY');
  }

  return {
    brokers,
    securityProtocol,
    saslMechanism: mechanismRaw as SaslMechanism,
    saslUsername,
    saslPassword,
    clientId: (env.KAFKA_CLIENT_ID ?? 'stash-kafka-proxy-vercel').trim(),
    connectionTimeoutMs: clampInt(env.KAFKA_CONNECTION_TIMEOUT_MS, 10_000, 1_000, 60_000),
    requestTimeoutMs: clampInt(env.KAFKA_REQUEST_TIMEOUT_MS, 20_000, 1_000, 120_000),
    consumerSessionTimeoutMs: clampInt(
      env.KAFKA_CONSUMER_SESSION_TIMEOUT_MS,
      15_000,
      6_000,
      300_000,
    ),
    consumerHeartbeatMs: clampInt(env.KAFKA_CONSUMER_HEARTBEAT_MS, 3_000, 500, 30_000),
    jwtSigningKey,
    jwtIssuer: (env.JWT_ISSUER ?? 'stash-auth').trim(),
    jwtAudience: (env.JWT_AUDIENCE ?? 'stash-app').trim(),
    produceTopics: parseTopicList(env.ALLOWED_PRODUCE_TOPICS, [
      'stash.upload.request',
      'stash.dlq',
    ]),
    consumeTopics: parseTopicList(env.ALLOWED_CONSUME_TOPICS, ['stash.upload.response']),
    consumerGroupPrefix: (env.CONSUMER_GROUP_PREFIX ?? 'stash-mobile').trim() || 'stash-mobile',
    corsOrigins: parseCorsOrigins(env.CORS_ALLOWED_ORIGINS),
    maxBodyBytes: clampInt(env.MAX_BODY_BYTES, 1_048_576, 1_024, 8_388_608),
    pollTimeoutMs: clampInt(env.POLL_TIMEOUT_MS, 8_000, 0, 30_000),
  };
}

