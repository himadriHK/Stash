/**
 * MEGA key derivation and file-key helpers.
 *
 * A MEGA file key is 32 bytes:
 *   [0..16)  AES-128 key, XOR-obfuscated with the nonce during transport
 *   [16..24) 64-bit nonce (upper half of the CTR counter)
 *   [24..32) 64-bit condensed MAC of the file's chunks
 *
 * MEGA's per-chunk MAC is a CBC-MAC: `h = AES(k, h XOR block)` starting from
 * `h = nonce || nonce`. That is exactly AES-CBC encryption of the chunk with
 * `nonce || nonce` as IV, so the last ciphertext block is the chunk MAC. This
 * lets us reuse the (fast, key-expanded-once) noble CBC implementation instead
 * of doing one AES call per 16-byte block.
 */
import { MegaError } from '../errors.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { Aes128 } from './aes.js';
import {
  base64ToBytes,
  bytesToBase64Url,
  concatBytes,
  readUint32BE,
  writeUint32BE,
  xorBytes,
  zeroPadToMultiple,
} from '../util/bytes.js';

const BLOCK = 16;
const INITIAL_CHUNK = 128 * 1024;
const MAX_CHUNK = 1024 * 1024;
const CHUNK_INCREMENT = 128 * 1024;

/** MEGA account version 1 password derivation (65536 AES-128-ECB rounds). */
export function prepareKeyV1(password: Uint8Array): Uint8Array {
  let key: Uint8Array = Uint8Array.from([
    0x93, 0xc4, 0x67, 0xe3, 0x7d, 0xb0, 0xc7, 0xa4,
    0xd1, 0xbe, 0x3f, 0x81, 0x01, 0x52, 0xcb, 0x56,
  ]);

  for (let round = 65536; round > 0; round--) {
    for (let offset = 0; offset < password.length; offset += 16) {
      const block = new Uint8Array(BLOCK);
      for (let i = 0; i < 16; i += 4) {
        if (i + offset < password.length) {
          block.set(password.subarray(i + offset, Math.min(i + offset + 4, password.length)), i);
        }
      }
      key = new Aes128(block).ecbEncrypt(key);
    }
  }

  return key;
}

/** MEGA account version 2 password derivation. */
export function prepareKeyV2(
  password: Uint8Array,
  salt: Uint8Array,
  iterations = 100000,
): Uint8Array {
  return pbkdf2(sha512, password, salt, { c: iterations, dkLen: 32 });
}

/**
 * MEGA's "string hash": XOR 32-bit chunks of the input, AES-ECB encrypt the
 * 16-byte state 16384 times, then fold the 16 bytes into 8.
 */
export function stringHash(aesKey: Uint8Array, data: Uint8Array): Uint8Array {
  const h32 = [0, 0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    const remaining = data.length - i;
    if (remaining < 4) {
      let value = 0;
      for (let j = 0; j < remaining; j++) value = (value << 8) | data[i + j];
      value <<= (4 - remaining) * 8;
      h32[(i / 4) & 3] = (h32[(i / 4) & 3] ^ value) | 0;
    } else {
      const value = readUint32BE(data, i) | 0;
      h32[(i / 4) & 3] = (h32[(i / 4) & 3] ^ value) | 0;
    }
  }

  let hash: Uint8Array = new Uint8Array(BLOCK);
  for (let i = 0; i < 4; i++) writeUint32BE(hash, i * 4, h32[i] >>> 0);

  const aes = new Aes128(aesKey);
  for (let i = 16384; i > 0; i--) hash = aes.ecbEncrypt(hash);

  return concatBytes(hash.subarray(0, 4), hash.subarray(8, 12));
}

/** Recovers the AES key from a 32-byte MEGA file key (or accepts a 16-byte folder key). */
export function fileCipherKey(key: Uint8Array): Uint8Array {
  if (key.length === 16) return new Uint8Array(key);
  if (key.length !== 32) {
    throw new Error(`Wrong MEGA key length: expected 16 or 32 bytes, got ${key.length}`);
  }
  const unmerged = new Uint8Array(key);
  for (let i = 0; i < 16; i++) unmerged[i] ^= unmerged[16 + i];
  return unmerged.subarray(0, 16);
}

export function fileNonce(key: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error('File nonce requires a 32-byte key');
  return key.subarray(16, 24);
}

export function fileMetaMac(key: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error('File meta-MAC requires a 32-byte key');
  return key.subarray(24, 32);
}

