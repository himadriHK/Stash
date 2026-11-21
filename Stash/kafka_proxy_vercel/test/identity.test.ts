import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import test from 'node:test';

import { verifyAccessToken } from '../src/auth.ts';
import { HttpError } from '../src/http.ts';
import type { IdentityConfig } from '../src/identity/config.ts';
import { createIdentityHandler, type IdentityHandlerOptions } from '../src/identity/handler.ts';
import type {
  IdentityDevice,
  IdentityRefreshToken,
  IdentityUser,
  TokenPair,
} from '../src/identity/models.ts';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../src/identity/password.ts';
import { EmailAlreadyRegisteredError, type IdentityStore } from '../src/identity/store.ts';

const TEST_CONFIG: IdentityConfig = {
  mongoUri: 'mongodb://unused',
  mongoDatabase: 'stash',
  jwtSigningKey: 'test-signing-key-with-at-least-32-characters',
  jwtIssuer: 'stash-auth',
  jwtAudience: 'stash-app',
  accessTokenExpiryMinutes: 15,
  refreshTokenExpiryDays: 7,
  corsOrigins: '*',
  maxBodyBytes: 65_536,
};

class MemoryIdentityStore implements IdentityStore {
  readonly users = new Map<string, IdentityUser>();
  readonly usersByEmail = new Map<string, IdentityUser>();
  readonly devices = new Map<string, IdentityDevice>();
  readonly refreshTokens = new Map<string, IdentityRefreshToken>();
  ensureIndexesCalls = 0;
  findUserByEmailCalls = 0;
  consumeRefreshTokenCalls = 0;
  private sequence = 0;

  private nextId(): string {
    this.sequence += 1;
    return this.sequence.toString(16).padStart(24, '0');
  }

  private deviceKey(userId: string, deviceId: string): string {
    return `${userId}|${deviceId}`;
  }

  async ensureIndexes(): Promise<void> {
    this.ensureIndexesCalls += 1;
  }

  async findUserByEmail(email: string): Promise<IdentityUser | null> {
    this.findUserByEmailCalls += 1;
    const user = this.usersByEmail.get(email);
    return user ? { ...user } : null;
  }

  async findUserById(userId: string): Promise<IdentityUser | null> {
    const user = this.users.get(userId);
    return user ? { ...user } : null;
  }

  async createUser(email: string, passwordHash: string): Promise<IdentityUser> {
    if (this.usersByEmail.has(email)) {
      throw new EmailAlreadyRegisteredError();
    }
    const user: IdentityUser = {
      id: this.nextId(),
      email,
      passwordHash,
      createdAt: new Date(),
      isActive: true,
    };
    this.users.set(user.id, user);
    this.usersByEmail.set(user.email, user);
    return { ...user };
  }

  async findDevice(userId: string, deviceId: string): Promise<IdentityDevice | null> {
    const device = this.devices.get(this.deviceKey(userId, deviceId));
    return device ? { ...device } : null;
  }

  async ensureDevice(userId: string, deviceId: string): Promise<IdentityDevice> {
    const key = this.deviceKey(userId, deviceId);
    const existing = this.devices.get(key);
    if (existing) {
      return { ...existing };
    }
    const device: IdentityDevice = {
      id: this.nextId(),
      userId,
      deviceId,
      isRevoked: false,
      createdAt: new Date(),
    };
    this.devices.set(key, device);
    return { ...device };
  }

  async revokeDevice(userId: string, deviceId: string): Promise<void> {
    const key = this.deviceKey(userId, deviceId);
    const device = this.devices.get(key);
    if (device) {
      this.devices.set(key, { ...device, isRevoked: true });
    }
    for (const [token, record] of this.refreshTokens) {
      if (record.userId === userId && record.deviceId === deviceId) {
        this.refreshTokens.set(token, { ...record, isRevoked: true });
      }
    }
  }

