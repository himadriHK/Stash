import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pino, { type Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SETTING_GROUPS } from '../../src/config/settingsCatalog';
import type { SettingsSnapshot } from '../../src/settings/settingsService';
import {
  SettingsService,
  SettingsValidationError,
} from '../../src/settings/settingsService';

const SIGNING_KEY = 'test-signing-key-value-with-at-least-32-characters';

let root: string;
let envPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-settings-test-'));
  envPath = path.join(root, '.env');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function runtimeEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    KAFKA_ENABLED: 'false',
    S3_ENABLED: 'false',
    LOCAL_ROOT_PATH: path.join(root, 'library'),
    JWT_SIGNING_KEY: SIGNING_KEY,
  };
}

function createService(
  options: { environment?: NodeJS.ProcessEnv; logger?: Logger } = {},
): SettingsService {
  return new SettingsService({
    envPath,
    environment: options.environment ?? {},
    runtimeEnv: runtimeEnv(),
    logger: options.logger ?? pino({ level: 'silent' }),
  });
}

function field(snapshot: SettingsSnapshot, key: string) {
  for (const group of snapshot.groups) {
    const match = group.fields.find((entry) => entry.key === key);
    if (match) return match;
  }
  throw new Error(`Missing setting ${key}`);
}

describe('SettingsService.snapshot', () => {
  it('detects sources, converts types, and redacts secrets', () => {
    fs.writeFileSync(
      envPath,
      [
        '# runtime',
        'HOST=0.0.0.0',
        'PORT=9090',
        `JWT_SIGNING_KEY=${SIGNING_KEY}`,
        'DASHBOARD_PASSWORD=file-dashboard-password',
        '',
      ].join('\n'),
      'utf8',
    );

    const service = createService({
      environment: { PORT: '9191', KAFKA_PASSWORD: 'env-kafka-secret' },
    });
    const snapshot = service.snapshot();

    expect(snapshot.envFile).toBe('.env');
    expect(snapshot.backupFile).toBeNull();
    expect(snapshot.groups.map((group) => group.id)).toEqual(
      SETTING_GROUPS.map((group) => group.id),
    );
    expect(snapshot.pendingRestartKeys).toEqual([]);
    expect(snapshot.restartNote).toContain('restart');

    expect(field(snapshot, 'PORT')).toMatchObject({
      value: 9191,
      isSet: true,
      source: 'environment',
      overriddenByEnvironment: true,
    });
    expect(field(snapshot, 'HOST')).toMatchObject({
      value: '0.0.0.0',
      isSet: true,
      source: 'env-file',
      overriddenByEnvironment: false,
    });
    expect(field(snapshot, 'LOG_LEVEL')).toMatchObject({
      value: 'info',
      isSet: false,
      source: 'default',
    });
    expect(field(snapshot, 'KAFKA_ENABLED')).toMatchObject({
      value: true,
      isSet: false,
      source: 'default',
    });
    expect(field(snapshot, 'S3_BUCKET')).toMatchObject({
      value: null,
      isSet: false,
      source: 'default',
    });

    expect(field(snapshot, 'JWT_SIGNING_KEY')).toMatchObject({
      value: null,
      isSet: true,
      source: 'env-file',
    });
    expect(field(snapshot, 'DASHBOARD_PASSWORD')).toMatchObject({
      value: null,
      isSet: true,
      source: 'env-file',
    });
    expect(field(snapshot, 'KAFKA_PASSWORD')).toMatchObject({
      value: null,
      isSet: true,
      source: 'environment',
      overriddenByEnvironment: true,
    });

    expect(snapshot.environmentOverrides).toEqual(['PORT', 'KAFKA_PASSWORD']);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(SIGNING_KEY);
    expect(serialized).not.toContain('file-dashboard-password');
    expect(serialized).not.toContain('env-kafka-secret');
  });
});

