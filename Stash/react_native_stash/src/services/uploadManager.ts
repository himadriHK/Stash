/**
 * UploadManager - streams local files to the configured storage provider.
 *
 * Status changes go exclusively through `FileLifecycleService`, which applies
 * guarded transitions; this service only refreshes the in-memory entity after a
 * transition is accepted. Mirrors Stash.Maui/Services/UploadManager.cs.
 */
import { appConfig } from '../config/appConfig';
import type { FileRepository } from '../data/fileRepository';
import type { FileEntity } from '../models/fileEntity';
import { UploadStatus } from '../models/uploadStatus';
import { logError } from '../utils/errorLogger';
import { localFileExistsAsync, localFileSizeAsync } from '../utils/fileAccess';
import type { FileLifecycleService } from './fileLifecycleService';
import type { StorageProvider } from './storage/storageProvider';

export interface UploadResult {
  fileId: string;
  success: boolean;
  storageTempPath: string | null;
  errorMessage: string | null;
}

export interface UploadBatchResult {
  results: UploadResult[];
  batchSize: number;
  batchCount: number;
}

/** Optional cancellation and progress callbacks for a transfer. */
export interface UploadTransferOptions {
  signal?: AbortSignal;
  onProgress?: (bytesSent: number, totalBytes: number) => void;
}

export function batchTotals(batch: UploadBatchResult): {
  totalCount: number;
  successCount: number;
  failureCount: number;
  allSucceeded: boolean;
} {
  const totalCount = batch.results.length;
  const successCount = batch.results.filter((result) => result.success).length;
  const failureCount = totalCount - successCount;
  return { totalCount, successCount, failureCount, allSucceeded: failureCount === 0 };
}

function basename(value: string): string {
  const segments = value.split(/[\\/]/);
  return segments[segments.length - 1] ?? '';
}

export class UploadManager {
  private readonly inProgress = new Set<string>();

  constructor(
    private readonly storage: StorageProvider,
    private readonly fileRepository: FileRepository,
    private readonly lifecycle: FileLifecycleService,
  ) {}

  /**
   * Builds the documented logical temporary storage path:
   * `/temp/uploads/{deviceId}/{contentHash}/{fileName}`. The hash segment makes
   * the object key stable across re-uploads of the same content.
   */
  buildStorageTempPath(file: FileEntity): string {
    const deviceId = file.deviceId && file.deviceId.trim().length > 0
      ? file.deviceId.trim()
      : 'unknown-device';
    const contentHash = file.contentHash?.trim().toLowerCase();
    const hashSegment = contentHash && /^[0-9a-f]{64}$/.test(contentHash)
      ? contentHash
      : file.id.replace(/-/g, '');
    const fileName =
      basename(file.fileName) || basename(file.filePath) || file.id.replace(/-/g, '');
    return `/temp/uploads/${deviceId}/${hashSegment}/${fileName}`;
  }