  async consumeRefreshToken(
    token: string,
    now: Date,
  ): Promise<IdentityRefreshToken | null> {
    this.consumeRefreshTokenCalls += 1;
    const record = this.refreshTokens.get(token);
    if (!record || record.isRevoked || record.expiresAt.getTime() <= now.getTime()) {
      return null;
    }
    this.refreshTokens.set(token, { ...record, isRevoked: true });
    return { ...record };
  }

  async createRefreshToken(
    userId: string,
    deviceId: string,
    token: string,
    expiresAt: Date,
  ): Promise<IdentityRefreshToken> {
    const record: IdentityRefreshToken = {
      id: this.nextId(),
      userId,
      deviceId,
      token,
      expiresAt,
      isRevoked: false,
      createdAt: new Date(),
    };
    this.refreshTokens.set(token, record);
    return { ...record };
  }
}

function makeHandler(
  store: IdentityStore = new MemoryIdentityStore(),
  overrides: Partial<IdentityConfig> = {},
): ReturnType<typeof createIdentityHandler> {
  const options: IdentityHandlerOptions = {
    config: { ...TEST_CONFIG, ...overrides },
    getStore: async () => store,
  };
  return createIdentityHandler(options);
}

function apiUrl(path: string): string {
  return `https://stash.test${path}`;
}

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function postJson(
  handler: ReturnType<typeof createIdentityHandler>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handler.fetch(jsonRequest(path, body, headers));
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function readPair(response: Response): Promise<TokenPair> {
  assert.equal(response.status, 200);
  const body = (await response.json()) as TokenPair;
  assert.deepEqual(Object.keys(body).sort(), [
    'accessToken',
    'deviceId',
    'expiresAt',
    'refreshToken',
    'userId',
  ]);
  return body;
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: unknown };
  assert.deepEqual(Object.keys(body), ['error']);
  assert.equal(typeof body.error, 'string');
  return body.error as string;
}

async function register(
  handler: ReturnType<typeof createIdentityHandler>,
  email = 'user@example.com',
  password = 'Password123!',
  deviceId = 'device-1',
): Promise<TokenPair> {
  return readPair(await postJson(handler, '/api/auth/register', { email, password, deviceId }));
}

function expectHttpError(action: () => unknown, status: number): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, status);
    return true;
  });
}

test('health returns 200 without touching the store', async () => {
  const store = new MemoryIdentityStore();
  let storeRequests = 0;
  const handler = createIdentityHandler({
    config: TEST_CONFIG,
    getStore: async () => {
      storeRequests += 1;
      return store;
    },
  });

  const response = await handler.fetch(new Request(apiUrl('/api/auth/health')));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');

  const body = (await response.json()) as { status?: string; timestamp?: string };
  assert.equal(body.status, 'healthy');
  assert.equal(typeof body.timestamp, 'string');
  assert.ok(!Number.isNaN(Date.parse(body.timestamp ?? '')));
  assert.equal(storeRequests, 0);
  assert.equal(store.ensureIndexesCalls, 0);
});

test('register returns a token pair, normalizes email, and stores the device', async () => {
  const store = new MemoryIdentityStore();
  const handler = makeHandler(store);

  const pair = await register(handler, '  User@Example.com ', 'Password123!', 'device-1');

  assert.equal(typeof pair.accessToken, 'string');
  assert.equal(typeof pair.refreshToken, 'string');
  assert.equal(pair.userId.length > 0, true);
  assert.equal(pair.deviceId, 'device-1');
  const expiresAt = Date.parse(pair.expiresAt);
  assert.ok(!Number.isNaN(expiresAt));
  assert.ok(expiresAt > Date.now());

  const stored = store.usersByEmail.get('user@example.com');
  assert.ok(stored);
  assert.equal(stored.email, 'user@example.com');
  assert.ok(stored.passwordHash.startsWith('pbkdf2-sha256$100000$'));
  assert.equal(await verifyPassword('Password123!', stored.passwordHash), true);
  assert.ok(store.devices.has(`${pair.userId}|device-1`));
});

