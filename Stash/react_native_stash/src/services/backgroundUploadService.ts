/**
 * Platform-independent background upload pass. The service is intentionally
 * idempotent because schedulers may invoke it more than once and may kill it
 * without warning. Mirrors Stash.Maui/Services/BackgroundUploadService.cs.
 *
 * Pass: stale recovery -> auth check -> flush pending outbox -> scan enabled
 * folders (dedup by content hash) -> lifecycle candidate selection -> batch
 * upload -> durable outbox publish -> final flush; dead-letter files that have
 * exhausted their transfer or host retry budgets.
 */
import {
  ensureValidAccessTokenAsync,
  getOrCreateDeviceIdAsync,
  getUserIdAsync,
} from '../auth/authenticationService';
import { appConfig } from '../config/appConfig';
import type { FileRepository } from '../data/fileRepository';
import type { FolderRepository } from '../data/folderRepository';
import type { FileEntity } from '../models/fileEntity';
import { UploadStatus } from '../models/uploadStatus';
import { logError } from '../utils/errorLogger';
import { localFileExistsAsync } from '../utils/fileAccess';
import type { FileLifecycleService } from './fileLifecycleService';
import type { FolderIngestionService } from './folderIngestionService';
import type { KafkaProducer } from './kafkaProducer';
import type { OutboxPublisher } from './outboxPublisher';
import type { UploadManager } from './uploadManager';
import { recordBackgroundPass } from './runtimeState';

export interface BackgroundUploadResult {
  alreadyRunning: boolean;
  success: boolean;
  scanned: number;
  discovered: number;
  uploaded: number;
  queued: number;
  failed: number;
  recoveredUploads?: number;
  recoveredProcessing?: number;
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface BackgroundUploadDeps {
  folderRepository: FolderRepository;
  fileRepository: FileRepository;
  uploadManager: UploadManager;
  lifecycle: FileLifecycleService;
  outboxPublisher: OutboxPublisher;
  kafkaProducer: KafkaProducer;
  folderIngestion: FolderIngestionService;
}

export class BackgroundUploadService {
  private runGate = false;

  constructor(private readonly deps: BackgroundUploadDeps) {}

