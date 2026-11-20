/**
 * File download: MEGA serves ciphertext over HTTP with byte ranges. We fetch one
 * protocol chunk at a time (128 KB .. 1 MB), decrypt it with AES-CTR at the
 * chunk's counter offset, compute its MAC, write it to the app's sink, and
 * verify the condensed MAC at the end.
 */
import type { MegaApi } from './api.js';
import { MegaError, messageOf } from './errors.js';
import { Aes128, ctrCounterForOffset } from './crypto/aes.js';
import {
  chunkMac,
  condenseMacs,
  fileCipherKey,
  fileMetaMac,
  fileNonce,
  macChunks,
} from './crypto/keys.js';
import { throwIfAborted, withRetries } from './util/async.js';
import { equalBytes } from './util/bytes.js';
import type { ByteSink, TransferOptions } from './types.js';

export interface DownloadRequest {
  api: MegaApi;
  url: string;
  size: number;
  key: Uint8Array;
  sink: ByteSink;
  options?: TransferOptions;
}

export async function downloadFromUrl(request: DownloadRequest): Promise<void> {
  const { api, url, size, key, sink, options = {} } = request;
  const signal = options.signal;
  const retries = options.retries ?? 4;
  const connections = Math.max(1, Math.min(options.connections ?? 2, 4));

  if (key.length !== 32) {
    throw new MegaError('ARGS', 'A file key must be 32 bytes');
  }

  const aesKey = fileCipherKey(key);
  const nonce = fileNonce(key);
  const aes = new Aes128(aesKey);
  const chunks = size > 0 ? Array.from(macChunks(size)) : [];

  let transferred = 0;
  const macs: Uint8Array[] = [];

  try {
    if (size === 0) {
      macs.push(chunkMac(aesKey, nonce, new Uint8Array(0)));
    }

    const started: Array<Promise<Uint8Array> | undefined> = new Array(chunks.length);
    let nextToStart = 0;
    let inFlight = 0;

    const startMore = () => {
      while (nextToStart < chunks.length && inFlight < connections) {
        const index = nextToStart++;
        const chunk = chunks[index];
        inFlight++;
        const pending = withRetries(
          () => {
            throwIfAborted(signal);
            return api.getRange(url, chunk.offset, chunk.offset + chunk.length - 1, signal);
          },
          {
            retries,
            signal,
            onRetry: (_error, attempt) =>
              api.logger?.warn?.(`mega: retrying download chunk ${index} (${attempt})`),
          },
        );
        // Prefetched chunks may reject before they are awaited; mark the
        // rejection as handled while still rethrowing it at the await site.
        void pending.catch(() => undefined);
        started[index] = pending;
      }
    };

    for (let index = 0; index < chunks.length; index++) {
      throwIfAborted(signal);
      startMore();

      const pending = started[index];
      if (!pending) throw new MegaError('INTERNAL', 'Download chunk was not scheduled');
      const ciphertext = await pending;
      started[index] = undefined;
      inFlight--;

      const chunk = chunks[index];
      const plaintext = aes.ctrXor(ciphertext, ctrCounterForOffset(nonce, chunk.offset));
      macs.push(chunkMac(aesKey, nonce, plaintext));

      await sink.write(plaintext);
      transferred += plaintext.length;
      options.onProgress?.({ bytesTransferred: transferred, bytesTotal: size });
      startMore();
    }

    if (size === 0) {
      options.onProgress?.({ bytesTransferred: 0, bytesTotal: 0 });
    }

    if (options.verify !== false && chunks.length >= 0) {
      const expected = fileMetaMac(key);
      const actual = condenseMacs(aesKey, macs);
      if (!equalBytes(expected, actual)) {
        throw new MegaError('MAC_MISMATCH', 'Downloaded file failed MAC verification');
      }
    }

    await sink.close?.();
  } catch (error) {
    try {
      await sink.abort?.(error);
    } catch {
      // The original error is more useful.
    }
    if (error instanceof MegaError) throw error;
    throw new MegaError('NETWORK', `Download failed: ${messageOf(error)}`, {
      retryable: true,
      cause: error,
    });
  }
}
