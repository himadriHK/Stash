import { Platform } from 'react-native';

/**
 * Session/.preference storage used by the app. On native platforms values live
 * in expo-secure-store (mirroring Stash.Maui's ISecureStorageService); on web
 * SecureStore is unavailable, so localStorage is used with an in-memory
 * fallback for restricted contexts.
 */

const memoryFallback = new Map<string, string>();

function webGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memoryFallback.get(key) ?? null;
  }
}

function webSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    memoryFallback.set(key, value);
  }
}

function webRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to clean up when localStorage is unavailable.
  }
  memoryFallback.delete(key);
}

export async function getAsync(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    return webGet(key);
  }
  const SecureStore = await import('expo-secure-store');
  return SecureStore.getItemAsync(key);
}

export async function setAsync(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    webSet(key, value);
    return;
  }
  const SecureStore = await import('expo-secure-store');
  await SecureStore.setItemAsync(key, value);
}

export async function removeAsync(key: string): Promise<void> {
  if (Platform.OS === 'web') {
    webRemove(key);
    return;
  }
  const SecureStore = await import('expo-secure-store');
  await SecureStore.deleteItemAsync(key);
}
