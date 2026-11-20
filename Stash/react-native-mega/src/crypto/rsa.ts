/**
 * Minimal RSA support for MEGA logins.
 *
 * MEGA stores each account's 2048-bit RSA private key as four MPI-encoded
 * numbers (p, q, d, u). We only need raw RSA decryption for the session id, so
 * this uses BigInt instead of the 28-bit limb arithmetic in the original
 * megajs implementation.
 */
import { bigIntToBytes, bytesToBigInt } from '../util/bytes.js';

export interface MegaRsaPrivateKey {
  p: bigint;
  q: bigint;
  d: bigint;
  u: bigint;
  n: bigint;
}

/** Reads one MPI: 2-byte big-endian bit length followed by the big-endian value. */
function readMpi(bytes: Uint8Array, offset: number): { value: bigint; next: number } {
  if (offset + 2 > bytes.length) throw new Error('Truncated MPI');
  const bits = (bytes[offset] << 8) | bytes[offset + 1];
  const length = Math.ceil(bits / 8);
  const start = offset + 2;
  if (start + length > bytes.length) throw new Error('Truncated MPI value');
  return { value: bytesToBigInt(bytes.subarray(start, start + length)), next: start + length };
}

/** Decodes MEGA's 4-MPI private key blob. */
export function decodePrivateKey(blob: Uint8Array): MegaRsaPrivateKey {
  let offset = 0;
  const p = readMpi(blob, offset);
  offset = p.next;
  const q = readMpi(blob, offset);
  offset = q.next;
  const d = readMpi(blob, offset);
  offset = d.next;
  const u = readMpi(blob, offset);

  if (p.value <= 0n || q.value <= 0n || d.value <= 0n) {
    throw new Error('Invalid MEGA RSA private key');
  }

  return { p: p.value, q: q.value, d: d.value, u: u.value, n: p.value * q.value };
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus === 1n) return 0n;
  let result = 1n;
  let value = base % modulus;
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) result = (result * value) % modulus;
    value = (value * value) % modulus;
    power >>= 1n;
  }
  return result;
}

/** Raw RSA private-key operation using CRT. */
export function rsaDecrypt(integer: bigint, key: MegaRsaPrivateKey): bigint {
  const m1 = modPow(integer, key.d, key.p);
  const m2 = modPow(integer, key.d, key.q);
  let h = (key.u * (m2 - m1)) % key.q;
  if (h < 0n) h += key.q;
  return m1 + h * key.p;
}

/** Decrypts an MPI-encoded ciphertext with a MEGA private key. */
export function rsaDecryptMpi(ciphertext: Uint8Array, key: MegaRsaPrivateKey): Uint8Array {
  const { value } = readMpi(ciphertext, 0);
  return bigIntToBytes(rsaDecrypt(value, key));
}
