/**
 * Interactive equivalents of the documented manual workflows:
 * - scan one folder (deduplicated insert, stamps lastScannedAt)
 * - upload + publish a single file (retry flow)
 * - batch upload + publish a set of files (manual upload screen)
 *
 * Publishing goes through the durable outbox; a publish failure never rewrites
 * the file row, because the outbox owns retry and dead-lettering.
 */
import {
  ensureValidAccessTokenAsync,
  getOrCreateDeviceIdAsync,
  getUserIdAsync,
} from '../auth/authenticationService';
import type { FileEntity } from '../models/fileEntity';
import type { FolderConfig } from '../models/folderConfig';
import {
  fileRepository,
  folderIngestionService,
  outboxPublisher,
  uploadManager,
} from './singletons';

export interface ScanResult {
  scanned: number;
  discovered: number;
}

/** Scans a folder through the shared ingestion service (hash cache + batching). */
export async function scanFolderAsync(folder: FolderConfig): Promise<ScanResult> {
  const deviceId = await getOrCreateDeviceIdAsync();
  const userId = await getUserIdAsync();

  const result = await folderIngestionService.ingestFolderAsync(folder, deviceId, userId);
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

/**
 * Batch upload (BatchSize concurrency) followed by outbox publishing - the
 * manual-upload equivalent of the background pass.
 */
export async function uploadBatchAndPublishAsync(files: FileEntity[]): Promise<BatchOutcome> {
  const authenticated = await ensureValidAccessTokenAsync();
  if (!authenticated) {
    return { uploaded: 0, queued: 0, failed: files.length, error: 'An authenticated session is required.' };
  }

  const deviceId = await getOrCreateDeviceIdAsync();
  const userId = await getUserIdAsync();

  for (const file of files) {
    if (!file.deviceId || !file.userId) {
      const fileDeviceId = file.deviceId || deviceId;
      const fileUserId = file.userId || userId;
      await fileRepository.setOwnershipAsync(file.id, fileDeviceId, fileUserId);
      file.deviceId = fileDeviceId;
      file.userId = fileUserId;
    }
  }

  const batch = await uploadManager.uploadBatchAsync(files);
  let uploaded = 0;
  let queued = 0;
  let failed = 0;

  for (const uploadResult of batch.results) {
    const file = files.find((candidate) => candidate.id === uploadResult.fileId);
    if (!uploadResult.success) {
      failed += 1;
      continue;
    }
    uploaded += 1;
    if (!file || !file.storageTempPath) {
      failed += 1;
      continue;
    }
    try {
      const outcome = await outboxPublisher.enqueueAndFlushAsync(file, deviceId, userId);
      if (outcome.queued) {
        queued += 1;
      } else {
        failed += 1;
      }
    } catch (error) {
      console.warn(
        `Could not queue the upload request for file ${file.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      failed += 1;
    }
  }

  return { uploaded, queued, failed };
}
