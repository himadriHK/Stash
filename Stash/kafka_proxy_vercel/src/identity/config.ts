/**
 * Identity API configuration loaded from Vercel environment variables.
 *
 * This loader is intentionally separate from the Kafka proxy config: the auth
 * function must deploy without any KAFKA_* variables.
 */
import { clampInt, parseCorsOrigins } from '../http.ts';

export interface IdentityConfig {
  mongoUri: string;
  mongoDatabase: string;
  jwtSigningKey: string;
  jwtIssuer: string;
  jwtAudience: string;
  accessTokenExpiryMinutes: number;
  refreshTokenExpiryDays: number;
  corsOrigins: '*' | string[];
  maxBodyBytes: number;
}

/** Thrown when a required Identity setting is missing or invalid. */
export class IdentityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityConfigError';
  }
}

export function loadIdentityConfig(env: NodeJS.ProcessEnv): IdentityConfig {
  const mongoUri = (env.MONGODB_URI ?? '').trim();
  if (!mongoUri) {
    throw new IdentityConfigError('MONGODB_URI is required.');
  }

  const jwtSigningKey = env.JWT_SIGNING_KEY ?? '';
  if (jwtSigningKey.length === 0) {
    throw new IdentityConfigError('JWT_SIGNING_KEY is required.');
  }

  return {
    mongoUri,
    mongoDatabase: (env.MONGODB_DATABASE ?? 'stash').trim() || 'stash',
    jwtSigningKey,
    jwtIssuer: (env.JWT_ISSUER ?? 'stash-auth').trim() || 'stash-auth',
    jwtAudience: (env.JWT_AUDIENCE ?? 'stash-app').trim() || 'stash-app',
    accessTokenExpiryMinutes: clampInt(env.AUTH_ACCESS_TOKEN_EXPIRY_MINUTES, 15, 1, 1_440),
    refreshTokenExpiryDays: clampInt(env.AUTH_REFRESH_TOKEN_EXPIRY_DAYS, 7, 1, 365),
    corsOrigins: parseCorsOrigins(env.CORS_ALLOWED_ORIGINS),
    maxBodyBytes: clampInt(env.AUTH_MAX_BODY_BYTES, 65_536, 1_024, 1_048_576),
  };
}
