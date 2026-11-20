import assert from 'node:assert/strict';
import test from 'node:test';

import type { AuthContext } from '../src/auth.ts';
import { HttpError } from '../src/http.ts';
import {
  buildRecordHeaders,
  parseProduceRequest,
  readHeaders,
  toRecord,
} from '../src/records.ts';

const auth: AuthContext = { userId: 'user-1', deviceId: 'device-1', token: 'real-token' };

test('serializes an object value to JSON and keeps string values untouched', () => {
  assert.equal(parseProduceRequest({ topic: 't', value: { fileId: 'abc' } }).value, '{"fileId":"abc"}');
  assert.equal(parseProduceRequest({ topic: 't', value: 'raw text' }).value, 'raw text');
});

test('rejects payloads without a topic, a bad key or non-string headers', () => {
  const expectBadRequest = (body: unknown): void => {
    assert.throws(
      () => parseProduceRequest(body),
      (error: unknown) => error instanceof HttpError && error.status === 400,
    );
  };

  expectBadRequest({ value: 'x' });
  expectBadRequest({ topic: 't', value: 'x', key: 7 });
  expectBadRequest({ topic: 't', value: 'x', headers: { a: 1 } });
  expectBadRequest({ topic: 't' });
  expectBadRequest('nope');
});

test('cannot forge identity headers but keeps content headers', () => {
  const headers = buildRecordHeaders(
    {
      Authorization: 'Bearer forged',
      'X-User-Id': 'someone-else',
      'X-Device-Id': 'another-device',
      'X-Correlation-Id': 'corr-1',
      'X-Message-Version': '2',
    },
    auth,
    'generated-id',
  );

  assert.equal(headers.Authorization, 'Bearer real-token');
  assert.equal(headers['X-User-Id'], 'user-1');
  assert.equal(headers['X-Device-Id'], 'device-1');
  assert.equal(headers['X-Correlation-Id'], 'corr-1');
  assert.equal(headers['X-Message-Version'], '2');
});

test('defaults the message version and correlation id', () => {
  const headers = buildRecordHeaders({}, auth, 'generated-id');

  assert.equal(headers['X-Message-Version'], '1');
  assert.equal(headers['X-Correlation-Id'], 'generated-id');
  assert.equal(headers.Authorization, 'Bearer real-token');
});

test('maps librdkafka messages to JSON records', () => {
  const record = toRecord('stash.upload.response', 2, {
    key: Buffer.from('abcdef', 'utf8'),
    value: Buffer.from('{"fileId":"abcdef"}', 'utf8'),
    headers: {
      'x-dlq-reason': Buffer.from('bad payload', 'utf8'),
      repeated: [Buffer.from('first', 'utf8'), Buffer.from('second', 'utf8')],
      asString: 'plain',
      missing: undefined,
    },
    offset: '17',
  });

  assert.deepEqual(record, {
    topic: 'stash.upload.response',
    key: 'abcdef',
    value: '{"fileId":"abcdef"}',
    headers: { 'x-dlq-reason': 'bad payload', repeated: 'first', asString: 'plain' },
    partition: 2,
    offset: 17,
  });
});

test('tolerates null keys, values and headers', () => {
  assert.deepEqual(readHeaders(undefined), {});
  const record = toRecord('t', 0, { key: null, value: null, offset: '0' });
  assert.equal(record.key, '');
  assert.equal(record.value, '');
  assert.deepEqual(record.headers, {});
});
