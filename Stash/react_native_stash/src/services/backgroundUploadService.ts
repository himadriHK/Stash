/**
 * Platform-independent background upload pass. The service is intentionally
 * idempotent because schedulers may invoke it more than once and may kill it
 * without warning. Mirrors Stash.Maui/Services/BackgroundUploadService.cs.
 *
 * Pass: auth check -> scan enabled folders (dedup by content hash) -> filter
 * upload candidates -> batch upload -> publish Kafka upload requests ->
 * apply statuses; dead-letter files that exhausted their retries.
 */
import {
  ensureValidAccessTokenAsync,
  getOrCreateDeviceIdAsync,
  getUserIdAsync,
} from '../auth/authenticationService';
import { appConfig } from '../config/appConfig';
import type { FileRepository } from '../data/fileRepository';
import type { FolderRepository } from '../data/folderRepository';
import { createFileEntity, type FileEntity } from '../models/fileEntity';
import { createUploadRequestMessage } from '../models/messages';
import { UploadStatus } from '../models/uploadStatus';
import { logError } from '../utils/errorLogger';
import { localFileExistsAsync } from '../utils/fileAccess';
import type { FolderScannerService } from './folderScannerService';
import { mimeTypeForFile } from './folderScannerService';
import type { KafkaProducer } from './kafkaProducer';
import type { UploadManager } from './uploadManager';

export interface BackgroundUploadResult {
  alreadyRunning: boolean;
  success: boolean;
  scanned: number;
  discovered: number;
  uploaded: number;
  queued: number;
  failed: number;
  error?: string;
}

function emptyResult(overrides: Partial<BackgroundUploadResult> = {}): BackgroundUploadResult {
  return {
    alreadyRunning: false,
    success: true,
    scanned: 0,
    discovered: 0,
    uploaded: 0,
    queued: 0,
    failed: 0,
    ...overrides,
  };
}

export function isUploadCandidate(file: FileEntity, maxRetries: number): boolean {
  switch (file.status) {
    case UploadStatus.Pending:
    case UploadStatus.Retrying:
    case UploadStatus.Uploaded:
      return true;
    case UploadStatus.Failed:
      return file.retryCount < maxRetries;
    default:
      return false;
  }
}

export interface BackgroundUploadDeps {
  folderRepository: FolderRepository;
  scanner: FolderScannerService;
  fileRepository: FileRepository;
  uploadManager: UploadManager;
  kafkaProducer: KafkaProducer;
}

export class BackgroundUploadService {
  private runGate = false;

  constructor(private readonly deps: BackgroundUploadDeps) {}

