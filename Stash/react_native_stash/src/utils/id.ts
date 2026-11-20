import * as Crypto from 'expo-crypto';

/** Cross-platform UUID v4 generator (expo-crypto on native, crypto API on web). */
export function uuid(): string {
  return Crypto.randomUUID();
}

/** Stable installation identifier: Guid.NewGuid().ToString("N") in the MAUI app. */
export function compactUuid(): string {
  return uuid().replace(/-/g, '');
}
