/**
 * AES-128 primitives used by the MEGA protocol.
 *
 * Only the modes MEGA needs are exposed: single-block ECB (MAC + key wrapping),
 * zero-IV CBC (attributes) and CTR (file data). Implemented on top of
 * `@noble/ciphers`, which is pure JavaScript and works in Hermes.
 */
import { cbc, ctr, ecb } from '@noble/ciphers/aes.js';
import { concatBytes } from '../util/bytes.js';

const BLOCK = 16;

function assertLength(value: Uint8Array, expected: number, label: string): void {
  if (value.length !== expected) {
    throw new Error(`${label} must be ${expected} bytes, got ${value.length}`);
  }
}

function assertBlockAligned(value: Uint8Array, label: string): void {
  if (value.length % BLOCK !== 0) {
    throw new Error(`${label} must be a multiple of ${BLOCK} bytes`);
  }
}

/** Increments a 16-byte big-endian counter block by `blocks`. */
export function incrementCounterBlock(counter: Uint8Array, blocks: number): Uint8Array {
  assertLength(counter, BLOCK, 'counter block');
  const out = new Uint8Array(counter);
  let carry = blocks;
  for (let i = out.length - 1; i >= 0 && carry > 0; i--) {
    const value = out[i] + (carry % 256);
    out[i] = value & 0xff;
    carry = Math.floor(carry / 256) + (value >> 8);
  }
  return out;
}

export class Aes128 {
  readonly key: Uint8Array;

  constructor(key: Uint8Array) {
    assertLength(key, 16, 'AES-128 key');
    this.key = new Uint8Array(key);
  }

  encryptBlock(block: Uint8Array): Uint8Array {
    assertLength(block, BLOCK, 'AES block');
    return ecb(this.key, { disablePadding: true }).encrypt(block);
  }

  decryptBlock(block: Uint8Array): Uint8Array {
    assertLength(block, BLOCK, 'AES block');
    return ecb(this.key, { disablePadding: true }).decrypt(block);
  }

  ecbEncrypt(data: Uint8Array): Uint8Array {
    assertBlockAligned(data, 'ECB data');
    return ecb(this.key, { disablePadding: true }).encrypt(data);
  }

  ecbDecrypt(data: Uint8Array): Uint8Array {
    assertBlockAligned(data, 'ECB data');
    return ecb(this.key, { disablePadding: true }).decrypt(data);
  }

  cbcEncrypt(data: Uint8Array, iv: Uint8Array = new Uint8Array(BLOCK)): Uint8Array {
    assertBlockAligned(data, 'CBC data');
    assertLength(iv, BLOCK, 'CBC IV');
    return cbc(this.key, iv, { disablePadding: true }).encrypt(data);
  }

  cbcDecrypt(data: Uint8Array, iv: Uint8Array = new Uint8Array(BLOCK)): Uint8Array {
    assertBlockAligned(data, 'CBC data');
    assertLength(iv, BLOCK, 'CBC IV');
    return cbc(this.key, iv, { disablePadding: true }).decrypt(data);
  }

  /** XORs `data` with the AES-CTR keystream starting at `counterBlock`. */
  ctrXor(data: Uint8Array, counterBlock: Uint8Array): Uint8Array {
    assertLength(counterBlock, BLOCK, 'CTR counter block');
    if (data.length === 0) return new Uint8Array(0);
    return ctr(this.key, counterBlock).encrypt(data);
  }
}

/** Builds the CTR block for a file key, advanced to `offset` (must be 16-aligned). */
export function ctrCounterForOffset(nonce: Uint8Array, offset: number): Uint8Array {
  if (offset % BLOCK !== 0) {
    throw new Error('CTR offset must be a multiple of 16');
  }
  const counter = concatBytes(nonce, new Uint8Array(8));
  return incrementCounterBlock(counter, offset / BLOCK);
}
