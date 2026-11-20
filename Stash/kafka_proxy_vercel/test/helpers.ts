/** Shared test helpers: env, token minting and a fake Kafka gateway. */
import { createHmac } from 'node:crypto';

import type { KafkaGateway, PollOptions } from '../src/gateway.ts';
import type { KafkaRecord, ProduceInput } from '../src/records.ts';

export const TEST_SIGNING_KEY = 'test-signing-key-with-at-least-32-characters';

export function signToken(
  claims: Record<string, unknown>,
  key: string = TEST_SIGNING_KEY,
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: 'user-1',
    deviceId: 'device-1',
    iss: 'stash-auth',
    aud: 'stash-app',
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  };
}

export function applyTestEnv(overrides: Record<string, string | undefined> = {}): void {
  const values: Record<string, string> = {
    KAFKA_BOOTSTRAP_SERVERS: 'broker.test:9092',
    KAFKA_SECURITY_PROTOCOL: 'SASL_SSL',
    KAFKA_SASL_MECHANISM: 'scram-sha-256',
    KAFKA_USERNAME: 'test-user',
    KAFKA_PASSWORD: 'test-password',
    JWT_SIGNING_KEY: TEST_SIGNING_KEY,
    JWT_ISSUER: 'stash-auth',
    JWT_AUDIENCE: 'stash-app',
    ALLOWED_PRODUCE_TOPICS: 'stash.upload.request,stash.dlq',
    ALLOWED_CONSUME_TOPICS: 'stash.upload.response',
    POLL_TIMEOUT_MS: '8000',
    MAX_BODY_BYTES: '1048576',
  };

  for (const [name, value] of Object.entries({ ...values, ...overrides })) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

export class FakeGateway implements KafkaGateway {
  produced: ProduceInput[] = [];
  records: KafkaRecord[] = [];
  polls: PollOptions[] = [];
  failure: Error | null = null;

  async produce(input: ProduceInput): Promise<{ partition: number; offset: number }> {
    if (this.failure) {
      throw this.failure;
    }
    this.produced.push(input);
    return { partition: 0, offset: 42 };
  }

  async poll(options: PollOptions): Promise<KafkaRecord[]> {
    if (this.failure) {
      throw this.failure;
    }
    this.polls.push(options);
    return this.records;
  }
}
