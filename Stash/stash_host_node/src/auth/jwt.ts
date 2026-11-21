import { errors, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';

import type { AppEnv } from '../config/env';
import { isSafeUserId } from '../contracts/request';

export type JwtErrorCode = 'jwt_missing' | 'jwt_invalid' | 'jwt_claim_missing';

export class JwtError extends Error {
  readonly code: JwtErrorCode;

  constructor(code: JwtErrorCode, message: string) {
    super(message);
    this.name = 'JwtError';
    this.code = code;
  }
}

export type HeaderValue = string | string[] | Buffer | undefined;

export type HeaderRecord = Record<string, HeaderValue>;

export type HeadersLike = HeaderRecord | Headers;

export interface VerifiedIdentity {
  userId: string;
  deviceId: string;
  payload: JWTPayload;
}

const USER_ID_CLAIMS = ['userId', 'nameid', 'sub', 'ClaimTypes.NameIdentifier'] as const;
const DEVICE_ID_CLAIMS = ['deviceId', 'device_id'] as const;
const SAFE_DEVICE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function headerValueToString(value: HeaderValue): string | null {
  if (value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (Buffer.isBuffer(value)) {
    const trimmed = value.toString('utf8').trim();
    return trimmed === '' ? null : trimmed;
  }
  for (const entry of value) {
    const trimmed = entry.trim();
    if (trimmed !== '') return trimmed;
  }
  return null;
}

export function readHeaderValue(headers: HeadersLike | undefined, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) {
    return headerValueToString(headers.get(name) ?? undefined);
  }

  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return headerValueToString(value);
    }
  }
  return null;
}

function extractBearerToken(value: string | null): string {
  if (!value) {
    throw new JwtError('jwt_missing', 'Authorization header is required.');
  }
  const match = /^Bearer\s+(.+)$/i.exec(value);
  const token = match?.[1]?.trim() ?? value.trim();
  if (token === '') {
    throw new JwtError('jwt_missing', 'Authorization token is required.');
  }
  return token;
}

function firstStringClaim(payload: JWTPayload, names: readonly string[]): string | null {
  for (const name of names) {
    const value = payload[name];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed !== '') return trimmed;
    }
  }
  return null;
}

export async function verifyToken(token: string, env: AppEnv): Promise<VerifiedIdentity> {
  const secret = new TextEncoder().encode(env.JWT_SIGNING_KEY);
  let payload: JWTPayload;

  try {
    const result = await jwtVerify(token, secret, {
      algorithms: ['HS256'],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      clockTolerance: env.JWT_CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ['exp'],
    });
    payload = result.payload;
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      throw new JwtError('jwt_invalid', 'Authorization token is invalid or expired.');
    }
    throw new JwtError('jwt_invalid', 'Authorization token is invalid.');
  }

  const userId = firstStringClaim(payload, USER_ID_CLAIMS);
  if (!userId) {
    throw new JwtError('jwt_claim_missing', 'Authorization token is missing a user identity.');
  }
  if (!isSafeUserId(userId)) {
    throw new JwtError('jwt_invalid', 'Authorization token has an invalid user identity.');
  }

  const deviceId = firstStringClaim(payload, DEVICE_ID_CLAIMS);
  if (!deviceId) {
    throw new JwtError('jwt_claim_missing', 'Authorization token is missing a device identity.');
  }
  if (!SAFE_DEVICE_PATTERN.test(deviceId)) {
    throw new JwtError('jwt_invalid', 'Authorization token has an invalid device identity.');
  }

  return { userId, deviceId, payload };
}

export async function verifyAuthorizationHeader(
  headers: HeadersLike | undefined,
  env: AppEnv,
): Promise<VerifiedIdentity> {
  const token = extractBearerToken(readHeaderValue(headers, 'authorization'));
  return verifyToken(token, env);
}

