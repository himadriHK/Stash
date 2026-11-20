/**
 * File adapters between the app's local files and `react-native-mega`'s
 * `ByteSource` / `ByteSink` contracts.
 *
 * Native (iOS/Android) uses expo-file-system's handle API so uploads and
 * downloads stay chunked (128 KB–1 MB) instead of buffering whole files.
 * Web has no expo-file-system implementation, so it reads the picked Blob into
 * memory and saves downloads through an object URL.
 */
import { Platform } from 'react-native';
import { File, FileMode, Paths } from 'expo-file-system';
import type { ByteSink, ByteSource } from 'react-native-mega';
import { readFileBytesAsync } from '../utils/fileAccess';
import { logError } from '../utils/errorLogger';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function memorySource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.byteLength,
    async read(offset, length) {
      return bytes.subarray(offset, Math.min(bytes.byteLength, offset + length));
    },
  };
}

interface OpenedFile {
  source: ByteSource;
  temporaryUri?: string;
}

/** Opens a path/URI for chunked reading, or returns null when it is not readable. */
function tryOpenFile(uri: string, sizeHint: number, temporaryUri?: string): OpenedFile | null {
  try {
    const file = new File(uri);
    if (!file.exists) {
      return null;
    }

    const handle = file.open(FileMode.ReadOnly);
    let closed = false;
    const source: ByteSource = {
      // SAF file sizes can read as 0 even when readable; trust the picker hint.
      size: file.size > 0 ? file.size : sizeHint,
      async read(offset, length) {
        if (closed) throw new Error('The upload source is closed.');
        handle.offset = offset;
        return handle.readBytes(length);
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          handle.close();
        } finally {
          if (temporaryUri) {
            try {
              if (file.exists) file.delete();
            } catch {
              // Cache cleanup is best effort.
            }
          }
        }
      },
    };
    return { source, temporaryUri };
  } catch {
    return null;
  }
}

/** Android SAF URIs are not always openable directly; copy them into the cache. */
async function copyToCache(uri: string): Promise<string> {
  const legacy = await import('expo-file-system/legacy');
  const destination = `${Paths.cache}mega_upload_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 9)}`;
  await legacy.copyAsync({ from: uri, to: destination });
  return destination;
}

/**
 * Opens a picked/scanned local file for upload. Prefers zero-copy streaming;
 * falls back to copying SAF URIs and finally to reading the bytes in memory.
 */
export async function openUploadSource(uri: string, sizeHint = 0): Promise<ByteSource> {
  if (Platform.OS === 'web') {
    const bytes = await readFileBytesAsync(uri);
    return memorySource(bytes);
  }

  if (uri.startsWith('content://')) {
    // SAF URIs are copied first: the cache copy supports reliable seeking and
    // reports a stable size, which chunked uploads need.
    let temporaryUri: string | null = null;
    try {
      temporaryUri = await copyToCache(uri);
      const copied = tryOpenFile(temporaryUri, sizeHint, temporaryUri);
      if (copied) {
        return copied.source;
      }
    } catch (error) {
      await logError('mega.upload.copyContentUri', error, { uri });
    }
    if (temporaryUri) {
      try {
        const file = new File(temporaryUri);
        if (file.exists) file.delete();
      } catch {
        // Best effort cleanup.
      }
    }
  }

  const direct = tryOpenFile(uri, sizeHint);
  if (direct) {
    return direct.source;
  }

  // Last resort for unusual providers: buffer the file. This is the only path
  // that loads the whole file, and it is recorded in the error log.
  await logError(
    'mega.upload.memoryFallback',
    new Error('Falling back to an in-memory upload source.'),
    { uri, scheme: uri.split(':')[0] },
  );
  return memorySource(await readFileBytesAsync(uri));
}

export interface DownloadSink extends ByteSink {
  uri: string;
}

/** Web-only: hands the downloaded bytes to the browser as a file download. */
function saveInBrowser(bytes: Uint8Array, destinationUri: string): void {
  const name = destinationUri.split('?')[0].split('/').pop() || 'download';
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/**
 * Creates the destination for a chunked download. On native the file is created
 * up front and deleted again if the transfer aborts (MAC mismatch, network…).
 */
export function createDownloadSink(destinationUri: string): DownloadSink {
  if (Platform.OS === 'web') {
    const chunks: Uint8Array[] = [];
    let closed = false;
    return {
      uri: destinationUri,
      write(chunk) {
        chunks.push(chunk);
      },
      close() {
        if (closed) return;
        closed = true;
        saveInBrowser(concatChunks(chunks), destinationUri);
      },
      abort() {
        closed = true;
        chunks.length = 0;
      },
    };
  }

  const file = new File(destinationUri);
  file.create({ intermediates: true, overwrite: true });
  const handle = file.open(FileMode.WriteOnly);
  let closed = false;

  const closeHandle = () => {
    if (closed) return false;
    closed = true;
    handle.close();
    return true;
  };

  return {
    uri: file.uri,
    async write(chunk) {
      await handle.writeBytes(chunk);
    },
    close() {
      closeHandle();
    },
    abort() {
      try {
        closeHandle();
      } catch (error) {
        console.warn(`Could not close the partial download: ${messageOf(error)}`);
      }
      try {
        if (file.exists) file.delete();
      } catch {
        // Best effort cleanup.
      }
    },
  };
}
