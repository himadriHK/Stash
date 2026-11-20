import { MegaError, abortError, isAbortError, messageOf } from '../errors.js';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export function defaultRandom(length: number): Uint8Array {
  const webCrypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } })
    .crypto;
  if (!webCrypto?.getRandomValues) {
    throw new MegaError(
      'UNSUPPORTED',
      'No secure random source found. Pass `random` to the SDK (for example expo-crypto getRandomBytes).',
    );
  }
  const bytes = new Uint8Array(length);
  webCrypto.getRandomValues(bytes);
  return bytes;
}

export interface RetryOptions {
  retries: number;
  signal?: AbortSignal;
  baseDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number) => void;
}

export async function withRetries<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const retries = Math.max(0, options.retries);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    throwIfAborted(options.signal);
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (isAbortError(error)) throw abortError();
      const retryable =
        error instanceof MegaError
          ? error.retryable
          : options.shouldRetry
            ? options.shouldRetry(error)
            : true;
      if (!retryable || attempt === retries) break;
      options.onRetry?.(error, attempt + 1);
      await sleep((options.baseDelayMs ?? 700) * Math.pow(2, attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new MegaError('NETWORK', messageOf(lastError));
}
