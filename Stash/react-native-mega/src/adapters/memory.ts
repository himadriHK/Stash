import type { ByteSink, ByteSource } from '../types.js';
import { concatBytes } from '../util/bytes.js';

export function memorySource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    async read(offset, length) {
      return bytes.subarray(offset, Math.min(offset + length, bytes.length));
    },
  };
}

export interface MemorySink extends ByteSink {
  readonly chunks: Uint8Array[];
  toBytes(): Uint8Array;
}

export function memorySink(): MemorySink {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    write(chunk) {
      chunks.push(new Uint8Array(chunk));
    },
    toBytes() {
      return concatBytes(...chunks);
    },
  };
}
