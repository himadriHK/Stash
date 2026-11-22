import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { envSchema } from '../../src/config/env';
import {
  MANAGED_ENV_KEYS,
  SETTINGS,
  SETTINGS_BY_KEY,
  SETTING_GROUPS,
  getSetting,
} from '../../src/config/settingsCatalog';

const SECRET_KEYS = [
  'DASHBOARD_PASSWORD',
  'DASHBOARD_USER',
  'JWT_SIGNING_KEY',
  'KAFKA_PASSWORD',
  'KAFKA_USERNAME',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_SESSION_TOKEN',
];

const BOOLEAN_KEYS = [
  'DASHBOARD_AUTH_ENABLED',
  'DELETE_TEMP_ON_FAILURE',
  'HEIC_WORKER_ENABLED',
  'KAFKA_DLQ_MIRROR_FAILURES',
  'KAFKA_ENABLED',
  'KAFKA_FROM_BEGINNING',
  'KAFKA_SSL',
  'METRICS_ENABLED',
  'S3_ENABLED',
  'S3_FORCE_PATH_STYLE',
  'WORKER_ENABLED',
];

const SELECT_KEYS = ['KAFKA_SASL_MECHANISM', 'LOG_LEVEL', 'NODE_ENV', 'RAW_DECODER'];

const PATH_KEYS = ['DB_PATH', 'FFMPEG_PATH', 'FFPROBE_PATH', 'LOCAL_ROOT_PATH', 'TEMP_DIR'];

describe('settings catalog', () => {
  it('covers every env schema key exactly once', () => {
    const catalogKeys = SETTINGS.map((setting) => setting.key);
    const schemaKeys = Object.keys(envSchema.shape);

    expect(catalogKeys).toHaveLength(76);
    expect(new Set(catalogKeys).size).toBe(76);
    expect([...catalogKeys].sort()).toEqual([...schemaKeys].sort());
    expect(MANAGED_ENV_KEYS).toEqual(catalogKeys);
    expect(SETTINGS_BY_KEY.size).toBe(76);
  });

  it('keeps settings grouped in the declared group order', () => {
    const groupIds = SETTING_GROUPS.map((group) => group.id);
    expect(groupIds).toEqual(['runtime', 'kafka', 's3', 'jwt', 'worker', 'media', 'dashboard']);

    const known = new Set(groupIds);
    for (const setting of SETTINGS) {
      expect(known.has(setting.group)).toBe(true);
      expect(setting.label.length).toBeGreaterThan(0);
      expect(setting.description.length).toBeGreaterThan(0);
    }

    for (const group of SETTING_GROUPS) {
      expect(group.label.length).toBeGreaterThan(0);
      expect(group.description.length).toBeGreaterThan(0);
    }
  });

  it('marks only LOG_LEVEL as restart-free', () => {
    expect(SETTINGS.filter((setting) => !setting.requiresRestart).map((setting) => setting.key)).toEqual(
      ['LOG_LEVEL'],
    );
  });

  it('marks exactly the documented secret keys', () => {
    expect(SETTINGS.filter((setting) => setting.secret).map((setting) => setting.key).sort()).toEqual(
      SECRET_KEYS,
    );
  });

  it('renders secret fields with the secret type', () => {
    for (const setting of SETTINGS) {
      if (setting.secret) expect(setting.type).toBe('secret');
      else expect(setting.type).not.toBe('secret');
    }
  });

  it('uses the expected field types', () => {
    expect(
      SETTINGS.filter((setting) => setting.type === 'boolean')
        .map((setting) => setting.key)
        .sort(),
    ).toEqual(BOOLEAN_KEYS);

    expect(
      SETTINGS.filter((setting) => setting.type === 'select').map((setting) => setting.key).sort(),
    ).toEqual(SELECT_KEYS);

    expect(
      SETTINGS.filter((setting) => setting.type === 'path').map((setting) => setting.key).sort(),
    ).toEqual(PATH_KEYS);

    expect(SETTINGS.filter((setting) => setting.type === 'csv').map((setting) => setting.key)).toEqual([
      'KAFKA_BROKERS',
    ]);

    for (const setting of SETTINGS) {
      if (setting.type === 'number') {
        expect(typeof setting.min).toBe('number');
        expect(typeof setting.max).toBe('number');
        expect(setting.min).toBeLessThanOrEqual(setting.max as number);
        expect(Number.isInteger(Number(setting.defaultValue))).toBe(true);
      }
    }
  });

  it('exposes select options matching the schema enums', () => {
    expect(getSetting('NODE_ENV')?.options?.map((option) => option.value)).toEqual([
      'development',
      'test',
      'production',
    ]);
    expect(getSetting('LOG_LEVEL')?.options?.map((option) => option.value)).toEqual([
      'fatal',
      'error',
      'warn',
      'info',
      'debug',
      'trace',
    ]);
    expect(getSetting('KAFKA_SASL_MECHANISM')?.options?.map((option) => option.value)).toEqual([
      'plain',
      'scram-sha-256',
      'scram-sha-512',
    ]);
    expect(getSetting('RAW_DECODER')?.options?.map((option) => option.value)).toEqual([
      'libraw',
      'wasm',
      'imagemagick',
    ]);
  });

  it('uses schema defaults and null for unset optional values', () => {
    expect(getSetting('NODE_ENV')?.defaultValue).toBe('development');
    expect(getSetting('HOST')?.defaultValue).toBe('127.0.0.1');
    expect(getSetting('PORT')?.defaultValue).toBe('8080');
    expect(getSetting('LOG_LEVEL')?.defaultValue).toBe('info');
    expect(getSetting('DB_PATH')?.defaultValue).toBe('./data/stash_host.db');
    expect(getSetting('LOCAL_ROOT_PATH')?.defaultValue).toBeNull();
    expect(getSetting('TEMP_DIR')?.defaultValue).toBe(path.join(os.tmpdir(), 'stash-host-node'));
    expect(getSetting('KAFKA_BROKERS')?.defaultValue).toBeNull();
    expect(getSetting('KAFKA_SASL_MECHANISM')?.defaultValue).toBe('scram-sha-256');
    expect(getSetting('S3_BUCKET')?.defaultValue).toBeNull();
    expect(getSetting('JWT_SIGNING_KEY')?.defaultValue).toBeNull();
    expect(getSetting('DASHBOARD_AUTH_ENABLED')?.defaultValue).toBe('false');
    expect(getSetting('DELETE_TEMP_ON_FAILURE')?.defaultValue).toBe('true');
    expect(getSetting('HEIC_WORKER_ENABLED')?.defaultValue).toBe('true');
    expect(getSetting('RAW_DECODER')?.defaultValue).toBe('libraw');
  });

  it('records units for timed and measured settings', () => {
    expect(getSetting('KAFKA_COMMIT_TIMEOUT_MS')?.unit).toBe('ms');
    expect(getSetting('STAGE_TIMEOUT_DOWNLOAD_MS')?.unit).toBe('ms');
    expect(getSetting('LEASE_SECONDS')?.unit).toBe('seconds');
    expect(getSetting('DISK_MIN_FREE_BYTES')?.unit).toBe('bytes');
    expect(getSetting('THUMBNAIL_QUALITY')?.unit).toBe('percent');
    expect(getSetting('MAX_IMAGE_PIXELS')?.unit).toBe('pixels');
  });

  it('looks up settings by key', () => {
    expect(getSetting('PORT')?.key).toBe('PORT');
    expect(getSetting('NOT_A_KEY')).toBeUndefined();
  });
});