test('register and login trim surrounding whitespace in deviceId', async () => {
  const store = new MemoryIdentityStore();
  const handler = makeHandler(store);

  const registered = await register(
    handler,
    'user@example.com',
    'Password123!',
    '  device-1  ',
  );
  assert.equal(registered.deviceId, 'device-1');
  assert.equal(verifyAccessToken(registered.accessToken, TEST_CONFIG).deviceId, 'device-1');
  assert.ok(store.devices.has(`${registered.userId}|device-1`));
  assert.equal(store.devices.has(`${registered.userId}|  device-1  `), false);

  const login = await postJson(handler, '/api/auth/login', {
    email: 'user@example.com',
    password: 'Password123!',
    deviceId: '\tdevice-2\n',
  });
  const pair = await readPair(login);
  assert.equal(pair.deviceId, 'device-2');
  assert.equal(verifyAccessToken(pair.accessToken, TEST_CONFIG).deviceId, 'device-2');
  assert.ok(store.devices.has(`${pair.userId}|device-2`));
});

test('duplicate registration is rejected case-insensitively with a flat error', async () => {
  const handler = makeHandler();

  await register(handler, 'User@Example.com');
  const response = await postJson(handler, '/api/auth/register', {
    email: 'user@example.com',
    password: 'Password123!',
    deviceId: 'device-2',
  });

  assert.equal(response.status, 409);
  assert.equal(await readError(response), 'A user with this email already exists');
});

test('register validation rejects bad email, short password, and missing device', async () => {
  const handler = makeHandler();

  const invalidEmail = await postJson(handler, '/api/auth/register', {
    email: 'not-an-email',
    password: 'Password123!',
    deviceId: 'device-1',
  });
  assert.equal(invalidEmail.status, 400);
  assert.equal(await readError(invalidEmail), 'Email is not valid');

  const shortPassword = await postJson(handler, '/api/auth/register', {
    email: 'user@example.com',
    password: 'short',
    deviceId: 'device-1',
  });
  assert.equal(shortPassword.status, 400);
  assert.equal(await readError(shortPassword), 'Password must be at least 8 characters');

  const missingDevice = await postJson(handler, '/api/auth/register', {
    email: 'user@example.com',
    password: 'Password123!',
  });
  assert.equal(missingDevice.status, 400);
  assert.equal(await readError(missingDevice), 'Device ID is required');
});

test('login succeeds, rejects a bad password, and auto-registers new devices', async () => {
  const store = new MemoryIdentityStore();
  const handler = makeHandler(store);
  const registered = await register(handler);

  const login = await postJson(handler, '/api/auth/login', {
    email: 'user@example.com',
    password: 'Password123!',
    deviceId: 'device-1',
  });
  assert.equal((await readPair(login)).userId, registered.userId);

  const badPassword = await postJson(handler, '/api/auth/login', {
    email: 'user@example.com',
    password: 'WrongPassword!',
    deviceId: 'device-1',
  });
  assert.equal(badPassword.status, 401);
  assert.equal(await readError(badPassword), 'Invalid email or password');

  const newDevice = await postJson(handler, '/api/auth/login', {
    email: 'user@example.com',
    password: 'Password123!',
    deviceId: 'device-2',
  });
  assert.equal((await readPair(newDevice)).deviceId, 'device-2');
  assert.ok(store.devices.has(`${registered.userId}|device-2`));
});

test('login rejects a revoked device', async () => {
  const store = new MemoryIdentityStore();
  const handler = makeHandler(store);
  const pair = await register(handler);

  await store.revokeDevice(pair.userId, 'device-1');

  const response = await postJson(handler, '/api/auth/login', {
    email: 'user@example.com',
    password: 'Password123!',
    deviceId: 'device-1',
  });
  assert.equal(response.status, 401);
  assert.equal(await readError(response), 'Device has been revoked');
});

