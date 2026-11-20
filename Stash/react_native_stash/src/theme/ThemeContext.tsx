import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useColorScheme } from 'react-native';
import { darkColors, lightColors, type ThemeColors } from './colors';
import { getAsync, setAsync } from '../utils/storage';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedThemeMode = 'light' | 'dark';

export interface Theme {
  mode: ThemeMode;
  resolvedMode: ResolvedThemeMode;
  dark: boolean;
  colors: ThemeColors;
}

interface ThemeContextValue extends Theme {
  setMode: (mode: ThemeMode) => void;
}

const STORAGE_KEY = 'stash.theme.mode';

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');

  useEffect(() => {
    let cancelled = false;
    getAsync(STORAGE_KEY)
      .then((stored) => {
        if (!cancelled && (stored === 'light' || stored === 'dark' || stored === 'system')) {
          setModeState(stored);
        }
      })
      .catch(() => {
        // Theme persistence is optional; fall back to system mode.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    setAsync(STORAGE_KEY, next).catch(() => {
      // Ignore persistence failures; the in-memory mode still applies.
    });
  }, []);

  const value = useMemo<ThemeContextValue>(() => {
    const resolvedMode: ResolvedThemeMode =
      mode === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : mode;
    const dark = resolvedMode === 'dark';
    return {
      mode,
      resolvedMode,
      dark,
      colors: dark ? darkColors : lightColors,
      setMode,
    };
  }, [mode, systemScheme, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error('useTheme must be used inside a ThemeProvider');
  }
  return value;
}
