/**
 * Identity API client with SecureStorage-backed token persistence.
 * Mirrors Stash.Maui/Auth/AuthenticationService.cs.
 */
import { appConfig, identityApiBaseUrl, resolveUrl } from '../config/appConfig';
import {
  authFailed,
  authSuccess,
  parseExpiresAt,
  type AuthResult,
  type JwtToken,
} from '../models/authModels';
import { compactUuid, uuid } from '../utils/id';
import { getAsync, removeAsync, setAsync } from '../utils/storage';

export const ACCESS_TOKEN_KEY = 'stash.auth.access_token';
export const REFRESH_TOKEN_KEY = 'stash.auth.refresh_token';
export const EXPIRES_AT_KEY = 'stash.auth.expires_at';
export const USER_ID_KEY = 'stash.auth.user_id';
export const DEVICE_ID_KEY = 'stash.auth.device_id';

const EXPIRY_MARGIN_MS = 60_000;

let refreshInFlight: Promise<boolean> | null = null;

function requestTimeoutMs(): number {
  const seconds = appConfig.IdentityApiTimeoutSeconds;
  return (seconds > 0 ? seconds : 30) * 1000;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the Identity API error envelope ({error} | {title}) or a status phrase. */
async function readErrorAsync(response: Response): Promise<string | null> {
  try {
    const body = await response.text();
    if (!body || body.trim().length === 0) {
      return null;
    }
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.error === 'string' && parsed.error.length > 0) {
        return parsed.error;
      }
      if (typeof parsed.title === 'string' && parsed.title.length > 0) {
        return parsed.title;
      }
    }
  } catch {
    // Not a JSON body; fall through to the status-based message.
  }
  return null;
}

function normalizeToken(raw: Record<string, unknown>): JwtToken | null {
  const accessToken = typeof raw.accessToken === 'string' ? raw.accessToken : '';
  const refreshToken = typeof raw.refreshToken === 'string' ? raw.refreshToken : '';
  if (!accessToken || !refreshToken) {
    return null;
  }
  const expiresAt = parseExpiresAt(raw.expiresAt);
  return {
    accessToken,
    refreshToken,
    expiresAt: expiresAt ? expiresAt.toISOString() : '',
    userId: typeof raw.userId === 'string' ? raw.userId : '',
    deviceId: typeof raw.deviceId === 'string' ? raw.deviceId : '',
  };
}

async function persistTokenAsync(token: JwtToken): Promise<void> {
  if (!token.accessToken || !token.refreshToken) {
    throw new Error('The identity service returned an incomplete token pair.');
  }
  await setAsync(ACCESS_TOKEN_KEY, token.accessToken);
  await setAsync(REFRESH_TOKEN_KEY, token.refreshToken);
  await setAsync(EXPIRES_AT_KEY, token.expiresAt);
  await setAsync(USER_ID_KEY, token.userId);
  if (token.deviceId) {
    await setAsync(DEVICE_ID_KEY, token.deviceId);
  }
}

/** Clears the session but keeps the device ID (stable installation id, not a credential). */
export async function clearSessionAsync(): Promise<void> {
  await removeAsync(ACCESS_TOKEN_KEY);
  await removeAsync(REFRESH_TOKEN_KEY);
  await removeAsync(EXPIRES_AT_KEY);
  await removeAsync(USER_ID_KEY);
}

async function authenticateAsync(path: string, credentials: {
  email: string;
  password: string;
  deviceId: string;
}): Promise<AuthResult> {
  if (!credentials.email || !credentials.password || !credentials.deviceId) {
    return authFailed('Email, password and device ID are required.');
  }

  const base = identityApiBaseUrl();
  if (!base) {
    return authFailed('Identity API base URL is not configured.');
  }

  const response = await fetchWithTimeout(
    resolveUrl(base, path),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    },
    requestTimeoutMs(),
  );

  if (!response.ok) {
    const error =
      (await readErrorAsync(response)) ??
      response.statusText ??
      `Request failed (${response.status}).`;
    return authFailed(error || `Request failed (${response.status}).`);
  }

  let token: JwtToken | null = null;
  try {
    const text = await response.text();
    if (text.trim().length > 0) {
      token = normalizeToken(JSON.parse(text) as Record<string, unknown>);
    }
  } catch {
    token = null;
  }

  if (!token) {
    return authFailed('The identity service returned an invalid response.');
  }

  await persistTokenAsync(token);
  return authSuccess(token);
}