  async runOnceAsync(): Promise<BackgroundUploadResult> {
    if (this.runGate) {
      return this.finish(emptyResult({ alreadyRunning: true }));
    }
    this.runGate = true;

    let scanned = 0;
    let discovered = 0;
    let uploaded = 0;
    let queued = 0;
    let failed = 0;
    let recoveredUploads = 0;
    let recoveredProcessing = 0;

    try {
      const maxRetries = Math.max(0, appConfig.UploadSettings.MaxRetries);
      const maxHostRetries = Math.max(0, appConfig.UploadSettings.MaxHostRetries);

      // Recover crash/kill leftovers before deciding what is eligible.
      const recovery = await this.deps.lifecycle.recoverStaleAsync({
        maxRetries,
        maxHostRetries,
      });
      recoveredUploads = recovery.recoveredUploads;
      recoveredProcessing = recovery.recoveredProcessing;

      const authenticated = await ensureValidAccessTokenAsync();
      if (!authenticated) {
        return this.finish(
          emptyResult({
            success: false,
            recoveredUploads,
            recoveredProcessing,
            error: 'Background upload requires an authenticated session.',
          }),
        );
      }

      await this.flushOutboxAsync();

      const deviceId = await getOrCreateDeviceIdAsync();
      const userId = await getUserIdAsync();

      // Phase 1: scan enabled folders and persist new files (deduplicated by hash).
      const folders = (await this.deps.folderRepository.getAllAsync()).filter(
        (folder) => folder.isEnabled,
      );

      for (const folder of folders) {
        try {
          const result = await this.deps.folderIngestion.ingestFolderAsync(
            folder,
            deviceId,
            userId,
          );
          scanned += result.scanned;
          discovered += result.discovered;
        } catch (error) {
          await logError('backgroundUpload.scanFolder', error, { folderPath: folder.folderPath });
        }
      }

      // Phase 2: lifecycle-owned candidate selection (status, budgets, backoff,
      // and "no active outbox row" are all enforced in one query).
      const configuredMax = appConfig.BackgroundUpload.MaxFilesPerRun;
      const maxFiles = configuredMax <= 0 ? Number.MAX_SAFE_INTEGER : configuredMax;

      const candidateRows = await this.deps.lifecycle.getCandidatesAsync(
        maxFiles,
        maxRetries,
        maxHostRetries,
      );
      const candidates: FileEntity[] = [];
      for (const file of candidateRows) {
        if (!(await localFileExistsAsync(file.filePath))) {
          await this.deps.lifecycle.markLocalMissingAsync(file.id, 'Local file not found.');
          continue;
        }
        candidates.push(file);
      }

      if (candidates.length === 0) {
        await this.flushOutboxAsync();
        return this.finish(
          emptyResult({
            scanned,
            discovered,
            uploaded,
            queued,
            failed,
            recoveredUploads,
            recoveredProcessing,
          }),
        );
      }

      for (const candidate of candidates) {
        if (!candidate.deviceId || !candidate.userId) {
          const fileDeviceId = candidate.deviceId || deviceId;
          const fileUserId = candidate.userId || userId;
          await this.deps.fileRepository.setOwnershipAsync(
            candidate.id,
            fileDeviceId,
            fileUserId,
          );
          candidate.deviceId = fileDeviceId;
          candidate.userId = fileUserId;
        }
      }

      // Phase 3: batch upload, then queue durable publish intents.
      const batch = await this.deps.uploadManager.uploadBatchAsync(candidates);

      for (const uploadResult of batch.results) {
        const file = candidates.find((candidate) => candidate.id === uploadResult.fileId);

        if (!uploadResult.success) {
          failed += 1;
          if (file) {
            const fresh = await this.deps.fileRepository.getByIdAsync(file.id);
            if (fresh) {
              await this.maybeProduceDeadLetterAsync(fresh, maxRetries, maxHostRetries);
            }
          }
          continue;
        }

        uploaded += 1;

        if (!file) {
          failed += 1;
          continue;
        }

        if (!file.storageTempPath) {
          await this.deps.lifecycle.markTerminalFailureAsync(
            file.id,
            'upload',
            'Upload completed without a temporary storage path.',
          );
          failed += 1;
          continue;
        }

        let outcomeQueued = false;
        try {
          const outcome = await this.deps.outboxPublisher.enqueueAndFlushAsync(
            file,
            deviceId,
            userId,
          );
          outcomeQueued = outcome.queued;
          if (!outcome.queued) {
            console.warn(
              `Publish intent was not queued for file ${file.id}: ${
                outcome.error ?? 'unknown error'
              }`,
            );
          }
        } catch (error) {
          console.warn(
            `Could not persist the publish intent for file ${file.id}: ${messageOf(error)}`,
          );
        }

        if (outcomeQueued) {
          queued += 1;
          continue;
        }

        failed += 1;
        const fresh = await this.deps.fileRepository.getByIdAsync(file.id);
        if (fresh) {
          await this.maybeProduceDeadLetterAsync(fresh, maxRetries, maxHostRetries);
        }
      }

      await this.flushOutboxAsync();

      console.info(
        `Background upload pass: scanned=${scanned}, discovered=${discovered}, ` +
          `uploaded=${uploaded}, queued=${queued}, failed=${failed}, ` +
          `recoveredUploads=${recoveredUploads}, recoveredProcessing=${recoveredProcessing}.`,
      );
      return this.finish(
        emptyResult({
          scanned,
          discovered,
          uploaded,
          queued,
          failed,
          recoveredUploads,
          recoveredProcessing,
        }),
      );
    } catch (error) {
      await logError('backgroundUpload.pass', error);
      const message = error instanceof Error ? error.message : String(error);
      return this.finish(
        emptyResult({
          success: false,
          scanned,
          discovered,
          uploaded,
          queued,
          failed,
          recoveredUploads,
          recoveredProcessing,
          error: message,
        }),
      );
    } finally {
      this.runGate = false;
    }
  }

  /** Records the pass outcome for diagnostics, then returns it unchanged. */
  private finish(result: BackgroundUploadResult): BackgroundUploadResult {
    recordBackgroundPass(result);
    return result;
  }

  private async flushOutboxAsync(): Promise<void> {
    try {
      await this.deps.outboxPublisher.flushAsync();
    } catch (error) {
      // A flush failure must not stop the pass; per-row failures are already
      // retried or dead-lettered inside the publisher.
      console.warn(`Outbox flush failed during the background pass: ${messageOf(error)}`);
    }
  }

  /**
   * Documented dead-letter behaviour: when a file has exhausted the transfer or
   * host retry budget, publish its failure details to the DLQ topic (best
   * effort, always using the freshly reloaded row).
   */
  private async maybeProduceDeadLetterAsync(
    file: FileEntity,
    maxRetries: number,
    maxHostRetries: number,
  ): Promise<void> {
    const exhausted =
      file.retryCount >= maxRetries || file.hostRetryCount >= maxHostRetries;
    if (file.status !== UploadStatus.Failed || !exhausted) {
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
          hostRetryCount: file.hostRetryCount,
          failureStage: file.failureStage,
          lastResponseAt: file.lastResponseAt,
          lastAttemptAt: file.lastAttemptAt,
          deviceId: file.deviceId,
          userId: file.userId,
          timestamp: new Date().toISOString(),
        }),
        file.errorMessage ?? 'Maximum retries exceeded',
      );
    } catch (error) {
      console.warn(`Dead letter production failed for file ${file.id}: ${messageOf(error)}`);
    }
  }
}
