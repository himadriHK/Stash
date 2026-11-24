/**
 * Interactive equivalents of the documented manual workflows:
 * - scan one folder (deduplicated insert, stamps lastScannedAt)
 * - upload + publish a single file (retry flow)
 * - batch upload + publish a set of files (manual upload screen)
 *
 * Publishing goes through the durable outbox; a publish failure never rewrites
 * the file row, because the outbox owns retry and dead-lettering.
 *
 * Batch helpers are chunked and yield between chunks: a manual pass over 10k
 * files must not run as one long task on the JS thread.
 */
import {
  ensureValidAccessTokenAsync,
  getOrCreateDeviceIdAsync,
  getUserIdAsync,
} from '../auth/authenticationService';
import type { FileEntity } from '../models/fileEntity';
import type { FolderConfig } from '../models/folderConfig';
import { forEachChunkedAsync } from '../utils/cooperative';
import {
  fileRepository,
  folderIngestionService,
  outboxPublisher,
  uploadManager,
} from './singletons';
import type { FolderIngestionProgress } from './folderIngestionService';

export interface ScanResult {
  scanned: number;
  discovered: number;
}

/** Files whose ownership is stamped per transaction. */
const OWNERSHIP_CHUNK_SIZE = 250;

/** Scans a folder through the shared ingestion service (metadata dedup + batching). */
export async function scanFolderAsync(
  folder: FolderConfig,
  onProgress?: (progress: FolderIngestionProgress) => void,
): Promise<ScanResult> {
  const deviceId = await getOrCreateDeviceIdAsync();
  const userId = await getUserIdAsync();

  const result = await folderIngestionService.ingestFolderAsync(
    folder,
    deviceId,
    userId,
    onProgress,
  );
  return { scanned: result.scanned, discovered: result.discovered };
}

export interface PublishOutcome {
  success: boolean;
  queued: boolean;
  error?: string;
}

/** Uploads one file to storage, then queues its Kafka upload request. */
export async function uploadAndPublishAsync(file: FileEntity): Promise<PublishOutcome> {
  const result = await uploadManager.uploadFileAsync(file);
  if (!result.success) {
    return { success: false, queued: false, error: result.errorMessage ?? 'Upload failed.' };
  }
  if (!file.storageTempPath) {
    return {
      success: false,
      queued: false,
      error: 'Upload completed without a temporary storage path.',
    };
  }

  const deviceId = await getOrCreateDeviceIdAsync();
  const userId = await getUserIdAsync();
  try {
    const outcome = await outboxPublisher.enqueueAndFlushAsync(file, deviceId, userId);
    if (!outcome.queued) {
      return {
        success: false,
        queued: false,
        error: outcome.error ?? 'The upload request could not be queued.',
      };
    }
    return { success: true, queued: true };
  } catch (error) {
    return {
      success: false,
      queued: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface BatchOutcome {
  uploaded: number;
  queued: number;
  failed: number;
  error?: string;
}

export interface BatchProgress {
  phase: 'ownership' | 'uploading' | 'publishing';
  processed: number;
  total: number;
}

export type BatchProgressHandler = (progress: BatchProgress) => void;

/**
 * Batch upload (bounded concurrency) followed by durable outbox publishing -
 * the manual-upload equivalent of the background pass.
 *
 * Lookups go through a Map keyed by id: `files.find(...)` per result is O(n²)
 * and stalls the JS thread for seconds at 10k files.
 */
export async function uploadBatchAndPublishAsync(
  files: FileEntity[],
  onProgress?: BatchProgressHandler,
): Promise<BatchOutcome> {
  if (files.length === 0) {
    return { uploaded: 0, queued: 0, failed: 0 };
  }

  const authenticated = await ensureValidAccessTokenAsync();
  if (!authenticated) {
    return {
      uploaded: 0,
      queued: 0,
      failed: files.length,
      error: 'An authenticated session is required.',
    };
  }

  const deviceId = await getOrCreateDeviceIdAsync();
  const userId = await getUserIdAsync();
  const total = files.length;

  // One batched write per chunk instead of one per file.
  const missingOwners: string[] = [];
  for (const file of files) {
    if (!file.deviceId || !file.userId) {
      const fileDeviceId = file.deviceId || deviceId;
      const fileUserId = file.userId || userId;
      file.deviceId = fileDeviceId;
      file.userId = fileUserId;
      missingOwners.push(file.id);
    }
  }

  if (missingOwners.length > 0) {
    await forEachChunkedAsync(
      missingOwners,
      async (chunk) => {
        await fileRepository.setOwnershipManyAsync(chunk, deviceId, userId);
      },
      {
        chunkSize: OWNERSHIP_CHUNK_SIZE,
        onProgress: (processed) => onProgress?.({ phase: 'ownership', processed, total }),
      },
    );
  }

  const batch = await uploadManager.uploadBatchAsync(files, undefined, {
    onProgress: (processed) => onProgress?.({ phase: 'uploading', processed, total }),
  });

  const filesById = new Map(files.map((file) => [file.id, file]));
  const uploadedFiles: FileEntity[] = [];
  let failed = 0;

  for (const uploadResult of batch.results) {
    if (!uploadResult.success) {
      failed += 1;
      continue;
    }
    const file = filesById.get(uploadResult.fileId);
    if (!file) {
      failed += 1;
      continue;
    }
    uploadedFiles.push(file);
  }

  const published = await outboxPublisher.enqueueManyAsync(
    uploadedFiles,
    deviceId,
    userId,
    (processed) => onProgress?.({ phase: 'publishing', processed, total }),
  );

  return {
    uploaded: uploadedFiles.length,
    queued: published.queued,
    failed: failed + published.failed,
  };
}