/** 24-byte upload key -> 32-byte key with the condensed MAC appended. */
export function mergeKeyMac(key24: Uint8Array, mac8: Uint8Array): Uint8Array {
  if (key24.length !== 24) throw new Error('Upload key must be 24 bytes');
  if (mac8.length !== 8) throw new Error('MAC must be 8 bytes');
  const merged = concatBytes(key24, mac8);
  for (let i = 0; i < 16; i++) merged[i] ^= merged[16 + i];
  return merged;
}

/** 32-byte file key -> 24-byte encryption key (reverse of `mergeKeyMac`). */
export function unmergeKeyMac(key32: Uint8Array): Uint8Array {
  if (key32.length !== 32) throw new Error('File key must be 32 bytes');
  const out = new Uint8Array(key32);
  for (let i = 0; i < 16; i++) out[i] ^= out[16 + i];
  return out.subarray(0, 24);
}

/** Returns the 16-byte MAC of one protocol chunk (plaintext). */
export function chunkMac(aesKey: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (nonce.length < 8) throw new Error('MAC nonce must be at least 8 bytes');
  const iv = concatBytes(nonce.subarray(0, 8), nonce.subarray(0, 8));
  const padded = zeroPadToMultiple(plaintext, BLOCK);
  if (padded.length === 0) {
    // Empty chunk: the MAC is the IV block itself.
    return iv;
  }
  const encrypted = new Aes128(aesKey).cbcEncrypt(padded, iv);
  return encrypted.subarray(encrypted.length - BLOCK);
}

/** Condenses chunk MACs into the 8-byte meta-MAC stored in the file key. */
export function condenseMacs(aesKey: Uint8Array, chunkMacs: Uint8Array[]): Uint8Array {
  const aes = new Aes128(aesKey);
  let mac: Uint8Array = new Uint8Array(BLOCK);
  for (const macBlock of chunkMacs) {
    mac = aes.encryptBlock(xorBytes(mac, macBlock));
  }

  const folded = new Uint8Array(8);
  const v0 = readUint32BE(mac, 0);
  const v1 = readUint32BE(mac, 4);
  const v2 = readUint32BE(mac, 8);
  const v3 = readUint32BE(mac, 12);
  writeUint32BE(folded, 0, (v0 ^ v1) >>> 0);
  writeUint32BE(folded, 4, (v2 ^ v3) >>> 0);
  return folded;
}

/** Yields the protocol's MAC chunk boundaries for a file of `size` bytes. */
export function* macChunks(size: number): Generator<{ offset: number; length: number }> {
  let offset = 0;
  let increment = CHUNK_INCREMENT;
  let boundary = INITIAL_CHUNK;

  while (offset < size) {
    const end = Math.min(boundary, size);
    yield { offset, length: end - offset };
    offset = end;
    if (increment < MAX_CHUNK) increment += CHUNK_INCREMENT;
    boundary += increment;
  }
}