  async runOnceAsync(): Promise<BackgroundUploadResult> {
    if (this.runGate) {
      return emptyResult({ alreadyRunning: true });
    }
    this.runGate = true;

    let scanned = 0;
    let discovered = 0;
    let uploaded = 0;
    let queued = 0;
    let failed = 0;

    try {
      const authenticated = await ensureValidAccessTokenAsync();
      if (!authenticated) {
        return emptyResult({
          success: false,
          error: 'Background upload requires an authenticated session.',
        });
      }

      const deviceId = await getOrCreateDeviceIdAsync();
      const userId = await getUserIdAsync();

      // Phase 1: scan enabled folders and persist new files (deduplicated by hash).
      const folders = (await this.deps.folderRepository.getAllAsync()).filter(
        (folder) => folder.isEnabled,
      );

      for (const folder of folders) {
        try {
          const found = await this.deps.scanner.scanFolderAsync(folder);
          for (const file of found) {
            scanned += 1;
            const hash = await this.deps.scanner.computeFileHashAsync(file.uri, file.size);
            if (!hash) {
              continue;
            }
            if (await this.deps.fileRepository.existsByContentHashAsync(hash)) {
              continue;
            }
            await this.deps.fileRepository.addAsync(
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
          await this.deps.folderRepository.updateAsync(folder);
        } catch (error) {
          await logError('backgroundUpload.scanFolder', error, { folderPath: folder.folderPath });
        }
      }

      // Phase 2: collect upload candidates (documented eligibility rules).
      const maxRetries = Math.max(0, appConfig.UploadSettings.MaxRetries);
      const configuredMax = appConfig.BackgroundUpload.MaxFilesPerRun;
      const maxFiles = configuredMax <= 0 ? Number.MAX_SAFE_INTEGER : configuredMax;

      const allFiles = await this.deps.fileRepository.getAllAsync();
      const candidates: FileEntity[] = [];
      for (const file of allFiles) {
        if (candidates.length >= maxFiles) {
          break;
        }
        if (!isUploadCandidate(file, maxRetries)) {
          continue;
        }
        if (!(await localFileExistsAsync(file.filePath))) {
          continue;
        }
        candidates.push(file);
      }

      if (candidates.length === 0) {
        return emptyResult({ scanned, discovered, uploaded, queued, failed });
      }

      for (const candidate of candidates) {
        let changed = false;
        if (!candidate.deviceId) {
          candidate.deviceId = deviceId;
          changed = true;
        }
        if (!candidate.userId) {
          candidate.userId = userId;
          changed = true;
        }
        if (changed) {
          await this.deps.fileRepository.updateAsync(candidate);
        }
      }

      // Phase 3: batch upload, then publish upload requests to Kafka.
      const batch = await this.deps.uploadManager.uploadBatchAsync(candidates);

      for (const uploadResult of batch.results) {
        const file = candidates.find((candidate) => candidate.id === uploadResult.fileId);

        if (!uploadResult.success) {
          failed += 1;
          if (file) {
            await this.maybeProduceDeadLetterAsync(file, maxRetries);
          }
          continue;
        }

        uploaded += 1;

        if (!file) {
          failed += 1;
          continue;
        }

        if (!file.megaTempPath) {
          failed += 1;
          await this.markPublishFailedAsync(
            file,
            'Upload completed without a temporary Mega path.',
            maxRetries,
          );
          continue;
        }

        try {
          await this.deps.kafkaProducer.produceUploadRequestAsync(
            createUploadRequestMessage(file, deviceId, userId),
          );
          file.status = UploadStatus.Processing;
          file.errorMessage = null;
          await this.deps.fileRepository.updateAsync(file);
          queued += 1;
        } catch (error) {
          failed += 1;
          console.warn(`Kafka publish failed for file ${file.id}.`, error);
          const message = error instanceof Error ? error.message : String(error);
          await this.markPublishFailedAsync(file, `Kafka publish failed: ${message}`, maxRetries);
        }
      }

      console.info(
        `Background upload pass: scanned=${scanned}, discovered=${discovered}, ` +
          `uploaded=${uploaded}, queued=${queued}, failed=${failed}.`,
      );
      return emptyResult({ scanned, discovered, uploaded, queued, failed });
    } catch (error) {
      await logError('backgroundUpload.pass', error);
      const message = error instanceof Error ? error.message : String(error);
      return emptyResult({
        success: false,
        scanned,
        discovered,
        uploaded,
        queued,
        failed,
        error: message,
      });
    } finally {
      this.runGate = false;
    }
  }

  private async markPublishFailedAsync(
    file: FileEntity,
    errorMessage: string,
    maxRetries: number,
  ): Promise<void> {
    file.status = UploadStatus.Failed;
    file.errorMessage = errorMessage;
    file.retryCount += 1;
    file.lastAttemptAt = new Date().toISOString();

    try {
      await this.deps.fileRepository.updateAsync(file);
    } catch (error) {
      console.error(`Failed to persist Kafka failure state for file ${file.id}.`, error);
    }

    await this.maybeProduceDeadLetterAsync(file, maxRetries);
  }

  /**
   * Documented dead-letter behaviour: when a file has exhausted its retries,
   * publish its failure details to the DLQ topic (best effort).
   */
  private async maybeProduceDeadLetterAsync(
    file: FileEntity,
    maxRetries: number,
  ): Promise<void> {
    if (file.status !== UploadStatus.Failed || file.retryCount < maxRetries) {
      return;
    }
    try {
      await this.deps.kafkaProducer.produceDeadLetterAsync(
        file.contentHash,
        JSON.stringify({
          fileId: file.contentHash,
          fileName: file.fileName,
          filePath: file.filePath,
          fileSize: file.fileSize,
          error: file.errorMessage,
          retryCount: file.retryCount,
          lastAttemptAt: file.lastAttemptAt,
          deviceId: file.deviceId,
          userId: file.userId,
          timestamp: new Date().toISOString(),
        }),
        file.errorMessage ?? 'Maximum retries exceeded',
      );
    } catch (error) {
      console.warn(`Dead letter production failed for file ${file.id}.`, error);
    }
  }
}
