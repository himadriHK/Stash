/**
 * `react-native-mega` runtime wiring for the app.
 *
 * The SDK is pure JS, so Hermes needs no WebCrypto or stream polyfills. We only
 * inject the platform primitives it expects:
 *  - expo-crypto's secure RNG,
 *  - expo-crypto's native SHA-256 for MEGA's hashcash proof-of-work,
 *  - the runtime fetch and a console logger.
 *
 * Authentication is the slowest step of a MEGA session: a full password login
 * costs a 100k-round PBKDF2 in JS, an RSA session-id decrypt, four sequential
 * API calls and, on unfamiliar networks, a hashcash proof of work. None of that
 * is needed twice: the SDK can resume from `{ key, sid }`, so the session is
 * cached in secure storage and later launches only re-read the Drive tree.
 */
import * as ExpoCrypto from 'expo-crypto';
import { Platform } from 'react-native';
import {
  MegaError,
  MegaStorage,
  type FetchLike,
  type Logger,
  type MegaErrorCode,
  type MegaSession,
  type MegaStorageOptions,
  type RandomSource,
  type Sha256Digest,
} from 'react-native-mega';
import { appConfig } from '../config/appConfig';
import { getAsync, removeAsync, setAsync } from '../utils/storage';

export const megaRandom: RandomSource = (length) => ExpoCrypto.getRandomBytes(length);

/** Native SHA-256 keeps the ~12 MB hashcash loop off the JS thread. */
export const megaSha256: Sha256Digest = async (data) => {
  const digest = await ExpoCrypto.digest(
    ExpoCrypto.CryptoDigestAlgorithm.SHA256,
    data as unknown as BufferSource,
  );
  return new Uint8Array(digest);
};

const logger: Logger = {
  warn: (message, ...args) => console.warn(`[mega] ${message}`, ...args),
  error: (message, ...args) => console.error(`[mega] ${message}`, ...args),
};

/** Adapts the global fetch to the SDK's `FetchLike` signature. */
const megaFetch: FetchLike = (input, init) =>
  globalThis.fetch(input, init as RequestInit | undefined);

/** SecureStore key holding the resumed MEGA session (master key + sid). */
export const MEGA_SESSION_STORAGE_KEY = 'stash.mega.session';

/**
 * MEGA's proof of work hashes 12.58 MB per candidate and a typical challenge
 * needs ~256 candidates, so it is inherently a multi-second step that cannot be
 * made cheaper algorithmically (the counter is in the first block, so nothing can
 * be reused between candidates). Lanes only run in parallel when the digest is
 * asynchronous: on web `crypto.subtle` hashes off the JS thread, while
 * `expo-crypto`'s native digest runs a synchronous `MessageDigest` on it and
 * would only add 12.58 MB of memory per lane.
 */
function hashcashConcurrency(): number {
  if (Platform.OS !== 'web') {
    return 1;
  }
  const cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
    ?.hardwareConcurrency;
  return Math.min(4, Math.max(1, Math.floor(cores ?? 2)));
}

const transportOptions: Pick<
  MegaStorageOptions,
  'fetch' | 'random' | 'hashcashDigest' | 'hashcashConcurrency' | 'logger'
> = {
  fetch: megaFetch,
  random: megaRandom,
  hashcashDigest: megaSha256,
  hashcashConcurrency: hashcashConcurrency(),
  logger,
};

/**
 * Failures that say nothing about the cached session (the network, a busy
 * server, a rate limit). Anything else means the session is no longer accepted
 * and a password login is required.
 */
const REUSABLE_SESSION_FAILURES: ReadonlySet<MegaErrorCode> = new Set<MegaErrorCode>([
  'NETWORK',
  'ABORTED',
  'RATE_LIMIT',
  'BUSY',
  'HTTP',
  'INTERNAL',
]);

async function readCachedSessionAsync(): Promise<MegaSession | null> {
  try {
    const raw = await getAsync(MEGA_SESSION_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<MegaSession> | null;
    if (!parsed || typeof parsed.key !== 'string' || typeof parsed.sid !== 'string') {
      return null;
    }
    return { key: parsed.key, sid: parsed.sid, name: parsed.name, user: parsed.user };
  } catch (error) {
    logger.warn?.('mega: could not read the cached session', error);
    return null;
  }
}

async function writeCachedSessionAsync(session: MegaSession): Promise<void> {
  try {
    await setAsync(MEGA_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch (error) {
    // A failed cache write only costs a slower next start.
    logger.warn?.('mega: could not cache the session', error);
  }
}

async function clearCachedSessionAsync(): Promise<void> {
  try {
    await removeAsync(MEGA_SESSION_STORAGE_KEY);
  } catch (error) {
    logger.warn?.('mega: could not clear the cached session', error);
  }
}

export async function connectMegaStorage(): Promise<MegaStorage> {
  const email = (appConfig.Storage.Mega.Email ?? '').trim();
  const password = appConfig.Storage.Mega.Password ?? '';
  if (!email || !password) {
    throw new Error(
      'MEGA account is not configured. Set Storage:Mega:Email and Storage:Mega:Password in appconfig.json.',
    );
  }

  const cached = await readCachedSessionAsync();
  if (cached) {
    try {
      return await MegaStorage.fromSession(cached, transportOptions);
    } catch (error) {
      if (error instanceof MegaError && REUSABLE_SESSION_FAILURES.has(error.code)) {
        throw error;
      }
      logger.warn?.(
        `mega: cached session was rejected (${error instanceof Error ? error.message : String(error)}); logging in again`,
      );
      await clearCachedSessionAsync();
    }
  }

  const secondFactorCode = (appConfig.Storage.Mega.SecondFactorCode ?? '').trim();

  try {
    const storage = await MegaStorage.login({
      ...transportOptions,
      email,
      password,
      secondFactorCode: secondFactorCode || undefined,
    });
    await writeCachedSessionAsync(storage.toJSON());
    return storage;
  } catch (error) {
    if (error instanceof MegaError && error.code === '2FA_REQUIRED') {
      throw new Error(
        'MEGA login requires a two-factor code. Set Storage.Mega.SecondFactorCode in appconfig.json.',
      );
    }
    throw error;
  }
}
