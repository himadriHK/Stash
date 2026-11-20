import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyAccessToken } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { HttpError } from '../src/http.ts';
import { TEST_SIGNING_KEY, applyTestEnv, signToken, validClaims } from './helpers.ts';

applyTestEnv();
const config = loadConfig(process.env);

function expectStatus(fn: () => unknown, status: number, code?: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof HttpError, `expected HttpError, got ${String(error)}`);
    assert.equal(error.status, status);
    if (code !== undefined) {
      assert.equal(error.code, code);
    }
    return true;
  });
}

test('accepts a token signed with the shared key and extracts the identity', () => {
  const token = signToken(validClaims());
  const auth = verifyAccessToken(token, config);

  assert.equal(auth.userId, 'user-1');
  assert.equal(auth.deviceId, 'device-1');
  assert.equal(auth.token, token);
});

test('falls back to the snake_case device claim and sub claim', () => {
  const token = signToken({ sub: 'user-2', device_id: 'device-2', iss: 'stash-auth', aud: ['stash-app'], exp: Math.floor(Date.now() / 1000) + 60 });
  const auth = verifyAccessToken(token, config);

  assert.equal(auth.userId, 'user-2');
  assert.equal(auth.deviceId, 'device-2');
});

test('rejects a token signed with another key', () => {
  const token = signToken(validClaims(), `${TEST_SIGNING_KEY}-other`);
  expectStatus(() => verifyAccessToken(token, config), 401, 'invalid_token');
});

test('rejects an expired token', () => {
  const token = signToken(validClaims({ exp: Math.floor(Date.now() / 1000) - 120 }));
  expectStatus(() => verifyAccessToken(token, config), 401, 'token_expired');
});

test('rejects an untrusted audience', () => {
  const token = signToken(validClaims({ aud: 'another-app' }));
  expectStatus(() => verifyAccessToken(token, config), 401, 'invalid_token');
});

test('rejects an untrusted issuer', () => {
  const token = signToken(validClaims({ iss: 'someone-else' }));
  expectStatus(() => verifyAccessToken(token, config), 401, 'invalid_token');
});

test('rejects a token without a device identity', () => {
  const token = signToken(validClaims({ deviceId: undefined }));
  expectStatus(() => verifyAccessToken(token, config), 401, 'invalid_token');
});

test('rejects an unsigned (alg: none) token', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(validClaims())).toString('base64url');
  expectStatus(() => verifyAccessToken(`${header}.${payload}.`, config), 401, 'invalid_token');
});

test('rejects a malformed token', () => {
  expectStatus(() => verifyAccessToken('not-a-jwt', config), 401, 'invalid_token');
});
