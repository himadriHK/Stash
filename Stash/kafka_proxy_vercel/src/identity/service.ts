/**
 * Identity business logic: registration, login, atomic refresh rotation, and
 * device revocation. Errors carry the HTTP status the handler must return.
 */
import { randomBytes } from 'node:crypto';

import type { IdentityConfig } from './config.ts';
import { signAccessToken } from './jwt.ts';
import type { IdentityUser, TokenPair } from './models.ts';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './password.ts';
import { EmailAlreadyRegisteredError, type IdentityStore } from './store.ts';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
const MAX_EMAIL_LENGTH = 320;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1_024;
const MAX_DEVICE_LENGTH = 256;
const MAX_REFRESH_TOKEN_LENGTH = 512;

export class IdentityValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'IdentityValidationError';
  }
}

export class IdentityConflictError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = 'IdentityConflictError';
  }
}

export class IdentityUnauthorizedError extends Error {
  readonly status = 401;

  constructor(message: string) {
    super(message);
    this.name = 'IdentityUnauthorizedError';
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeDeviceId(deviceId: string): string {
  return deviceId.trim();
}

function isEmailValid(email: string): boolean {
  return email.length > 0 && email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email);
}

export class IdentityService {
  private readonly store: IdentityStore;
  private readonly config: IdentityConfig;

  constructor(store: IdentityStore, config: IdentityConfig) {
    this.store = store;
    this.config = config;
  }

  async register(email: string, password: string, deviceId: string): Promise<TokenPair> {
    const normalizedDeviceId = normalizeDeviceId(deviceId);

    if (!email.trim() || !password.trim()) {
      throw new IdentityValidationError('Email and password are required');
    }
    if (!normalizedDeviceId) {
      throw new IdentityValidationError('Device ID is required');
    }

    const normalizedEmail = normalizeEmail(email);
    if (!isEmailValid(normalizedEmail)) {
      throw new IdentityValidationError('Email is not valid');
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new IdentityValidationError('Password must be at least 8 characters');
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      throw new IdentityValidationError('Password must be at most 1024 characters');
    }
    if (normalizedDeviceId.length > MAX_DEVICE_LENGTH) {
      throw new IdentityValidationError('Device ID is not valid');
    }

    const existing = await this.store.findUserByEmail(normalizedEmail);
    if (existing) {
      throw new IdentityConflictError('A user with this email already exists');
    }

    const passwordHash = await hashPassword(password);
    let user: IdentityUser;
    try {
      user = await this.store.createUser(normalizedEmail, passwordHash);
    } catch (error) {
      if (error instanceof EmailAlreadyRegisteredError) {
        throw new IdentityConflictError('A user with this email already exists');
      }
      throw error;
    }

    await this.store.ensureDevice(user.id, normalizedDeviceId);
    return this.issueTokens(user.id, user.email, normalizedDeviceId);
  }

  async login(email: string, password: string, deviceId: string): Promise<TokenPair> {
    const normalizedDeviceId = normalizeDeviceId(deviceId);

    if (!email.trim() || !password.trim() || !normalizedDeviceId) {
      throw new IdentityValidationError('Email, password and device ID are required');
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      throw new IdentityValidationError('Password is too long.');
    }
    if (normalizedDeviceId.length > MAX_DEVICE_LENGTH) {
      throw new IdentityValidationError('Device ID is not valid');
    }

    const normalizedEmail = normalizeEmail(email);
    const user = await this.store.findUserByEmail(normalizedEmail);
    const passwordHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const passwordValid = await verifyPassword(password, passwordHash);

    if (!user || !user.isActive || !passwordValid) {
      throw new IdentityUnauthorizedError('Invalid email or password');
    }

    let device = await this.store.findDevice(user.id, normalizedDeviceId);
    if (!device) {
      device = await this.store.ensureDevice(user.id, normalizedDeviceId);
    }
    if (device.isRevoked) {
      throw new IdentityUnauthorizedError('Device has been revoked');
    }

    return this.issueTokens(user.id, user.email, normalizedDeviceId);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    if (!refreshToken.trim()) {
      throw new IdentityValidationError('Refresh token is required');
    }
    if (refreshToken.length > MAX_REFRESH_TOKEN_LENGTH) {
      throw new IdentityUnauthorizedError('Invalid or expired refresh token');
    }

    const claimed = await this.store.consumeRefreshToken(refreshToken, new Date());
    if (!claimed) {
      throw new IdentityUnauthorizedError('Invalid or expired refresh token');
    }

    const user = await this.store.findUserById(claimed.userId);
    if (!user || !user.isActive) {
      throw new IdentityUnauthorizedError('User not found or inactive');
    }

    const device = await this.store.findDevice(user.id, claimed.deviceId);
    if (!device || device.isRevoked) {
      throw new IdentityUnauthorizedError('Device not found or revoked');
    }

    return this.issueTokens(user.id, user.email, claimed.deviceId);
  }

  async revoke(userId: string, deviceId: string): Promise<void> {
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    if (!normalizedDeviceId) {
      throw new IdentityValidationError('Device ID is required');
    }
    if (normalizedDeviceId.length > MAX_DEVICE_LENGTH) {
      throw new IdentityValidationError('Device ID is not valid');
    }
    await this.store.revokeDevice(userId, normalizedDeviceId);
  }

  private async issueTokens(
    userId: string,
    email: string,
    deviceId: string,
  ): Promise<TokenPair> {
    const signed = signAccessToken({ userId, email, deviceId }, this.config);
    const refreshToken = randomBytes(64).toString('base64');
    const refreshExpiresAt = new Date(
      Date.now() + this.config.refreshTokenExpiryDays * 86_400_000,
    );

    await this.store.createRefreshToken(
      userId,
      deviceId,
      refreshToken,
      refreshExpiresAt,
    );

    return {
      accessToken: signed.token,
      refreshToken,
      expiresAt: signed.expiresAt.toISOString(),
      userId,
      deviceId,
    };
  }
}
