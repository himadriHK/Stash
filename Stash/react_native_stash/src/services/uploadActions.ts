/**
 * Interactive equivalents of the documented manual workflows:
 * - scan one folder (deduplicated insert, stamps lastScannedAt)
 * - upload + publish a single file (retry flow)
 * - batch upload + publish a set of files (manual upload screen)
 */
import {
  ensureValidAccessTokenAsync,
  getOrCreateDeviceIdAsync,
  getUserIdAsync,
} from '../auth/authenticationService';
import type { FileEntity } from '../models/fileEntity';
import { createUploadRequestMessage } from '../models/messages';
import { UploadStatus } from '../models/uploadStatus';
import type { FolderConfig } from '../models/folderConfig';
import { createFileEntity } from '../models/fileEntity';
import { createFolderConfig } from '../models/folderConfig';
import {
  fileRepository,
  folderRepository,
  folderScanner,
  kafkaProducer,
  uploadManager,
} from './singletons';
import { mimeTypeForFile } from './folderScannerService';

export interface ScanResult {
  scanned: number;
  discovered: number;
}

/** Scans a folder, hashes new files, deduplicates and persists them. */
export async function scanFolderAsync(folder: FolderConfig): Promise<ScanResult> {
  const deviceId = await getOrCreateDeviceIdAsync();
  const userId = await getUserIdAsync();

  let scanned = 0;
  let discovered = 0;

  const found = await folderScanner.scanFolderAsync(folder);
  for (const file of found) {
    scanned += 1;
    const hash = await folderScanner.computeFileHashAsync(file.uri, file.size);
    if (!hash) {
      continue;
    }
    if (await fileRepository.existsByContentHashAsync(hash)) {
      continue;
    }
    await fileRepository.addAsync(
      createFileEntity({
        fileName: file.name,
        filePath: file.uri,
        fileSize: file.size,
        contentHash: hash,
        mimeType: mimeTypeForFile(file.name),
        createdAt: file.createdAt,
        modifiedAt: file.modifiedAt,
        deviceId,
        userId,
        status: UploadStatus.Pending,
      }),
    );
    discovered += 1;
  }

  folder.lastScannedAt = new Date().toISOString();
  await folderRepository.updateAsync(folder);

  return { scanned, discovered };
}

export interface PublishOutcome {
  success: boolean;
  queued: boolean;
  error?: string;
}

/** Uploads one file to Mega, then publishes its Kafka upload request. */
export async function uploadAndPublishAsync(file: FileEntity): Promise<PublishOutcome> {
  const result = await uploadManager.uploadFileAsync(file);
  if (!result.success) {
    return { success: false, queued: false, error: result.errorMessage ?? 'Upload failed.' };
  }
  if (!file.megaTempPath) {
    return {
      success: false,
      queued: false,
      error: 'Upload completed without a temporary Mega path.',
    };
  }
  return publishAsync(file);
}

async function publishAsync(file: FileEntity): Promise<PublishOutcome> {
  const deviceId = await getOrCreateDeviceIdAsync();
  const userId = await getUserIdAsync();
  try {
    await kafkaProducer.produceUploadRequestAsync(
      createUploadRequestMessage(file, deviceId, userId),
    );
    file.status = UploadStatus.Processing;
    file.errorMessage = null;
    await fileRepository.updateAsync(file);
    return { success: true, queued: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    file.status = UploadStatus.Failed;
    file.errorMessage = `Kafka publish failed: ${message}`;
    file.retryCount += 1;
    file.lastAttemptAt = new Date().toISOString();
    try {
      await fileRepository.updateAsync(file);
    } catch (updateError) {
      console.error(`Failed to persist Kafka failure state for file ${file.id}.`, updateError);
    }
    return { success: false, queued: false, error: message };
  }
}

export interface BatchOutcome {
  uploaded: number;
  queued: number;
  failed: number;
  error?: string;
}

/**
 * Batch upload (BatchSize concurrency) followed by Kafka publishing - the
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
    let changed = false;
    if (!file.deviceId) {
      file.deviceId = deviceId;
      changed = true;
    }
    if (!file.userId) {
      file.userId = userId;
      changed = true;
    }
    if (changed) {
      await fileRepository.updateAsync(file);
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
    if (!file || !file.megaTempPath) {
      failed += 1;
      continue;
    }
    const outcome = await publishAsync(file);
    if (outcome.queued) {
      queued += 1;
    } else {
      failed += 1;
    }
  }

  return { uploaded, queued, failed };
}