describe('SettingsService.update', () => {
  it('writes changed values, creates a backup, and tracks pending restarts', async () => {
    const original = [
      '# keep me',
      'HOST=127.0.0.1',
      'PORT=8080',
      'UNKNOWN=value',
      '',
    ].join('\n');
    fs.writeFileSync(envPath, original, 'utf8');

    const service = createService();
    const result = await service.update({ values: { PORT: 9191, HOST: '0.0.0.0' } });

    expect([...result.updated].sort()).toEqual(['HOST', 'PORT']);
    expect(result.applied).toEqual([]);
    expect(result.restartRequired).toBe(true);
    expect(result.restartKeys).toEqual(['HOST', 'PORT']);
    expect(result.pendingRestartKeys).toEqual(['HOST', 'PORT']);
    expect(result.warnings).toEqual([]);
    expect(result.envFile).toBe('.env');
    expect(result.backupFile).toBe('.env.bak');

    expect(fs.readFileSync(`${envPath}.bak`, 'utf8')).toBe(original);

    const text = fs.readFileSync(envPath, 'utf8');
    expect(text).toContain('# keep me');
    expect(text).toContain('UNKNOWN=value');
    expect(text).toContain('HOST=0.0.0.0');
    expect(text).toContain('PORT=9191');

    const snapshot = service.snapshot();
    expect(field(snapshot, 'PORT')).toMatchObject({ value: 9191, source: 'env-file', isSet: true });
    expect(field(snapshot, 'HOST')).toMatchObject({
      value: '0.0.0.0',
      source: 'env-file',
      isSet: true,
    });
    expect(snapshot.pendingRestartKeys).toEqual(['HOST', 'PORT']);
    expect(snapshot.backupFile).toBe('.env.bak');
  });

  it('applies LOG_LEVEL live without requiring a restart', async () => {
    fs.writeFileSync(envPath, 'LOG_LEVEL=info\n', 'utf8');
    const logger = pino({ level: 'info' });
    const service = createService({ logger });

    const result = await service.update({ values: { LOG_LEVEL: 'debug' } });

    expect(result.updated).toEqual(['LOG_LEVEL']);
    expect(result.applied).toEqual(['LOG_LEVEL']);
    expect(result.restartRequired).toBe(false);
    expect(result.restartKeys).toEqual([]);
    expect(logger.level).toBe('debug');
    expect(fs.readFileSync(envPath, 'utf8')).toContain('LOG_LEVEL=debug');
  });

  it('accumulates restart keys across updates', async () => {
    fs.writeFileSync(envPath, 'HOST=127.0.0.1\nPORT=8080\n', 'utf8');
    const service = createService();

    const first = await service.update({ values: { PORT: 9090 } });
    expect(first.restartKeys).toEqual(['PORT']);

    const second = await service.update({ values: { HOST: '0.0.0.0' } });
    expect(second.restartKeys).toEqual(['HOST', 'PORT']);
    expect(second.pendingRestartKeys).toEqual(['HOST', 'PORT']);
  });

  it('rejects an out-of-range port', async () => {
    const service = createService();

    try {
      await service.update({ values: { PORT: 99999 } });
      throw new Error('Expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsValidationError);
      expect((error as SettingsValidationError).fields['PORT']).toBeTruthy();
    }

    expect(fs.existsSync(envPath)).toBe(false);
  });

  it('rejects Kafka enabled with empty brokers', async () => {
    const service = createService();

    try {
      await service.update({ values: { KAFKA_ENABLED: true, KAFKA_BROKERS: '' } });
      throw new Error('Expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsValidationError);
      expect((error as SettingsValidationError).fields['KAFKA_BROKERS']).toBeTruthy();
    }
  });

  it('rejects unknown keys', async () => {
    const service = createService();

    try {
      await service.update({ values: { NOT_A_SETTING: 'x' } });
      throw new Error('Expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsValidationError);
      expect((error as SettingsValidationError).fields['NOT_A_SETTING']).toBeTruthy();
    }
  });

  it('warns when the process environment overrides a saved value', async () => {
    fs.writeFileSync(envPath, 'HOST=127.0.0.1\n', 'utf8');
    const service = createService({ environment: { HOST: '127.0.0.1' } });

    const result = await service.update({ values: { HOST: '0.0.0.0' } });

    expect(result.updated).toEqual(['HOST']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('HOST');
    expect(result.warnings[0]).not.toContain('127.0.0.1');
    expect(fs.readFileSync(envPath, 'utf8')).toContain('HOST=0.0.0.0');

    const snapshot = service.snapshot();
    expect(field(snapshot, 'HOST')).toMatchObject({
      value: '127.0.0.1',
      source: 'environment',
      overriddenByEnvironment: true,
    });
  });

  it('never returns secret values', async () => {
    const secret = 'dashboard-password-value-123';
    const service = createService();

    const result = await service.update({ values: { DASHBOARD_PASSWORD: secret } });

    expect(result.updated).toEqual(['DASHBOARD_PASSWORD']);
    expect(JSON.stringify(result)).not.toContain(secret);

    const snapshot = service.snapshot();
    expect(field(snapshot, 'DASHBOARD_PASSWORD')).toMatchObject({
      value: null,
      isSet: true,
      source: 'env-file',
    });
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(fs.readFileSync(envPath, 'utf8')).toContain(secret);
  });

  it('clears a key when the value is null or empty', async () => {
    fs.writeFileSync(envPath, 'S3_ENDPOINT=https://example.com\n', 'utf8');
    const service = createService();

    const result = await service.update({ values: { S3_ENDPOINT: null } });

    expect(result.updated).toEqual(['S3_ENDPOINT']);
    expect(fs.readFileSync(envPath, 'utf8')).toContain('S3_ENDPOINT=');
    expect(field(service.snapshot(), 'S3_ENDPOINT')).toMatchObject({
      value: null,
      isSet: false,
      source: 'default',
    });
  });
});