  async uploadFileAsync(
    file: FileEntity,
    storageTempPath?: string,
    options?: UploadTransferOptions,
  ): Promise<UploadResult> {
    const remotePath =
      storageTempPath && storageTempPath.trim().length > 0
        ? storageTempPath.trim()
        : this.buildStorageTempPath(file);

    if (this.inProgress.has(file.id)) {
      return {
        fileId: file.id,
        success: false,
        storageTempPath: remotePath,
        errorMessage: 'An upload for this file is already in progress.',
      };
    }

    this.inProgress.add(file.id);
    try {
      const exists = await localFileExistsAsync(file.filePath);
      if (!exists) {
        await logError('upload.localFileMissing', new Error('Local file not found.'), {
          fileId: file.id,
          filePath: file.filePath,
          fileName: file.fileName,
        });
        await this.lifecycle.markLocalMissingAsync(file.id, 'Local file not found.');
        await this.refreshFromRepositoryAsync(file);
        return {
          fileId: file.id,
          success: false,
          storageTempPath: remotePath,
          errorMessage: 'Local file not found.',
        };
      }

      if (file.fileSize <= 0) {
        file.fileSize = await localFileSizeAsync(file.filePath, file.fileSize);
      }

      const maxFileSizeBytes = Math.max(0, appConfig.UploadSettings.MaxFileSizeBytes);
      if (maxFileSizeBytes > 0 && file.fileSize > maxFileSizeBytes) {
        const message = `File size ${file.fileSize} exceeds the configured limit of ${maxFileSizeBytes} bytes.`;
        await this.lifecycle.markTerminalFailureAsync(file.id, 'local', message);
        await this.refreshFromRepositoryAsync(file);
        return {
          fileId: file.id,
          success: false,
          storageTempPath: remotePath,
          errorMessage: message,
        };
      }

      const started = await this.lifecycle.markUploadingAsync(file.id, remotePath);
      if (!started) {
        await this.refreshFromRepositoryAsync(file);
        return {
          fileId: file.id,
          success: false,
          storageTempPath: remotePath,
          errorMessage:
            'The file is no longer eligible for upload; its state changed before the transfer started.',
        };
      }

      // The guarded transition was accepted, so mirror it in memory.
      file.status = UploadStatus.Uploading;
      file.storageTempPath = remotePath;
      file.errorMessage = null;
      file.lastAttemptAt = new Date().toISOString();

      const uploadedPath = await this.storage.uploadFileAsync(
        {
          uri: file.filePath,
          name: file.fileName,
          mimeType: file.mimeType,
          size: file.fileSize,
          contentHash: file.contentHash,
          signal: options?.signal,
          onProgress: options?.onProgress,
        },
        remotePath,
      );

      const completed = await this.lifecycle.markUploadedAsync(file.id, uploadedPath);
      if (!completed) {
        await this.refreshFromRepositoryAsync(file);

        // The guarded `Uploading -> Uploaded` transition was rejected. If the
        // row is still `Uploading`, a concurrent writer changed it but left it
        // in flight; force a bounded failure so it is never stranded.
        if (file.status === UploadStatus.Uploading) {
          const failureMessage =
            'Upload completed but the file state changed before it could be recorded.';
          await this.lifecycle.markUploadFailedAsync(file.id, failureMessage, {
            incrementRetry: true,
            maxRetries: appConfig.UploadSettings.MaxRetries,
          });
          await this.refreshFromRepositoryAsync(file);
          return {
            fileId: file.id,
            success: false,
            storageTempPath: uploadedPath,
            errorMessage: failureMessage,
          };
        }

        // Already Processing/Completed/Deduplicated (or otherwise advanced):
        // do not rewrite that state; report the failed recording.
        await logError(
          'upload.markUploaded',
          new Error('The file state changed concurrently before the upload was recorded.'),
          { fileId: file.id, remotePath: uploadedPath, status: file.status },
        );
        return {
          fileId: file.id,
          success: false,
          storageTempPath: uploadedPath,
          errorMessage:
            'Upload finished, but the file state changed before the result could be recorded.',
        };
      }

      file.status = UploadStatus.Uploaded;
      file.storageTempPath = uploadedPath;
      file.errorMessage = null;

      return { fileId: file.id, success: true, storageTempPath: uploadedPath, errorMessage: null };
    } catch (error) {
      await logError('upload.uploadFile', error, {
        fileId: file.id,
        filePath: file.filePath,
        fileName: file.fileName,
        remotePath,
      });
      const message = error instanceof Error ? error.message : String(error);

      try {
        await this.lifecycle.markUploadFailedAsync(file.id, message, {
          incrementRetry: true,
          maxRetries: appConfig.UploadSettings.MaxRetries,
        });
      } catch (persistError) {
        // Preserve the original upload error; a persistence failure should not
        // hide why the transfer failed.
        await logError('upload.persistFailureState', persistError, {
          fileId: file.id,
          filePath: file.filePath,
          errorMessage: message,
        });
      }

      await this.refreshFromRepositoryAsync(file);
      return { fileId: file.id, success: false, storageTempPath: remotePath, errorMessage: message };
    } finally {
      this.inProgress.delete(file.id);
    }
  }

  async uploadBatchAsync(
    files: FileEntity[],
    options?: UploadTransferOptions,
  ): Promise<UploadBatchResult> {
    const pending = [...files];
    if (pending.length === 0) {
      return { results: [], batchSize: this.batchSize(), batchCount: 0 };
    }

    const batchSize = this.batchSize();
    const maxBatchBytes = appConfig.UploadSettings.MaxConcurrentBytes;
    const results: UploadResult[] = [];
    let batchCount = 0;
    let index = 0;

    while (index < pending.length) {
      const batch: FileEntity[] = [];
      let batchBytes = 0;

      while (index < pending.length && batch.length < batchSize) {
        const file = pending[index];
        const declaredBytes = Number.isFinite(file.fileSize)
          ? Math.max(0, file.fileSize)
          : 0;
        const overBudget =
          maxBatchBytes > 0 && batch.length > 0 && batchBytes + declaredBytes > maxBatchBytes;

        // Stop before exceeding the byte budget; the file starts the next batch.
        if (overBudget) {
          break;
        }

        batch.push(file);
        batchBytes += declaredBytes;
        index += 1;

        // A single file larger than the budget is allowed to run alone.
        if (maxBatchBytes > 0 && declaredBytes > maxBatchBytes) {
          break;
        }
      }

      batchCount += 1;
      const batchResults = await Promise.all(
        batch.map((file) =>
          this.uploadFileAsync(file, this.buildStorageTempPath(file), options),
        ),
      );
      results.push(...batchResults);
    }

    return { results, batchSize, batchCount };
  }

  isUploadInProgress(fileId: string): boolean {
    return this.inProgress.has(fileId);
  }

  private batchSize(): number {
    return Math.max(1, appConfig.UploadSettings.BatchSize);
  }

  /** Pulls the persisted row back into the caller's entity after a transition. */
  private async refreshFromRepositoryAsync(file: FileEntity): Promise<void> {
    try {
      const fresh = await this.fileRepository.getByIdAsync(file.id);
      if (fresh) {
        Object.assign(file, fresh);
      }
    } catch (error) {
      await logError('upload.refreshEntity', error, { fileId: file.id });
    }
  }
}
