/**
 * UploadManager - streams local files to the storage provider and persists
 * each Pending -> Uploading -> Uploaded/Failed transition in the local
 * database. Mirrors Stash.Maui/Services/UploadManager.cs.
 */
import { appConfig } from '../config/appConfig';
import type { FileRepository } from '../data/fileRepository';
import type { FileEntity } from '../models/fileEntity';
import { UploadStatus } from '../models/uploadStatus';
import { logError } from '../utils/errorLogger';
import { localFileExistsAsync, localFileSizeAsync } from '../utils/fileAccess';
import type { MegaHttpService } from './megaHttpService';

export interface UploadResult {
  fileId: string;
  success: boolean;
  megaTempPath: string | null;
  errorMessage: string | null;
}

export interface UploadBatchResult {
  results: UploadResult[];
  batchSize: number;
  batchCount: number;
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
    private readonly storage: MegaHttpService,
    private readonly fileRepository: FileRepository,
  ) {}

  /**
   * Builds the documented temporary Mega path:
   * `/temp/uploads/{deviceId}/{fileName}`
   */
  buildMegaTempPath(file: FileEntity): string {
    const deviceId = file.deviceId && file.deviceId.trim().length > 0
      ? file.deviceId.trim()
      : 'unknown-device';
    const fileName =
      basename(file.fileName) || basename(file.filePath) || file.id.replace(/-/g, '');
    return `/temp/uploads/${deviceId}/${fileName}`;
  }

  async uploadFileAsync(file: FileEntity, megaTempPath?: string): Promise<UploadResult> {
    const remotePath =
      megaTempPath && megaTempPath.trim().length > 0
        ? megaTempPath.trim()
        : this.buildMegaTempPath(file);

    if (this.inProgress.has(file.id)) {
      return {
        fileId: file.id,
        success: false,
        megaTempPath: remotePath,
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
        return await this.markFailedAsync(file, remotePath, 'Local file not found.', false);
      }

      if (file.fileSize <= 0) {
        file.fileSize = await localFileSizeAsync(file.filePath, file.fileSize);
      }

      const maxFileSizeBytes = Math.max(0, appConfig.UploadSettings.MaxFileSizeBytes);
      if (maxFileSizeBytes > 0 && file.fileSize > maxFileSizeBytes) {
        return await this.markFailedAsync(
          file,
          remotePath,
          `File size ${file.fileSize} exceeds the configured limit of ${maxFileSizeBytes} bytes.`,
          false,
        );
      }

      file.status = UploadStatus.Uploading;
      file.megaTempPath = remotePath;
      file.errorMessage = null;
      file.lastAttemptAt = new Date().toISOString();
      await this.fileRepository.updateAsync(file);

      const uploadedPath = await this.storage.uploadFileAsync(
        { uri: file.filePath, name: file.fileName, mimeType: file.mimeType },
        remotePath,
      );

      file.status = UploadStatus.Uploaded;
      file.megaTempPath = uploadedPath;
      file.errorMessage = null;
      await this.fileRepository.updateAsync(file);

      return { fileId: file.id, success: true, megaTempPath: uploadedPath, errorMessage: null };
    } catch (error) {
      await logError('upload.uploadFile', error, {
        fileId: file.id,
        filePath: file.filePath,
        fileName: file.fileName,
        remotePath,
      });
      const message = error instanceof Error ? error.message : String(error);
      return await this.markFailedAsync(file, remotePath, message, true);
    } finally {
      this.inProgress.delete(file.id);
    }
  }

  async uploadBatchAsync(files: FileEntity[]): Promise<UploadBatchResult> {
    const pending = [...files];
    if (pending.length === 0) {
      return { results: [], batchSize: this.batchSize(), batchCount: 0 };
    }

    const batchSize = this.batchSize();
    const results: UploadResult[] = [];
    let batchCount = 0;

    for (let offset = 0; offset < pending.length; offset += batchSize) {
      batchCount += 1;
      const batch = pending.slice(offset, offset + batchSize);
      const batchResults = await Promise.all(
        batch.map((file) => this.uploadFileAsync(file, this.buildMegaTempPath(file))),
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

  private async markFailedAsync(
    file: FileEntity,
    remotePath: string,
    errorMessage: string,
    incrementRetry: boolean,
  ): Promise<UploadResult> {
    file.status = UploadStatus.Failed;
    file.megaTempPath = remotePath;
    file.errorMessage = errorMessage;
    file.lastAttemptAt = new Date().toISOString();
    if (incrementRetry) {
      file.retryCount += 1;
    }

    try {
      await this.fileRepository.updateAsync(file);
    } catch (updateError) {
      // Preserve the original upload error; a local persistence failure should
      // not hide why the upload failed.
      await logError('upload.persistFailureState', updateError, {
        fileId: file.id,
        filePath: file.filePath,
        errorMessage,
      });
    }

    return { fileId: file.id, success: false, megaTempPath: remotePath, errorMessage };
  }
}