export type Sha256Digest = (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;

export interface HashcashProgress {
  attempts: number;
  elapsedMs: number;
}

export interface HashcashOptions {
  /**
   * Independent searches in flight. Each lane allocates its own 12.58 MB buffer
   * and lanes only run in parallel when `digest` is asynchronous (web
   * SubtleCrypto, Node's thread pool). A synchronous digest — like
   * `expo-crypto`'s native `digest`, which runs `MessageDigest` on the JS thread
   * — gains nothing and only costs memory, so this defaults to 1.
   */
  concurrency?: number;
  /** Stops the search between attempts. */
  signal?: AbortSignal;
  /** Reports progress so a multi-second solve can be surfaced in logs or UI. */
  onProgress?: (progress: HashcashProgress) => void;
  /** Attempts between `onProgress` calls. Defaults to 32. */
  progressEvery?: number;
}

function defaultSha256(data: Uint8Array): Uint8Array {
  return sha256(data);
}

const HASHCASH_REPLICATIONS = 262144;
const HASHCASH_SLOT_BYTES = 48;
const HASHCASH_PREFIX_BYTES = 4;
const MAX_HASHCASH_LANES = 4;
const MAX_HASHCASH_ATTEMPTS = 1_000_000;

/**
 * The value MEGA accepts for a challenge's `easiness`: the first 32-bit
 * big-endian word of the digest must be at or below it. Roughly 2^32/threshold
 * hashes are needed, so a typical `192` challenge costs ~256 of them. The shift
 * is masked back to 32 bits the way MEGA's own clients compute it.
 */
export function hashcashThreshold(easiness: number): number {
  const mantissa = ((easiness & 63) << 1) + 1;
  const shift = (easiness >> 6) * 7 + 3;
  return (mantissa * Math.pow(2, shift)) >>> 0;
}

/** Builds `counter (4 bytes) || token repeated 262144 times`. */
function hashcashTemplate(token: Uint8Array): Uint8Array {
  const buffer = new Uint8Array(
    HASHCASH_PREFIX_BYTES + HASHCASH_REPLICATIONS * HASHCASH_SLOT_BYTES,
  );
  for (let i = 0; i < HASHCASH_REPLICATIONS; i++) {
    buffer.set(token, HASHCASH_PREFIX_BYTES + i * HASHCASH_SLOT_BYTES);
  }
  return buffer;
}

/** Reads the counter as a little-endian uint32 (MEGA increments bytes that way). */
function readPrefix(buffer: Uint8Array): number {
  return (buffer[0] | (buffer[1] << 8) | (buffer[2] << 16) | (buffer[3] << 24)) >>> 0;
}

function writePrefix(buffer: Uint8Array, value: number): void {
  buffer[0] = value & 0xff;
  buffer[1] = (value >>> 8) & 0xff;
  buffer[2] = (value >>> 16) & 0xff;
  buffer[3] = (value >>> 24) & 0xff;
}

/**
 * Solves MEGA's hashcash proof of work.
 *
 * MEGA hashes 12.58 MB per candidate and accepts roughly one digest in
 * 2^32/threshold, so a typical challenge burns ~3 GB of SHA-256 (256 attempts at
 * easiness 192). That cost cannot be reduced algorithmically: the 4-byte counter
 * sits in the first block, so every candidate invalidates the whole hash and no
 * state can be reused. The available levers are therefore (a) not solving at all
 * — resume a stored session instead of logging in, (b) a fast digest, and
 * (c) `concurrency` where the digest is asynchronous.
 */
export async function solveHashcash(
  challenge: string,
  digest: Sha256Digest = defaultSha256,
  options: HashcashOptions = {},
): Promise<string> {
  const parts = challenge.split(':');
  const version = Number(parts[0]);
  if (version !== 1) throw new Error('Unsupported MEGA hashcash version');

  const tokenText = parts[3];
  if (!tokenText) throw new Error('Malformed MEGA hashcash challenge');

  const threshold = hashcashThreshold(Number(parts[1]));
  const lanes = Math.max(1, Math.min(MAX_HASHCASH_LANES, Math.floor(options.concurrency ?? 1)));
  const progressEvery = Math.max(1, Math.floor(options.progressEvery ?? 32));
  const template = hashcashTemplate(base64ToBytes(tokenText));

  let attempts = 0;
  let solved = false;
  let solution: Uint8Array | null = null;
  const startedAt = Date.now();

  const runLane = async (lane: number, buffer: Uint8Array): Promise<void> => {
    // Lanes walk disjoint counters: start at the lane index and stride by the
    // lane count, so no work is duplicated between them.
    writePrefix(buffer, lane);

    while (!solved) {
      if (options.signal?.aborted) throw new MegaError('ABORTED', 'The operation was cancelled');
      if (attempts >= MAX_HASHCASH_ATTEMPTS) {
        throw new Error('Could not solve the MEGA hashcash challenge');
      }

      const hash = await digest(buffer);
      if (hash.length < 4) throw new Error('The hashcash digest must return at least 4 bytes');
      attempts += 1;

      const value = ((hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3]) >>> 0;
      if (value <= threshold) {
        if (!solved) {
          solved = true;
          solution = buffer.slice(0, HASHCASH_PREFIX_BYTES);
        }
        return;
      }

      writePrefix(buffer, (readPrefix(buffer) + lanes) >>> 0);

      if (options.onProgress && attempts % progressEvery === 0) {
        options.onProgress({ attempts, elapsedMs: Date.now() - startedAt });
      }
    }
  };

  // Only lane 0 may use the template itself; extra lanes get a private copy so
  // a digest that reads its input asynchronously never sees another lane's
  // counter being written.
  const lanesRunning: Promise<void>[] = [];
  for (let lane = 0; lane < lanes; lane++) {
    lanesRunning.push(runLane(lane, lane === 0 ? template : template.slice()));
  }
  await Promise.all(lanesRunning);

  if (!solution) throw new Error('Could not solve the MEGA hashcash challenge');
  return `1:${tokenText}:${bytesToBase64Url(solution)}`;
}
