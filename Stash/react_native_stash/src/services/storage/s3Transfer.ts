/**
 * Presigned-URL transfers for S3.
 *
 * Native uploads use the Expo SDK 58 `File.createUploadTask` API, which streams
 * the file on the native side, reports progress and honours an abort signal.
 * Web has no filesystem module, so it uploads a Blob with `fetch` and hands
 * downloads to the browser as an object URL.
 */
import { Platform } from 'react-native';
import { File, Paths, UploadType, type UploadTask } from 'expo-file-system';
import { copyAsync, downloadAsync } from 'expo-file-system/legacy';
import { logError } from '../../utils/errorLogger';
import { readFileBytesAsync } from '../../utils/fileAccess';
import type { StorageUploadSource } from './storageProvider';

const DEFAULT_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_UPLOAD_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Strips presigned credentials from text so logs never expose them. */
function redactCredentials(value: string): string {
  return value.replace(
    /(X-Amz-(?:Signature|Security-Token))=([^&\s"'<>]+)/gi,
    '$1=[redacted]',
  );
}

function redactError(error: unknown): unknown {
  if (error instanceof Error) {
    const message = redactCredentials(error.message);
    return message === error.message ? error : new Error(`${error.name}: ${message}`);
  }
  if (typeof error === 'string') {
    return redactCredentials(error);
  }
  return error;
}

function schemeOf(uri: string): string {
  const separator = uri.indexOf(':');
  return separator > 0 ? uri.slice(0, separator) : 'unknown';
}

function messageSnippet(body: string): string {
  return body.length > 300 ? `${body.slice(0, 300)}...` : body;
}

async function responseSnippetAsync(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text ? messageSnippet(text) : '(no response body)';
  } catch {
    return '(no response body)';
  }
}

/** Caller override clamped to 5 minutes..2 hours, otherwise the default. */
function resolveUploadTimeoutMs(source: StorageUploadSource): number {
  if (
    typeof source.timeoutMs === 'number' &&
    Number.isFinite(source.timeoutMs) &&
    source.timeoutMs > 0
  ) {
    return Math.min(MAX_UPLOAD_TIMEOUT_MS, Math.max(MIN_UPLOAD_TIMEOUT_MS, Math.floor(source.timeoutMs)));
  }
  return DEFAULT_UPLOAD_TIMEOUT_MS;
}

interface UploadDeadline {
  signal: AbortSignal;
  timedOut: () => boolean;
  timeoutMessage: string;
  cleanup: () => void;
}

/** Combines the caller's signal with an upload timeout into one signal. */
function createUploadDeadline(source: StorageUploadSource): UploadDeadline {
  const timeoutMs = resolveUploadTimeoutMs(source);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const external = source.signal;
  const onAbort = () => controller.abort();
  if (external) {
    if (external.aborted) {
      controller.abort();
    } else {
      external.addEventListener('abort', onAbort);
    }
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    timeoutMessage: `S3 upload timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
    cleanup: () => {
      clearTimeout(timer);
      if (external) {
        external.removeEventListener('abort', onAbort);
      }
    },
  };
}

/** Web-only: hands a downloaded Blob to the browser as a file download. */
function saveInBrowser(blob: Blob, destinationUri: string): void {
  const name = destinationUri.split('?')[0].split('/').pop() || 'download';
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

async function putOnWebAsync(url: string, source: StorageUploadSource): Promise<void> {
  const type = source.mimeType ?? 'application/octet-stream';
  const bytes = await readFileBytesAsync(source.uri);
  const body = new Blob([new Uint8Array(bytes)], { type });
  const deadline = createUploadDeadline(source);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': type },
        body,
        signal: deadline.signal,
      });
    } catch (error) {
      if (deadline.timedOut()) {
        throw new Error(deadline.timeoutMessage);
      }
      throw new Error(`S3 upload request failed: ${messageOf(error)}`);
    }
    if (!response.ok) {
      throw new Error(
        `S3 upload failed (HTTP ${response.status}): ${await responseSnippetAsync(response)}`,
      );
    }
  } finally {
    deadline.cleanup();
  }
}

async function copyContentUriToCacheAsync(uri: string): Promise<string> {
  const destination = `${Paths.cache.uri}s3_upload_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 9)}`;
  await copyAsync({ from: uri, to: destination });
  return destination;
}

async function putOnNativeAsync(url: string, source: StorageUploadSource): Promise<void> {
  const type = source.mimeType ?? 'application/octet-stream';
  let uploadUri = source.uri;
  let temporaryUri: string | null = null;

  if (source.uri.startsWith('content://')) {
    // Android SAF URIs cannot always be streamed directly, so stage a cache copy.
    temporaryUri = await copyContentUriToCacheAsync(source.uri);
    uploadUri = temporaryUri;
  }

  const deadline = createUploadDeadline(source);
  let task: UploadTask | null = null;
  try {
    const file = new File(uploadUri);
    task = file.createUploadTask(url, {
      httpMethod: 'PUT',
      uploadType: UploadType.BINARY_CONTENT,
      sessionType: 'foreground',
      headers: { 'Content-Type': type },
      signal: deadline.signal,
      onProgress: source.onProgress
        ? ({ bytesSent, totalBytes }) => {
            source.onProgress?.(bytesSent, totalBytes);
          }
        : undefined,
    });
    const result = await task.uploadAsync();
    if (result.status < 200 || result.status >= 300) {
      throw new Error(
        `S3 upload failed (HTTP ${result.status}): ${messageSnippet(result.body ?? '')}`,
      );
    }
  } catch (error) {
    if (deadline.timedOut()) {
      throw new Error(deadline.timeoutMessage);
    }
    throw error;
  } finally {
    deadline.cleanup();
    if (task) {
      try {
        task.release();
      } catch {
        // Releasing a completed native task is best effort.
      }
    }
    if (temporaryUri) {
      try {
        const temporaryFile = new File(temporaryUri);
        if (temporaryFile.exists) {
          temporaryFile.delete();
        }
      } catch {
        // Cache cleanup is best effort.
      }
    }
  }
}

export async function putFileToPresignedUrlAsync(
  url: string,
  source: StorageUploadSource,
): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      await putOnWebAsync(url, source);
    } else {
      await putOnNativeAsync(url, source);
    }
  } catch (error) {
    // The presigned URL is itself a credential, so only non-secret metadata is logged.
    await logError('s3.transfer.upload', redactError(error), {
      name: source.name,
      mimeType: source.mimeType,
      scheme: schemeOf(source.uri),
    });
    throw error;
  }
}

async function downloadOnWebAsync(url: string, destinationUri: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`S3 download request failed: ${messageOf(error)}`);
  }
  if (!response.ok) {
    throw new Error(
      `S3 download failed (HTTP ${response.status}): ${await responseSnippetAsync(response)}`,
    );
  }
  saveInBrowser(await response.blob(), destinationUri);
  return destinationUri;
}

async function downloadOnNativeAsync(url: string, destinationUri: string): Promise<string> {
  const file = new File(destinationUri);
  file.create({ intermediates: true, overwrite: true });
  try {
    const result = await downloadAsync(url, file.uri);
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`S3 download failed (HTTP ${result.status}).`);
    }
    return result.uri;
  } catch (error) {
    try {
      if (file.exists) {
        file.delete();
      }
    } catch {
      // Best effort cleanup of the partial download.
    }
    throw error;
  }
}

export async function downloadFromPresignedUrlAsync(
  url: string,
  destinationUri: string,
): Promise<string> {
  try {
    if (Platform.OS === 'web') {
      return await downloadOnWebAsync(url, destinationUri);
    }
    return await downloadOnNativeAsync(url, destinationUri);
  } catch (error) {
    await logError('s3.transfer.download', redactError(error), { destinationUri });
    throw error;
  }
}
