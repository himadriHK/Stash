import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { ConfigError, REDACTED, loadEnv, summarizeEnv } from '../../src/config/env';
import { TEST_SIGNING_KEY } from '../helpers/env';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-config-test-'));
const localRoot = path.join(root, 'library');

function base(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    KAFKA_ENABLED: 'false',
    S3_ENABLED: 'false',
    LOCAL_ROOT_PATH: localRoot,
    JWT_SIGNING_KEY: TEST_SIGNING_KEY,
    ...overrides,
  };
}

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('loadEnv', () => {
  it('parses a minimal valid configuration and applies defaults', () => {
    const env = loadEnv(base());
    expect(env.NODE_ENV).toBe('test');
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.PORT).toBe(8080);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.DB_PATH).toBe('./data/stash_host.db');
    expect(env.TEMP_DIR).toBe(path.join(os.tmpdir(), 'stash-host-node'));
    expect(env.KAFKA_CLIENT_ID).toBe('stash-host-node');
    expect(env.KAFKA_GROUP_ID).toBe('stash-upload-request');
    expect(env.KAFKA_SSL).toBe(true);
    expect(env.S3_REGION).toBe('us-east-1');
    expect(env.JWT_ISSUER).toBe('stash-auth');
    expect(env.JWT_AUDIENCE).toBe('stash-app');
    expect(env.WORKER_CONCURRENCY).toBe(2);
    expect(env.JOB_MAX_ATTEMPTS).toBe(4);
    expect(env.HASH_WORKER_TIMEOUT_MS).toBe(300000);
    expect(env.MEDIA_WORKER_TIMEOUT_MS).toBe(600000);
  });

  it('treats empty defaulted values as unset', () => {
    const env = loadEnv(base({ TEMP_DIR: '', HOST: '', DB_PATH: '' }));
    expect(env.TEMP_DIR).toBe(path.join(os.tmpdir(), 'stash-host-node'));
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.DB_PATH).toBe('./data/stash_host.db');
  });

  it('splits and trims Kafka brokers', () => {
    const env = loadEnv(
      base({
        KAFKA_ENABLED: 'true',
        KAFKA_BROKERS: 'broker-1:9092, broker-2:9092',
      }),
    );
    expect(env.KAFKA_BROKERS).toEqual(['broker-1:9092', 'broker-2:9092']);
  });

  it('accepts strict booleans true/false/1/0', () => {
    expect(loadEnv(base({ KAFKA_SSL: '1' })).KAFKA_SSL).toBe(true);
    expect(loadEnv(base({ KAFKA_SSL: '0' })).KAFKA_SSL).toBe(false);
    expect(loadEnv(base({ KAFKA_SSL: 'TRUE' })).KAFKA_SSL).toBe(true);
  });

  it('rejects non-strict booleans with the offending key', () => {
    expect(() => loadEnv(base({ KAFKA_SSL: 'yes' }))).toThrow(ConfigError);
    try {
      loadEnv(base({ KAFKA_SSL: 'yes' }));
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('KAFKA_SSL');
    }
  });

  it('rejects out-of-bounds integers with the offending key', () => {
    expect(() => loadEnv(base({ PORT: '70000' }))).toThrow(ConfigError);
    try {
      loadEnv(base({ PORT: '70000' }));
    } catch (error) {
      expect((error as ConfigError).message).toContain('PORT');
    }
  });

  it('requires LOCAL_ROOT_PATH', () => {
    const source = base();
    delete source['LOCAL_ROOT_PATH'];
    expect(() => loadEnv(source)).toThrow(ConfigError);
    try {
      loadEnv(source);
    } catch (error) {
      expect((error as ConfigError).message).toContain('LOCAL_ROOT_PATH');
    }
  });

  it('requires LOCAL_ROOT_PATH to be absolute', () => {
    expect(() => loadEnv(base({ LOCAL_ROOT_PATH: 'relative/library' }))).toThrow(ConfigError);
  });

  it('requires a JWT signing key with at least 32 characters', () => {
    const source = base();
    delete source['JWT_SIGNING_KEY'];
    expect(() => loadEnv(source)).toThrow(ConfigError);
    expect(() => loadEnv(base({ JWT_SIGNING_KEY: 'short' }))).toThrow(ConfigError);
    expect(() => loadEnv(base({ JWT_SIGNING_KEY: '   ' }))).toThrow(ConfigError);
  });

  it('preserves signing-key bytes without trimming', () => {
    const key = ` ${'a'.repeat(31)} `;
    expect(loadEnv(base({ JWT_SIGNING_KEY: key })).JWT_SIGNING_KEY).toBe(key);
  });

  it('requires Kafka brokers when Kafka is enabled', () => {
    expect(() => loadEnv(base({ KAFKA_ENABLED: 'true', KAFKA_BROKERS: '' }))).toThrow(ConfigError);
    try {
      loadEnv(base({ KAFKA_ENABLED: 'true', KAFKA_BROKERS: '' }));
    } catch (error) {
      expect((error as ConfigError).message).toContain('KAFKA_BROKERS');
    }
  });

  it('requires an S3 bucket when S3 is enabled', () => {
    expect(() => loadEnv(base({ S3_ENABLED: 'true' }))).toThrow(ConfigError);
    try {
      loadEnv(base({ S3_ENABLED: 'true' }));
    } catch (error) {
      expect((error as ConfigError).message).toContain('S3_BUCKET');
    }
  });

  it('requires a dashboard user and a 12 character password when auth is enabled', () => {
    expect(() =>
      loadEnv(
        base({
          DASHBOARD_AUTH_ENABLED: 'true',
          DASHBOARD_USER: 'admin',
          DASHBOARD_PASSWORD: 'short',
        }),
      ),
    ).toThrow(ConfigError);
    try {
      loadEnv(
        base({
          DASHBOARD_AUTH_ENABLED: 'true',
          DASHBOARD_USER: 'admin',
          DASHBOARD_PASSWORD: 'short',
        }),
      );
    } catch (error) {
      expect((error as ConfigError).message).toContain('DASHBOARD_PASSWORD');
    }
  });

  it('redacts secrets from the summary helper', () => {
    const env = loadEnv(
      base({
        KAFKA_ENABLED: 'true',
        KAFKA_BROKERS: 'broker:9092',
        KAFKA_USERNAME: 'kafka-user',
        KAFKA_PASSWORD: 'kafka-password-secret',
        S3_ENABLED: 'true',
        S3_BUCKET: 'stash-bucket',
        S3_ACCESS_KEY_ID: 'access-key-id',
        S3_SECRET_ACCESS_KEY: 's3-secret-value',
        S3_SESSION_TOKEN: 'session-token-value',
        DASHBOARD_AUTH_ENABLED: 'true',
        DASHBOARD_USER: 'admin',
        DASHBOARD_PASSWORD: 'dashboard-password',
      }),
    );
    const serialized = JSON.stringify(summarizeEnv(env));
    expect(serialized).not.toContain(TEST_SIGNING_KEY);
    expect(serialized).not.toContain('kafka-password-secret');
    expect(serialized).not.toContain('s3-secret-value');
    expect(serialized).not.toContain('session-token-value');
    expect(serialized).not.toContain('dashboard-password');
    expect(serialized).toContain(REDACTED);
  });
});



