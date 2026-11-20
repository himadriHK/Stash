/**
 * Minimal UTF-8 → Base64 helper (no native dependencies) used for the Kafka
 * REST Proxy v3 record keys/headers and HTTP Basic auth.
 */

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function utf8Bytes(value: string): Uint8Array {
  const encoded = encodeURIComponent(value);
  const bytes = new Uint8Array(encoded.length);
  let length = 0;
  for (let i = 0; i < encoded.length; i += 1) {
    if (encoded[i] === '%') {
      bytes[length] = parseInt(encoded.slice(i + 1, i + 3), 16);
      i += 2;
    } else {
      bytes[length] = encoded.charCodeAt(i);
    }
    length += 1;
  }
  return bytes.subarray(0, length);
}

export function toBase64(value: string): string {
  const bytes = utf8Bytes(value);
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;

    result += B64_CHARS[b0 >> 2];
    result += B64_CHARS[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    result += b1 === undefined ? '=' : B64_CHARS[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    result += b2 === undefined ? '=' : B64_CHARS[b2 & 0x3f];
  }
  return result;
}

const B64_LOOKUP: Record<string, number> = (() => {
  const table: Record<string, number> = {};
  for (let i = 0; i < B64_CHARS.length; i += 1) {
    table[B64_CHARS[i]] = i;
  }
  return table;
})();

/** Decodes Base64 back to a UTF-8 string (used for chunked file reads). */
export function fromBase64(value: string): string {
  const clean = value.replace(/=+$/, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_LOOKUP[clean[i]] ?? 0;
    const c1 = B64_LOOKUP[clean[i + 1]] ?? 0;
    const c2 = B64_LOOKUP[clean[i + 2]];
    const c3 = B64_LOOKUP[clean[i + 3]];

    bytes.push((c0 << 2) | (c1 >> 4));
    if (c2 !== undefined) {
      bytes.push(((c1 & 0x0f) << 4) | (c2 >> 2));
    }
    if (c3 !== undefined) {
      bytes.push(((c2 & 0x03) << 6) | c3);
    }
  }
  return decodeURIComponent(
    bytes
      .map((b) => `%${b.toString(16).padStart(2, '0')}`)
      .join(''),
  );
}

/** Decodes Base64 to raw bytes (used for incremental SHA-256 hashing). */
export function base64ToBytes(value: string): Uint8Array {
  const clean = value.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let length = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_LOOKUP[clean[i]] ?? 0;
    const c1 = B64_LOOKUP[clean[i + 1]] ?? 0;
    const c2 = B64_LOOKUP[clean[i + 2]];
    const c3 = B64_LOOKUP[clean[i + 3]];

    bytes[length] = (c0 << 2) | (c1 >> 4);
    length += 1;
    if (c2 !== undefined) {
      bytes[length] = ((c1 & 0x0f) << 4) | (c2 >> 2);
      length += 1;
    }
    if (c3 !== undefined) {
      bytes[length] = ((c2 & 0x03) << 6) | c3;
      length += 1;
    }
  }
  return bytes.subarray(0, length);
}
