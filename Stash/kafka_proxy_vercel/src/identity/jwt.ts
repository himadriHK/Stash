/** HS256 access-token signing using node:crypto, matching the .NET Identity API. */
import { createHmac, randomUUID } from 'node:crypto';

import type { IdentityConfig } from './config.ts';

export interface JwtIdentity {
  userId: string;
  email: string;
  deviceId: string;
}

export interface SignedAccessToken {
  token: string;
  expiresAt: Date;
}

export function signAccessToken(
  identity: JwtIdentity,
  config: IdentityConfig,
  now: Date = new Date(),
): SignedAccessToken {
  const issuedAtSeconds = Math.floor(now.getTime() / 1_000);
  const expiresAt = new Date(
    now.getTime() + config.accessTokenExpiryMinutes * 60_000,
  );

  const claims = {
    nameid: identity.userId,
    userId: identity.userId,
    sub: identity.userId,
    email: identity.email,
    deviceId: identity.deviceId,
    device_id: identity.deviceId,
    jti: randomUUID(),
    iat: issuedAtSeconds,
    nbf: issuedAtSeconds,
    exp: Math.floor(expiresAt.getTime() / 1_000),
    iss: config.jwtIssuer,
    aud: config.jwtAudience,
  };

  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', config.jwtSigningKey)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return { token: `${header}.${payload}.${signature}`, expiresAt };
}
