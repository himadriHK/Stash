import assert from 'node:assert/strict';
import test from 'node:test';

import type { KafkaRecord } from '../src/records.ts';
import { HttpError } from '../src/http.ts';
import { createMessagesHandler } from '../src/messages.ts';
import { FakeGateway, applyTestEnv, signToken, validClaims } from './helpers.ts';

applyTestEnv();

const token = signToken(validClaims());

function handlerWith(gateway: FakeGateway) {
  return createMessagesHandler({ gateway: () => gateway });
}

function postRequest(body: unknown, bearer: string | null = token): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  }
  return new Request('https://proxy.test/api/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function pollRequest(query: string, bearer: string | null = token): Request {
  const headers: Record<string, string> = {};
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  }
  return new Request(`https://proxy.test/api/messages${query}`, { method: 'GET', headers });
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

test('produces a record with verified identity headers', async () => {
  const gateway = new FakeGateway();
  const response = await handlerWith(gateway).fetch(
    postRequest({
      topic: 'stash.upload.request',
      key: 'abc123',
      value: { fileId: 'abc123', fileName: 'photo.jpg' },
      headers: { 'X-Correlation-Id': 'corr-1', Authorization: 'Bearer forged' },
    }),
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await readJson(response), { ok: true, topic: 'stash.upload.request', partition: 0, offset: 42 });

  const produced = gateway.produced[0];
  assert.ok(produced);
  assert.equal(produced.topic, 'stash.upload.request');
  assert.equal(produced.key, 'abc123');
  assert.equal(produced.value, '{"fileId":"abc123","fileName":"photo.jpg"}');
  assert.equal(produced.headers.Authorization, `Bearer ${token}`);
  assert.equal(produced.headers['X-User-Id'], 'user-1');
  assert.equal(produced.headers['X-Device-Id'], 'device-1');
  assert.equal(produced.headers['X-Correlation-Id'], 'corr-1');
  assert.equal(produced.headers['X-Message-Version'], '1');
});

test('rejects a topic outside the produce allowlist', async () => {
  const gateway = new FakeGateway();
  const response = await handlerWith(gateway).fetch(
    postRequest({ topic: 'stash.upload.response', value: 'x' }),
  );

  assert.equal(response.status, 403);
  assert.equal((await readJson<{ error: { code: string } }>(response)).error.code, 'topic_not_allowed');
  assert.equal(gateway.produced.length, 0);
});

test('requires a valid bearer token', async () => {
  const gateway = new FakeGateway();
  const missing = await handlerWith(gateway).fetch(postRequest({ topic: 'stash.upload.request', value: 'x' }, null));
  const forged = await handlerWith(gateway).fetch(postRequest({ topic: 'stash.upload.request', value: 'x' }, signToken(validClaims(), 'wrong-key-wrong-key-wrong-key-wrong')));

  assert.equal(missing.status, 401);
  assert.equal(forged.status, 401);
  assert.equal(gateway.produced.length, 0);
});

test('rejects invalid JSON', async () => {
  const response = await handlerWith(new FakeGateway()).fetch(
    new Request('https://proxy.test/api/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{not json',
    }),
  );

  assert.equal(response.status, 400);
});

test('polls with the device-derived group and clamped limits', async () => {
  const gateway = new FakeGateway();
  gateway.records = [
    {
      topic: 'stash.upload.response',
      key: 'abc',
      value: '{"fileId":"abc","status":"COMPLETED","deviceId":"device-1","userId":"user-1"}',
      headers: {},
      partition: 0,
      offset: 9,
    } satisfies KafkaRecord,
  ];

  const response = await handlerWith(gateway).fetch(
    pollRequest('?topic=stash.upload.response&timeoutMs=999999&maxRecords=5000'),
  );

  assert.equal(response.status, 200);
  const body = await readJson<{ records: KafkaRecord[]; group: string }>(response);
  assert.equal(body.group, 'stash-mobile-device-1');
  assert.equal(body.records.length, 1);

  const poll = gateway.polls[0];
  assert.ok(poll);
  assert.equal(poll.groupId, 'stash-mobile-device-1');
  assert.equal(poll.topic, 'stash.upload.response');
  assert.equal(poll.timeoutMs, 8000);
  assert.equal(poll.maxRecords, 200);
});

test('filters polled records to the authenticated device', async () => {
  const gateway = new FakeGateway();
  gateway.records = [
    {
      topic: 'stash.upload.response',
      key: 'mine',
      value: '{"fileId":"mine","status":"COMPLETED","deviceId":"device-1","userId":"user-1"}',
      headers: {},
      partition: 0,
      offset: 10,
    },
    {
      topic: 'stash.upload.response',
      key: 'foreign',
      value: '{"fileId":"foreign","status":"COMPLETED","deviceId":"device-2","userId":"user-1"}',
      headers: {},
      partition: 0,
      offset: 11,
    },
    {
      topic: 'stash.upload.response',
      key: 'legacy',
      value: '{"fileId":"legacy","status":"COMPLETED"}',
      headers: {},
      partition: 0,
      offset: 12,
    },
  ];

  const response = await handlerWith(gateway).fetch(
    pollRequest('?topic=stash.upload.response'),
  );

  assert.equal(response.status, 200);
  const body = await readJson<{ records: KafkaRecord[] }>(response);
  assert.deepEqual(body.records.map((record) => record.key), ['mine']);
});

test('refuses to consume a topic outside the consume allowlist', async () => {
  const response = await handlerWith(new FakeGateway()).fetch(pollRequest('?topic=stash.upload.request'));

  assert.equal(response.status, 403);
});

test('maps gateway failures to 502 without leaking details', async () => {
  const gateway = new FakeGateway();
  gateway.failure = new HttpError(502, 'upstream_error', 'Kafka produce failed: connection refused');

  const response = await handlerWith(gateway).fetch(
    postRequest({ topic: 'stash.upload.request', value: 'x' }),
  );

  assert.equal(response.status, 502);
  assert.equal((await readJson<{ error: { code: string } }>(response)).error.code, 'upstream_error');
});

test('answers CORS preflight and rejects unsupported methods', async () => {
  const handler = handlerWith(new FakeGateway());
  const preflight = await handler.fetch(
    new Request('https://proxy.test/api/messages', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:8081' },
    }),
  );
  const notAllowed = await handler.fetch(
    new Request('https://proxy.test/api/messages', { method: 'PUT', headers: { Authorization: `Bearer ${token}` } }),
  );

  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(notAllowed.status, 405);
});
