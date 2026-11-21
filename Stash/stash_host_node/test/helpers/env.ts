import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SignJWT } from 'jose';

import type { AppEnv } from '../../src/config/env';
import { loadEnv } from '../../src/config/env';
import type { KafkaIncomingRecord } from '../../src/kafka/consumer';

export const TEST_SIGNING_KEY = 'test-signing-key-value-with-at-least-32-characters';
export const OTHER_SIGNING_KEY = 'other-signing-key-value-with-at-least-32-chars';

export interface TestWorkspace {
  root: string;
  env: AppEnv;
  cleanup: () => void;
}

export function createWorkspace(overrides: Record<string, string | undefined> = {}): TestWorkspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-host-node-test-'));
  const env = loadEnv({
    NODE_ENV: 'test',
    KAFKA_ENABLED: 'false',
    S3_ENABLED: 'false',
    S3_PREFIX: 'stash',
    LOCAL_ROOT_PATH: path.join(root, 'library'),
    DB_PATH: path.join(root, 'data', 'test.db'),
    TEMP_DIR: path.join(root, 'temp'),
    JWT_SIGNING_KEY: TEST_SIGNING_KEY,
    ...overrides,
  });
  return {
    root,
    env,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export interface SignTokenOptions {
  expired?: boolean;
  issuer?: string;
  audience?: string;
  key?: string;
}

export async function signToken(
  env: AppEnv,
  claims: Record<string, unknown> = {},
  options: SignTokenOptions = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const key = new TextEncoder().encode(options.key ?? env.JWT_SIGNING_KEY);
  return new SignJWT({ userId: 'user-1', deviceId: 'device-1', ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(options.issuer ?? env.JWT_ISSUER)
    .setAudience(options.audience ?? env.JWT_AUDIENCE)
    .setIssuedAt(now - 10)
    .setExpirationTime(options.expired ? now - 60 : now + 3600)
    .sign(key);
}

export interface RequestOverrides {
  [key: string]: unknown;
}

export function validRequest(overrides: RequestOverrides = {}): Record<string, unknown> {
  return {
    messageId: 'message-1',
    timestamp: '2026-11-21T00:00:00.000Z',
    fileId: 'a'.repeat(64),
    fileName: 'photo.heic',
    fileSize: 1024,
    mimeType: 'image/heic',
    storageTempPath: `/temp/uploads/device-1/${'a'.repeat(64)}/photo.heic`,
    storageProvider: 'S3',
    metadata: {
      createdAt: '2026-11-20T00:00:00.000Z',
      modifiedAt: '2026-11-20T01:00:00.000Z',
    },
    deviceId: 'device-1',
    userId: 'user-1',
    correlationId: 'correlation-1',
    version: 2,
    ...overrides,
  };
}

export function makeRecord(
  request: Record<string, unknown>,
  options: {
    key?: string;
    headers?: Record<string, string>;
    offset?: string;
  } = {},
): KafkaIncomingRecord {
  const fileId = typeof request['fileId'] === 'string' ? request['fileId'] : 'a'.repeat(64);
  return {
    topic: 'stash.upload.request',
    partition: 0,
    offset: options.offset ?? '0',
    timestamp: '2026-11-21T00:00:00.000Z',
    key: options.key ?? fileId,
    value: JSON.stringify(request),
    headers: options.headers ?? {},
  };
}

export async function authorizationHeader(env: AppEnv): Promise<Record<string, string>> {
  const token = await signToken(env);
  return { authorization: `Bearer ${token}` };
}
