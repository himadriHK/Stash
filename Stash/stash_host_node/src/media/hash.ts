import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PROGRESS_INTERVAL_BYTES = 8 * 1024 * 1024;

export type HashProgressCallback = (bytesRead: number) => void;

/**
 * Streams a file through SHA-256 without buffering it. Progress is reported
 * roughly every 8 MiB and again when the stream finishes.
 */
export async function hashFileStreaming(
  filePath: string,
  onProgress?: HashProgressCallback,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash('sha256');
  let bytesRead = 0;
  let lastReported = 0;

  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytesRead += chunk.length;
      if (bytesRead - lastReported >= PROGRESS_INTERVAL_BYTES) {
        lastReported = bytesRead;
        onProgress?.(bytesRead);
      }
      callback();
    },
  });

  if (signal) {
    await pipeline(createReadStream(filePath), sink, { signal });
  } else {
    await pipeline(createReadStream(filePath), sink);
  }

  onProgress?.(bytesRead);
  return hash.digest('hex');
}
