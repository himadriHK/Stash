/**
 * MEGA node attribute blocks: `MEGA{"n":"name",...}` zero-padded to 16 bytes,
 * AES-128-CBC encrypted with a zero IV.
 */
import { bytesToUtf8, utf8ToBytes, zeroPadToMultiple } from '../util/bytes.js';
import { Aes128 } from './aes.js';
import { fileCipherKey } from './keys.js';

export interface MegaAttributes {
  n?: string;
  lbl?: number;
  fav?: number;
  [key: string]: unknown;
}

export function packAttributes(attributes: MegaAttributes): Uint8Array {
  const json = `MEGA${JSON.stringify(attributes)}`;
  return zeroPadToMultiple(utf8ToBytes(json), 16);
}

export function unpackAttributes(block: Uint8Array): MegaAttributes | null {
  let end = 0;
  while (end < block.length && block[end] !== 0) end++;
  const text = bytesToUtf8(block.subarray(0, end));
  if (!text.startsWith('MEGA{')) return null;

  try {
    const parsed = JSON.parse(text.slice(4));
    return typeof parsed === 'object' && parsed !== null ? (parsed as MegaAttributes) : null;
  } catch {
    return null;
  }
}

/** Encrypts attributes with the node key (16-byte folder key or 32-byte file key). */
export function encryptAttributes(attributes: MegaAttributes, nodeKey: Uint8Array): Uint8Array {
  const aes = new Aes128(fileCipherKey(nodeKey));
  return aes.cbcEncrypt(packAttributes(attributes));
}

export function decryptAttributes(ciphertext: Uint8Array, nodeKey: Uint8Array): MegaAttributes | null {
  const aes = new Aes128(fileCipherKey(nodeKey));
  return unpackAttributes(aes.cbcDecrypt(ciphertext));
}
