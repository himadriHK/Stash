/**
 * Access-token verification.
 *
 * StashHost.IdentityApi signs HS256 access tokens with Auth:Jwt:SigningKey, so
 * the function only needs node:crypto — no JWT dependency and no Kafka
 * credentials on the device.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { HttpError } from './http.ts';

const CLOCK_SKEW_SECONDS = 30;

export interface JwtVerificationConfig {
  jwtSigningKey: string;
  jwtIssuer: string;
  jwtAudience: string;
}

export interface AuthContext {
  userId: string;
  deviceId: string;
  /** The raw bearer token, replayed as the Kafka record's Authorization header. */
  token: string;
}

function decodeSegment(segment: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new HttpError(401, 'invalid_token', `Token ${label} is not valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(401, 'invalid_token', `Token ${label} is not a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function numericClaim(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringClaim(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function audienceMatches(claim: unknown, expected: string): boolean {
  if (typeof claim === 'string') {
    return claim === expected;
  }
  if (Array.isArray(claim)) {
    return claim.some((entry) => typeof entry === 'string' && entry === expected);
  }
  return false;
}

/** Verifies signature, algorithm, issuer, audience and lifetime, then extracts the identity. */
export function verifyAccessToken(token: string, config: JwtVerificationConfig): AuthContext {
  if (!token) {
    throw new HttpError(401, 'invalid_token', 'A bearer access token is required.');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new HttpError(401, 'invalid_token', 'Access token is not a signed JWT.');
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  const header = decodeSegment(headerSegment, 'header');
  if (header.alg !== 'HS256') {
    throw new HttpError(401, 'invalid_token', 'Access token must use HS256.');
  }

  const expected = createHmac('sha256', config.jwtSigningKey)
    .update(`${headerSegment}.${payloadSegment}`)
    .digest();
  const actual = Buffer.from(signatureSegment, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new HttpError(401, 'invalid_token', 'Access token signature is invalid.');
  }

  const claims = decodeSegment(payloadSegment, 'payload');
  const now = Math.floor(Date.now() / 1000);

  const expiresAt = numericClaim(claims.exp);
  if (expiresAt === null) {
    throw new HttpError(401, 'invalid_token', 'Access token has no expiry.');
  }
  if (expiresAt + CLOCK_SKEW_SECONDS <= now) {
    throw new HttpError(401, 'token_expired', 'Access token has expired.');
  }

  const notBefore = numericClaim(claims.nbf);
  if (notBefore !== null && notBefore - CLOCK_SKEW_SECONDS > now) {
    throw new HttpError(401, 'invalid_token', 'Access token is not valid yet.');
  }

  if (stringClaim(claims.iss) !== config.jwtIssuer) {
    throw new HttpError(401, 'invalid_token', 'Access token issuer is not trusted.');
  }
  if (!audienceMatches(claims.aud, config.jwtAudience)) {
    throw new HttpError(401, 'invalid_token', 'Access token audience is not trusted.');
  }

  const userId = stringClaim(claims.userId) || stringClaim(claims.sub);
  const deviceId = stringClaim(claims.deviceId) || stringClaim(claims.device_id);
  if (!userId) {
    throw new HttpError(401, 'invalid_token', 'Access token has no user identity.');
  }
  if (!deviceId) {
    throw new HttpError(401, 'invalid_token', 'Access token has no device identity.');
  }

  return { userId, deviceId, token };
}

export function readBearerToken(request: Request): string {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    throw new HttpError(401, 'invalid_token', 'Authorization: Bearer <token> is required.');
  }
  return (match[1] ?? '').trim();
}
