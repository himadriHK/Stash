import type { ZodError } from 'zod';

import { JwtError, readHeaderValue, verifyAuthorizationHeader } from '../auth/jwt';
import type { VerifiedIdentity } from '../auth/jwt';
import type { HeadersLike } from '../auth/jwt';
import type { AppEnv } from '../config/env';
import {
  MAX_METADATA_BYTES,
  uploadRequestSchema,
} from '../contracts/request';
import type { ValidatedUploadRequest } from '../contracts/request';
import { PathError, buildS3Key } from '../storage/paths';

export const REJECT_CODES = [
  'invalid_json',
  'invalid_payload',
  'unsupported_version',
  'invalid_storage_provider',
  'jwt_missing',
  'jwt_invalid',
  'jwt_claim_missing',
  'identity_mismatch',
  'correlation_missing',
  'kafka_key_missing',
  'kafka_key_mismatch',
] as const;

export type RejectCode = (typeof REJECT_CODES)[number];

const REJECT_STATUS: Record<RejectCode, number> = {
  invalid_json: 400,
  invalid_payload: 400,
  unsupported_version: 400,
  invalid_storage_provider: 400,
  jwt_missing: 401,
  jwt_invalid: 401,
  jwt_claim_missing: 401,
  identity_mismatch: 401,
  correlation_missing: 400,
  kafka_key_missing: 400,
  kafka_key_mismatch: 400,
};

export class RejectError extends Error {
  readonly code: RejectCode;
  readonly status: number;

  constructor(code: RejectCode, message: string, status: number = REJECT_STATUS[code]) {
    super(message);
    this.name = 'RejectError';
    this.code = code;
    this.status = status;
  }
}

function decodeJson(rawValue: unknown): unknown {
  if (rawValue === null || rawValue === undefined) {
    throw new RejectError('invalid_json', 'Message body is required.');
  }
  if (Buffer.isBuffer(rawValue)) {
    return parseJson(rawValue.toString('utf8'));
  }
  if (rawValue instanceof Uint8Array) {
    return parseJson(Buffer.from(rawValue).toString('utf8'));
  }
  if (typeof rawValue === 'string') {
    return parseJson(rawValue);
  }
  return rawValue;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new RejectError('invalid_json', 'Message body must be valid JSON.');
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new RejectError('invalid_payload', 'Message body must be a JSON object.');
}

function normalizeKey(recordKey: string | Buffer | null | undefined): string {
  if (recordKey === null || recordKey === undefined) return '';
  if (Buffer.isBuffer(recordKey)) return recordKey.toString('utf8').trim();
  return recordKey.trim();
}

function formatZodIssues(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Message payload is invalid.';
  const path = issue.path.length > 0 ? issue.path.map(String).join('.') : 'payload';
  return `Message payload is invalid: ${path}: ${issue.message}`;
}

export async function validateRequest(
  rawValue: unknown,
  recordKey: string | Buffer | null | undefined,
  headers: HeadersLike | undefined,
  env: AppEnv,
): Promise<ValidatedUploadRequest> {
  let parsed = decodeJson(rawValue);

  if (typeof parsed === 'string') {
    parsed = parseJson(parsed);
  }

  const input = asRecord(parsed);

  if (input['version'] !== undefined && input['version'] !== 2) {
    throw new RejectError('unsupported_version', 'Unsupported message version.');
  }

  const provider = input['storageProvider'];
  if (provider !== undefined) {
    if (typeof provider !== 'string' || provider.trim().toLowerCase() !== 's3') {
      throw new RejectError('invalid_storage_provider', 'Unsupported storage provider.');
    }
  }

  const correlationId = input['correlationId'];
  if (
    correlationId === undefined ||
    correlationId === null ||
    (typeof correlationId === 'string' && correlationId.trim() === '')
  ) {
    throw new RejectError('correlation_missing', 'Correlation id is required.');
  }
  if (typeof correlationId !== 'string') {
    throw new RejectError('invalid_payload', 'Message payload is invalid: correlationId must be a string.');
  }

  const result = uploadRequestSchema.safeParse(input);
  if (!result.success) {
    throw new RejectError('invalid_payload', formatZodIssues(result.error));
  }

  const request = result.data;

  let metadataJson: string | null = null;
  if (request.metadata) {
    try {
      metadataJson = JSON.stringify(request.metadata);
    } catch {
      throw new RejectError('invalid_payload', 'Message payload is invalid: metadata is not serializable.');
    }
    if (Buffer.byteLength(metadataJson, 'utf8') > MAX_METADATA_BYTES) {
      throw new RejectError('invalid_payload', 'Message payload is invalid: metadata is too large.');
    }
  }

  let storageKey: string;
  try {
    storageKey = buildS3Key(request.storageTempPath, env.S3_PREFIX);
  } catch (error) {
    if (error instanceof PathError) {
      throw new RejectError('invalid_payload', 'Message payload is invalid: storageTempPath is unsafe.');
    }
    throw error;
  }

  let identity: VerifiedIdentity;
  try {
    identity = await verifyAuthorizationHeader(headers, env);
  } catch (error) {
    if (error instanceof JwtError) {
      throw new RejectError(error.code, error.message);
    }
    throw error;
  }

  if (request.userId !== undefined && request.userId !== identity.userId) {
    throw new RejectError('identity_mismatch', 'Payload user identity does not match the authorization token.');
  }
  if (request.deviceId !== undefined && request.deviceId !== identity.deviceId) {
    throw new RejectError('identity_mismatch', 'Payload device identity does not match the authorization token.');
  }

  const headerUserId = readHeaderValue(headers, 'x-user-id');
  if (headerUserId !== null && headerUserId !== identity.userId) {
    throw new RejectError('identity_mismatch', 'Header user identity does not match the authorization token.');
  }

  const headerDeviceId = readHeaderValue(headers, 'x-device-id');
  if (headerDeviceId !== null && headerDeviceId !== identity.deviceId) {
    throw new RejectError('identity_mismatch', 'Header device identity does not match the authorization token.');
  }

  const headerCorrelationId = readHeaderValue(headers, 'x-correlation-id');
  if (headerCorrelationId !== null && headerCorrelationId !== request.correlationId) {
    throw new RejectError('invalid_payload', 'Correlation id header does not match the payload.');
  }

  const key = normalizeKey(recordKey);
  if (key === '') {
    throw new RejectError('kafka_key_missing', 'Kafka record key is required.');
  }
  if (key.toLowerCase() !== request.fileId) {
    throw new RejectError('kafka_key_mismatch', 'Kafka record key does not match the file id.');
  }

  const requestFileId = typeof input['fileId'] === 'string' ? input['fileId'] : request.fileId;

  return {
    ...request,
    fileId: request.fileId,
    requestFileId,
    userId: identity.userId,
    deviceId: identity.deviceId,
    storageKey,
    metadataJson,
  };
}


