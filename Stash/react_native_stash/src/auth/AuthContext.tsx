import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  ensureValidAccessTokenAsync,
  getOrCreateDeviceIdAsync,
  getUserIdAsync,
  hasStoredSessionAsync,
  loginAsync,
  logoutAsync,
  registerAsync,
} from './authenticationService';
import type { AuthResult } from '../models/authModels';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  userId: string;
  deviceId: string;
  login: (email: string, password: string, deviceId: string) => Promise<AuthResult>;
  register: (email: string, password: string, deviceId: string) => Promise<AuthResult>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [userId, setUserId] = useState('');
  const [deviceId, setDeviceId] = useState('');

  // Session restore: existing token pair → Main, otherwise Login
  // (navigation flow documented in FlutterStashPlan.md §9).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const id = await getOrCreateDeviceIdAsync();
        const hasSession = await hasStoredSessionAsync();
        if (cancelled) return;
        setDeviceId(id);
        if (hasSession) {
          const storedUserId = await getUserIdAsync();
          // Proactively refresh when the access token is stale; a dead refresh
          // token clears the session and lands the user on the login screen.
          const valid = await ensureValidAccessTokenAsync();
          if (cancelled) return;
          if (valid) {
            setUserId(storedUserId);
            setStatus('authenticated');
          } else {
            setStatus('unauthenticated');
          }
        } else {
          setStatus('unauthenticated');
        }
      } catch (error) {
        console.warn('Session restore failed:', errorMessage(error));
        if (!cancelled) {
          setStatus('unauthenticated');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(
    async (email: string, password: string, deviceIdInput: string): Promise<AuthResult> => {
      try {
        const result = await loginAsync(email.trim(), password, deviceIdInput.trim());
        if (result.isSuccess && result.token) {
          setUserId(result.token.userId);
          setDeviceId(result.token.deviceId || deviceIdInput.trim());
          setStatus('authenticated');
        }
        return result;
      } catch (error) {
        return { isSuccess: false, error: errorMessage(error) };
      }
    },
    [deviceId],
  );

  const register = useCallback(
    async (email: string, password: string, deviceIdInput: string): Promise<AuthResult> => {
      try {
        const result = await registerAsync(email.trim(), password, deviceIdInput.trim());
        if (result.isSuccess && result.token) {
          setUserId(result.token.userId);
          setDeviceId(result.token.deviceId || deviceIdInput.trim());
          setStatus('authenticated');
        }
        return result;
      } catch (error) {
        return { isSuccess: false, error: errorMessage(error) };
      }
    },
    [deviceId],
  );

  const logout = useCallback(async () => {
    await logoutAsync();
    setUserId('');
    setStatus('unauthenticated');
    // The device ID persists: it is the stable installation identifier.
    try {
      setDeviceId(await getOrCreateDeviceIdAsync());
    } catch {
      // Keep whatever device ID was already loaded.
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, userId, deviceId, login, register, logout }),
    [status, userId, deviceId, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside an AuthProvider');
  }
  return value;
}