export function registerAsync(email: string, password: string, deviceId: string): Promise<AuthResult> {
  return authenticateAsync('api/auth/register', { email, password, deviceId });
}

export function loginAsync(email: string, password: string, deviceId: string): Promise<AuthResult> {
  return authenticateAsync('api/auth/login', { email, password, deviceId });
}

export async function getAccessTokenAsync(): Promise<string> {
  return (await getAsync(ACCESS_TOKEN_KEY)) ?? '';
}

export async function getRefreshTokenAsync(): Promise<string> {
  return (await getAsync(REFRESH_TOKEN_KEY)) ?? '';
}

export async function getUserIdAsync(): Promise<string> {
  return (await getAsync(USER_ID_KEY)) ?? '';
}

/** Returns true when a valid (or refreshable) access token is available. */
export async function ensureValidAccessTokenAsync(): Promise<boolean> {
  const accessToken = await getAccessTokenAsync();
  if (!accessToken) {
    return refreshTokenAsync();
  }

  const expiresAtValue = await getAsync(EXPIRES_AT_KEY);
  const expiresAt = expiresAtValue ? parseExpiresAt(expiresAtValue) : null;
  if (expiresAt && expiresAt.getTime() > Date.now() + EXPIRY_MARGIN_MS) {
    return true;
  }
  return refreshTokenAsync();
}

async function performRefreshTokenAsync(): Promise<boolean> {
  const refreshToken = await getRefreshTokenAsync();
  if (!refreshToken) {
    return false;
  }

  const base = identityApiBaseUrl();
  if (!base) {
    return false;
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(
      resolveUrl(base, 'api/auth/refresh'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      },
      requestTimeoutMs(),
    );
  } catch {
    return false;
  }

  if (!response.ok) {
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      await clearSessionAsync();
    }
    return false;
  }

  let token: JwtToken | null = null;
  try {
    const text = await response.text();
    if (text.trim().length > 0) {
      token = normalizeToken(JSON.parse(text) as Record<string, unknown>);
    }
  } catch {
    token = null;
  }

  if (!token) {
    await clearSessionAsync();
    return false;
  }

  await persistTokenAsync(token);
  return true;
}

export function refreshTokenAsync(): Promise<boolean> {
  if (refreshInFlight) {
    return refreshInFlight;
  }
  let promise: Promise<boolean>;
  promise = performRefreshTokenAsync().finally(() => {
    if (refreshInFlight === promise) {
      refreshInFlight = null;
    }
  });
  refreshInFlight = promise;
  return promise;
}

export async function logoutAsync(): Promise<void> {
  await clearSessionAsync();
}

/** Revokes the given device server-side; clears the session for the current device. */
export async function revokeDeviceAsync(deviceId: string): Promise<boolean> {
  if (!deviceId) {
    return false;
  }
  const base = identityApiBaseUrl();
  if (!base) {
    return false;
  }

  const accessToken = await getAccessTokenAsync();
  if (!accessToken) {
    return false;
  }

  const response = await fetchWithTimeout(
    resolveUrl(base, 'api/auth/revoke'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ deviceId }),
    },
    requestTimeoutMs(),
  );

  if (!response.ok) {
    return false;
  }

  const storedDeviceId = await getAsync(DEVICE_ID_KEY);
  if (storedDeviceId === deviceId) {
    await clearSessionAsync();
  }
  return true;
}

/** Stable installation identifier: Guid.NewGuid().ToString("N") in the MAUI app. */
export async function getOrCreateDeviceIdAsync(): Promise<string> {
  const existing = await getAsync(DEVICE_ID_KEY);
  if (existing && existing.trim().length > 0) {
    return existing;
  }
  const deviceId = compactUuid();
  await setAsync(DEVICE_ID_KEY, deviceId);
  return deviceId;
}

/** Whether a stored token pair exists (used for session restore on startup). */
export async function hasStoredSessionAsync(): Promise<boolean> {
  const accessToken = await getAccessTokenAsync();
  const refreshToken = await getRefreshTokenAsync();
  return Boolean(accessToken && refreshToken);
}

export { uuid };
