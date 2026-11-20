/** Token pair and result models transcribed from Stash.Maui/Auth/AuthModels.cs */

export interface JwtToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  userId: string;
  deviceId: string;
}

export interface AuthResult {
  isSuccess: boolean;
  token?: JwtToken;
  error?: string;
}

export function authSuccess(token: JwtToken): AuthResult {
  return { isSuccess: true, token };
}

export function authFailed(error: string): AuthResult {
  return { isSuccess: false, error };
}

export interface CredentialsRequest {
  email: string;
  password: string;
  deviceId: string;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface RevokeRequest {
  deviceId: string;
}

/**
 * Parses the Identity API `expiresAt` value. The server may send an ISO-8601
 * string or an epoch number (seconds or milliseconds).
 */
export function parseExpiresAt(value: unknown): Date | null {
  if (typeof value === 'number') {
    const millis = value < 1e12 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}