test('refresh rotates the token and rejects reuse or unknown tokens', async () => {
  const handler = makeHandler();
  const pair = await register(handler);

  const refreshed = await readPair(
    await postJson(handler, '/api/auth/refresh', { refreshToken: pair.refreshToken }),
  );
  assert.notEqual(refreshed.refreshToken, pair.refreshToken);
  assert.equal(refreshed.userId, pair.userId);
  assert.equal(refreshed.deviceId, pair.deviceId);

  const reuse = await postJson(handler, '/api/auth/refresh', {
    refreshToken: pair.refreshToken,
  });
  assert.equal(reuse.status, 401);
  assert.equal(await readError(reuse), 'Invalid or expired refresh token');

  const unknown = await postJson(handler, '/api/auth/refresh', {
    refreshToken: 'not-a-real-token',
  });
  assert.equal(unknown.status, 401);
  assert.equal(await readError(unknown), 'Invalid or expired refresh token');

  const missing = await postJson(handler, '/api/auth/refresh', {});
  assert.equal(missing.status, 400);
  assert.equal(await readError(missing), 'Refresh token is required');
});

test('login rejects oversized credentials without store lookups', async () => {
  const store = new MemoryIdentityStore();
  const handler = makeHandler(store);

  const oversizedPassword = await postJson(handler, '/api/auth/login', {
    email: 'user@example.com',
    password: 'a'.repeat(1_025),
    deviceId: 'device-1',
  });
  assert.equal(oversizedPassword.status, 400);
  assert.equal(await readError(oversizedPassword), 'Password is too long.');
  assert.equal(store.findUserByEmailCalls, 0);

  const oversizedToken = await postJson(handler, '/api/auth/refresh', {
    refreshToken: 'a'.repeat(513),
  });
  assert.equal(oversizedToken.status, 401);
  assert.equal(await readError(oversizedToken), 'Invalid or expired refresh token');
  assert.equal(store.consumeRefreshTokenCalls, 0);
});

test('revoke requires a bearer token and invalidates refresh tokens for that device only', async () => {
  const handler = makeHandler();
  const owner = await register(handler, 'owner@example.com', 'Password123!', 'shared-device');

  const noBearer = await postJson(handler, '/api/auth/revoke', { deviceId: 'shared-device' });
  assert.equal(noBearer.status, 401);
  assert.equal(
    await readError(noBearer),
    'Authorization: Bearer <token> is required.',
  );

  const noBearerOrBody = await handler.fetch(
    new Request(apiUrl('/api/auth/revoke'), { method: 'POST' }),
  );
  assert.equal(noBearerOrBody.status, 401);
  assert.equal(
    await readError(noBearerOrBody),
    'Authorization: Bearer <token> is required.',
  );

  const missingDevice = await postJson(
    handler,
    '/api/auth/revoke',
    {},
    bearer(owner.accessToken),
  );
  assert.equal(missingDevice.status, 400);
  assert.equal(await readError(missingDevice), 'Device ID is required');

  const revoked = await postJson(
    handler,
    '/api/auth/revoke',
    { deviceId: 'shared-device' },
    bearer(owner.accessToken),
  );
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), { message: 'Device revoked successfully' });

  const refreshAfterRevoke = await postJson(handler, '/api/auth/refresh', {
    refreshToken: owner.refreshToken,
  });
  assert.equal(refreshAfterRevoke.status, 401);
  assert.equal(await readError(refreshAfterRevoke), 'Invalid or expired refresh token');

  const other = await register(handler, 'other@example.com', 'Password123!', 'shared-device');
  const otherLogin = await postJson(handler, '/api/auth/login', {
    email: 'other@example.com',
    password: 'Password123!',
    deviceId: 'shared-device',
  });
  assert.equal((await readPair(otherLogin)).userId, other.userId);
});

