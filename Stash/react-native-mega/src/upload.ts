/**
 * File upload: encrypt one protocol chunk at a time, POST the ciphertext to the
 * upload URL MEGA hands out, then commit the node with the `p` command.
 *
 * The whole file is never buffered: only one 128 KB..1 MB chunk is in memory.
 */
import type { MegaApi } from './api.js';
import { MegaError, messageOf } from './errors.js';
import { Aes128, ctrCounterForOffset } from './crypto/aes.js';
import { encryptAttributes, type MegaAttributes } from './crypto/attributes.js';
import {
  chunkMac,
  condenseMacs,
  macChunks,
  mergeKeyMac,
} from './crypto/keys.js';
import { defaultRandom, throwIfAborted, withRetries } from './util/async.js';
import {
  base64ToBytes,
  bytesToBase64Url,
  bytesToUtf8,
} from './util/bytes.js';
import type { ByteSource, RandomSource, TransferOptions } from './types.js';

export interface RawNode {
  h: string;
  p?: string;
  t: number;
  s?: number;
  ts?: number;
  k?: string;
  a?: string;
  [key: string]: unknown;
}

export interface UploadRequest {
  api: MegaApi;
  folderId: string;
  name: string;
  source: ByteSource;
  masterKey: Uint8Array;
  random?: RandomSource;
  attributes?: MegaAttributes;
  options?: TransferOptions;
}

async function readExact(
  source: ByteSource,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let read = 0;
  while (read < length) {
    throwIfAborted(signal);
    const piece = await source.read(offset + read, length - read);
    if (piece.length === 0) {
      throw new MegaError('ARGS', `The upload source ended early at byte ${offset + read}`);
    }
    out.set(piece.subarray(0, Math.min(piece.length, length - read)), read);
    read += piece.length;
  }
  return out;
}

/**
 * MEGA's upload server historically returned the completion handle as raw
 * binary bytes that clients base64url-encode for the `p` command; some clients
 * and proxies return the already-encoded ASCII handle. Accept both.
 */
function parseHandle(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return undefined;

  const printable = bytes.every((byte) => byte >= 0x20 && byte <= 0x7e);
  if (printable) {
    let value = bytesToUtf8(bytes).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value) return undefined;

    if (/^-?\d+$/.test(value)) {
      const numeric = Number(value);
      if (numeric < 0) {
        throw new MegaError('INTERNAL', `MEGA rejected the upload chunk (${numeric})`, {
          retryable: numeric === -3,
          apiCode: numeric,
        });
      }
    }

    if (/^[A-Za-z0-9_-]{16,40}$/.test(value)) return value;
  }

  return bytesToBase64Url(bytes);
}

export async function uploadToFolder(request: UploadRequest): Promise<RawNode> {
  const { api, folderId, name, source, masterKey } = request;
  const options = request.options ?? {};
  const signal = options.signal;
  const retries = options.retries ?? 4;
  const random = request.random ?? defaultRandom;

  if (source.size < 0) throw new MegaError('ARGS', 'Upload source has an invalid size');
  if (masterKey.length !== 16) throw new MegaError('ARGS', 'The account key must be 16 bytes');

  const key24 = random(24);
  if (key24.length !== 24) throw new MegaError('ARGS', 'The random source returned the wrong length');
  const aesKey = key24.subarray(0, 16);
  const nonce = key24.subarray(16, 24);
  const aes = new Aes128(aesKey);

  let uploadUrl: string;
  try {
    const response = await withRetries(
      () => api.request<{ p?: string }>({ a: 'u', s: source.size, ssl: 2, ms: 0, r: 0, e: 0, v: 2 }, signal),
      { retries, signal },
    );
    if (!response?.p) throw new MegaError('INTERNAL', 'MEGA did not return an upload URL');
    uploadUrl = response.p;
  } catch (error) {
    if (error instanceof MegaError) throw error;
    throw new MegaError('NETWORK', `Could not start the upload: ${messageOf(error)}`, {
      retryable: true,
      cause: error,
    });
  }

  const macs: Uint8Array[] = [];
  let handle: string | undefined;
  let transferred = 0;

  const sendChunk = async (offset: number, plaintext: Uint8Array) => {
    macs.push(chunkMac(aesKey, nonce, plaintext));
    const ciphertext = aes.ctrXor(plaintext, ctrCounterForOffset(nonce, offset));

    const responseBytes = await withRetries(
      () => api.postChunk(uploadUrl, offset, ciphertext, signal),
      { retries, signal },
    );
    const parsed = parseHandle(responseBytes);
    if (parsed) handle = parsed;

    transferred += plaintext.length;
    options.onProgress?.({ bytesTransferred: transferred, bytesTotal: source.size });
  };

  try {
    if (source.size === 0) {
      await sendChunk(0, new Uint8Array(0));
    } else {
      for (const chunk of macChunks(source.size)) {
        throwIfAborted(signal);
        const plaintext = await readExact(source, chunk.offset, chunk.length, signal);
        await sendChunk(chunk.offset, plaintext);
      }
    }
  } catch (error) {
    if (error instanceof MegaError) throw error;
    throw new MegaError('NETWORK', `Upload failed: ${messageOf(error)}`, {
      retryable: true,
      cause: error,
    });
  } finally {
    try {
      await request.source.close?.();
    } catch {
      // The source is already unusable; keep the transfer result.
    }
  }

  if (!handle) {
    throw new MegaError('INTERNAL', 'MEGA did not return a completion handle for the upload');
  }

  const metaMac = condenseMacs(aesKey, macs);
  const finalKey = mergeKeyMac(key24, metaMac);

  const attributes: MegaAttributes = { ...request.attributes, n: name };
  const encryptedAttributes = encryptAttributes(attributes, finalKey);
  const storedKey = new Aes128(masterKey).ecbEncrypt(finalKey);

  try {
    const response = await withRetries(
      () =>
        api.request<{ f?: RawNode[] }>(
          {
            a: 'p',
            t: folderId,
            n: [
              {
                h: handle,
                t: 0,
                a: bytesToBase64Url(encryptedAttributes),
                k: bytesToBase64Url(storedKey),
              },
            ],
          },
          signal,
        ),
      { retries, signal },
    );

    const node = response?.f?.[0];
    if (!node) throw new MegaError('INTERNAL', 'MEGA did not return the created file node');
    return node;
  } catch (error) {
    if (error instanceof MegaError) throw error;
    throw new MegaError('NETWORK', `Could not commit the upload: ${messageOf(error)}`, {
      retryable: true,
      cause: error,
    });
  }
}

/** Decodes a base64 node key (exported for storage helpers). */
export function decodeStoredKey(value: string): Uint8Array {
  return base64ToBytes(value);
}
