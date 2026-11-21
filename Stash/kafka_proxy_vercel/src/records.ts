/**
 * Record mapping and header policy.
 *
 * Record headers are the security boundary: the phone may not choose its own
 * Authorization, user or device identity, because the Functions host trusts
 * them when it validates a message.
 */
import type { AuthContext } from './auth.ts';
import { HttpError } from './http.ts';

/** Client-supplied headers that are always replaced with verified values. */
const RESERVED_HEADERS = new Set(['authorization', 'x-user-id', 'x-device-id']);

export interface ProduceInput {
  topic: string;
  key: string;
  value: string;
  headers: Record<string, string>;
}

export interface KafkaRecord {
  topic: string;
  key: string;
  value: string;
  headers: Record<string, string>;
  partition: number;
  offset: number;
}

/** The subset of a librdkafka message this proxy maps to its JSON shape. */
export interface KafkaClientMessage {
  key: Buffer | null;
  value: Buffer | null;
  headers?: Record<string, Buffer | string | (Buffer | string)[] | undefined>;
  offset: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseProduceRequest(body: unknown): ProduceInput {
  if (!isPlainObject(body)) {
    throw new HttpError(400, 'invalid_request', 'Body must be a JSON object.');
  }

  const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
  if (!topic) {
    throw new HttpError(400, 'invalid_request', '"topic" is required.');
  }

  if (body.key !== undefined && typeof body.key !== 'string') {
    throw new HttpError(400, 'invalid_request', '"key" must be a string.');
  }
  const key = typeof body.key === 'string' ? body.key : '';

  const value = body.value;
  if (typeof value !== 'string' && !isPlainObject(value) && !Array.isArray(value)) {
    throw new HttpError(400, 'invalid_request', '"value" must be an object, array or string.');
  }
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);

  const headers: Record<string, string> = {};
  if (body.headers !== undefined) {
    if (!isPlainObject(body.headers)) {
      throw new HttpError(400, 'invalid_request', '"headers" must be an object of strings.');
    }
    for (const [name, headerValue] of Object.entries(body.headers)) {
      if (!name.trim()) {
        throw new HttpError(400, 'invalid_request', 'Header names cannot be empty.');
      }
      if (typeof headerValue !== 'string') {
        throw new HttpError(400, 'invalid_request', `Header "${name}" must be a string.`);
      }
      headers[name] = headerValue;
    }
  }

  return { topic, key, value: serialized, headers };
}

export function buildRecordHeaders(
  clientHeaders: Record<string, string>,
  auth: AuthContext,
  correlationId: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  let hasVersion = false;
  let hasCorrelationId = false;

  for (const [name, value] of Object.entries(clientHeaders)) {
    const lower = name.toLowerCase();
    if (RESERVED_HEADERS.has(lower)) {
      continue;
    }
    if (lower === 'x-message-version') {
      hasVersion = true;
    }
    if (lower === 'x-correlation-id') {
      hasCorrelationId = true;
    }
    headers[name] = value;
  }

  if (!hasVersion) {
    headers['X-Message-Version'] = '1';
  }
  if (!hasCorrelationId) {
    headers['X-Correlation-Id'] = correlationId;
  }

  headers.Authorization = `Bearer ${auth.token}`;
  headers['X-User-Id'] = auth.userId;
  headers['X-Device-Id'] = auth.deviceId;

  return headers;
}

/** Flattens librdkafka headers (Buffer/string/array) to strings for JSON. */
export function readHeaders(raw: KafkaClientMessage['headers']): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first === undefined) {
      continue;
    }
    headers[name] = typeof first === 'string' ? first : first.toString('utf8');
  }
  return headers;
}

export function toRecord(
  topic: string,
  partition: number,
  message: KafkaClientMessage,
): KafkaRecord {
  return {
    topic,
    key: message.key ? message.key.toString('utf8') : '',
    value: message.value ? message.value.toString('utf8') : '',
    headers: readHeaders(message.headers),
    partition,
    offset: Number(message.offset),
  };
}

/**
 * Keeps only records that belong to the authenticated device (and user, when
 * the record identifies one). gateway.poll may read other devices' records from
 * the shared response topic, so read amplification remains, but those records
 * are never returned to this device. Unidentified/legacy records with no usable
 * deviceId are excluded.
 */
export function filterRecordsForAuth(
  records: KafkaRecord[],
  auth: AuthContext,
): KafkaRecord[] {
  const deviceId = auth.deviceId.trim();
  return records.filter((record) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.value);
    } catch {
      return false;
    }
    if (!isPlainObject(parsed)) {
      return false;
    }

    const recordDeviceId = typeof parsed.deviceId === 'string' ? parsed.deviceId.trim() : '';
    if (!recordDeviceId || recordDeviceId !== deviceId) {
      return false;
    }

    const rawUserId = parsed.userId;
    if (rawUserId === undefined || rawUserId === null) {
      return true;
    }
    if (typeof rawUserId !== 'string') {
      return false;
    }
    const recordUserId = rawUserId.trim();
    return recordUserId.length === 0 || recordUserId === auth.userId;
  });
}