test('access tokens validate with the shared verifier and reject tampering', async () => {
  const handler = makeHandler();
  const pair = await register(handler);

  const auth = verifyAccessToken(pair.accessToken, TEST_CONFIG);
  assert.equal(auth.userId, pair.userId);
  assert.equal(auth.deviceId, 'device-1');
  assert.equal(auth.token, pair.accessToken);

  const [header, payload, signature] = pair.accessToken.split('.') as [
    string,
    string,
    string,
  ];
  const tamperedSignature = `${signature.charAt(0) === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  const tampered = `${header}.${payload}.${tamperedSignature}`;
  expectHttpError(() => verifyAccessToken(tampered, TEST_CONFIG), 401);
});

test('password hashing verifies correct and wrong passwords and remains .NET compatible', async () => {
  const hash = await hashPassword('Password123!');
  assert.match(hash, /^pbkdf2-sha256\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(await verifyPassword('Password123!', hash), true);
  assert.equal(await verifyPassword('WrongPassword!', hash), false);
  assert.equal(await verifyPassword('Password123!', 'not-a-hash'), false);

  const salt = Buffer.from('0123456789abcdef', 'utf8');
  const key = pbkdf2Sync('correct horse battery staple', salt, 100_000, 32, 'sha256');
  const dotNetHash = `pbkdf2-sha256$100000$${salt.toString('base64')}$${key.toString('base64')}`;
  assert.equal(await verifyPassword('correct horse battery staple', dotNetHash), true);
  assert.equal(await verifyPassword('wrong', dotNetHash), false);

  assert.match(
    DUMMY_PASSWORD_HASH,
    /^pbkdf2-sha256\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/,
  );
  assert.equal(
    await verifyPassword('stash-identity-dummy-password', DUMMY_PASSWORD_HASH),
    true,
  );
  assert.equal(await verifyPassword('anything', DUMMY_PASSWORD_HASH), false);
});

test('CORS preflight reflects allowed origins and omits disallowed ones', async () => {
  const handler = makeHandler(new MemoryIdentityStore(), {
    corsOrigins: ['https://app.example.com'],
  });

  const allowed = await handler.fetch(
    new Request(apiUrl('/api/auth/login'), {
      method: 'OPTIONS',
      headers: { Origin: 'https://app.example.com' },
    }),
  );
  assert.equal(allowed.status, 204);
  assert.equal(
    allowed.headers.get('access-control-allow-origin'),
    'https://app.example.com',
  );
  assert.equal(allowed.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');

  const disallowed = await handler.fetch(
    new Request(apiUrl('/api/auth/login'), {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com' },
    }),
  );
  assert.equal(disallowed.status, 204);
  assert.equal(disallowed.headers.get('access-control-allow-origin'), null);
});

test('unknown routes, wrong methods, and oversized bodies use the flat envelope', async () => {
  const handler = makeHandler();

  const unknown = await postJson(handler, '/api/auth/unknown', {});
  assert.equal(unknown.status, 404);
  assert.equal(await readError(unknown), 'Not found.');

  const wrongMethod = await handler.fetch(
    new Request(apiUrl('/api/auth/login'), { method: 'GET' }),
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(await readError(wrongMethod), 'Method not allowed.');

  const smallBodyHandler = makeHandler(new MemoryIdentityStore(), { maxBodyBytes: 1_024 });
  const oversized = await postJson(smallBodyHandler, '/api/auth/register', {
    email: 'user@example.com',
    password: 'a'.repeat(2_000),
    deviceId: 'device-1',
  });
  assert.equal(oversized.status, 413);
  assert.equal(typeof (await readError(oversized)), 'string');
});

test('missing configuration returns a generic 500 without exposing env names', async () => {
  const originalMongoUri = process.env.MONGODB_URI;
  const originalSigningKey = process.env.JWT_SIGNING_KEY;
  delete process.env.MONGODB_URI;
  delete process.env.JWT_SIGNING_KEY;

  try {
    const handler = createIdentityHandler();
    const response = await postJson(handler, '/api/auth/register', {
      email: 'user@example.com',
      password: 'Password123!',
      deviceId: 'device-1',
    });
    assert.equal(response.status, 500);
    const message = await readError(response);
    assert.equal(message, 'Identity API is not configured correctly.');
    assert.equal(message.includes('MONGODB_URI'), false);
    assert.equal(message.includes('JWT_SIGNING_KEY'), false);
  } finally {
    if (originalMongoUri === undefined) {
      delete process.env.MONGODB_URI;
    } else {
      process.env.MONGODB_URI = originalMongoUri;
    }
    if (originalSigningKey === undefined) {
      delete process.env.JWT_SIGNING_KEY;
    } else {
      process.env.JWT_SIGNING_KEY = originalSigningKey;
    }
  }
});
