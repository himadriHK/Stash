/**
 * Platform-independent background upload pass. The service is intentionally
 * idempotent because schedulers may invoke it more than once and may kill it
 * without warning. Mirrors Stash.Maui/Services/BackgroundUploadService.cs.
 *
 * Pass: stale recovery -> auth check -> flush pending outbox -> scan enabled
 * folders (dedup by name + size) -> lifecycle candidate selection -> batch
 * upload -> durable outbox publish -> final flush; dead-letter files that have
 * exhausted their transfer or host retry budgets.
 *
 * The pass is chunked end to end and reports progress: scanning 10k files, or
 * checking 10k candidate rows, must never run as one long task on the JS thread.
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
import { computeUploadFileIdForFile } from '../utils/fileIdentity';
import { localFileExistsAsync } from '../utils/fileAccess';
import {
  beginSyncProgress,
  endSyncProgress,
  recordBackgroundPass,
  updateSyncProgress,
} from './runtimeState';
import { forEachChunkedAsync, mapWithConcurrencyAsync } from '../utils/cooperative';
import type { FileLifecycleService } from './fileLifecycleService';
import type { FolderIngestionService } from './folderIngestionService';
import type { KafkaProducer } from './kafkaProducer';
import type { OutboxPublisher } from './outboxPublisher';
import type { UploadManager } from './uploadManager';
import { getUiPreferencesAsync } from './uiPreferences';
import {
  getStorageAccessAsync,
  logStorageAccessBlocker,
} from '../utils/storagePermissions';
import {
  appendProfileReportToFile,
  isProfilerEnabled,
  printProfileSummary,
  profileAsync,
} from '../utils/profiler';

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

/**
 * Page size used when `BackgroundUpload:MaxFilesPerRun` is zero or negative
 * ("no limit"). Loading an unbounded result set onto a phone would exhaust
 * memory; the pass simply keeps requesting full pages until one comes back short.
 */
const UNBOUNDED_CANDIDATE_LIMIT = 500;
/** Candidates whose local presence is probed at the same time. */
const EXISTENCE_CHECK_CONCURRENCY = 8;
/** Candidates processed per chunk when probing local files and ownership. */
const CANDIDATE_CHUNK_SIZE = 250;

export class BackgroundUploadService {
  private runGate = false;
  private progressActive = false;

  constructor(private readonly deps: BackgroundUploadDeps) {}

  async runOnceAsync(): Promise<BackgroundUploadResult> {
    if (this.runGate) {
      return this.finish(emptyResult({ alreadyRunning: true }));
    }
    this.runGate = true;
    try {
      return await profileAsync('background.pass', () => this.runPassAsync(), {
        attrs: { source: 'scheduled' },
      });
    } finally {
      this.runGate = false;
      // After each pass, surface the cumulative function-level profile so the
      // bottlenecks of that pass are visible in the console and the profile log.
      if (isProfilerEnabled()) {
        printProfileSummary({ top: 20 });
        void appendProfileReportToFile('background.pass');
      }
    }
  }

  private async runPassAsync(): Promise<BackgroundUploadResult> {
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
      const recovery = await profileAsync(
        'background.recoverStale',
        () => this.deps.lifecycle.recoverStaleAsync({ maxRetries, maxHostRetries }),
        { sentry: false },
      );
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

      await profileAsync('background.flushOutbox', () => this.flushOutboxAsync(), {
        sentry: false,
      });

      const deviceId = await getOrCreateDeviceIdAsync();
      const userId = await getUserIdAsync();

      // Phase 1: scan enabled folders and persist new files (deduplicated by hash).
      const folders = (await this.deps.folderRepository.getAllAsync()).filter(
        (folder) => folder.isEnabled,
      );

      if (folders.length > 0) {
        // A background task cannot show the Android permission dialog, so a
        // missing storage permission must not turn the pass into per-folder
        // permission errors. SAF (content://) folders need no runtime
        // permission; the foreground "Sync now" path prompts instead.
        const storageAccess = await getStorageAccessAsync();
        if (storageAccess.state !== 'granted' && storageAccess.state !== 'unsupported') {
          await logStorageAccessBlocker(storageAccess);
          console.warn(
            `Background folder scan skipped: storage access is ${storageAccess.summary}. ${storageAccess.detail}`,
          );
        } else {
          this.ensureProgress('scanning', 0);

          await profileAsync(
            'background.scanFolders',
            async () => {
              for (const folder of folders) {
                try {
                  const result = await this.deps.folderIngestion.ingestFolderAsync(
                    folder,
                    deviceId,
                    userId,
                    (progress) => {
                      if (progress.total > 0) {
                        updateSyncProgress('scanning', progress.processed, progress.total);
                      }
                    },
                  );
                  scanned += result.scanned;
                  discovered += result.discovered;
                } catch (error) {
                  await logError('backgroundUpload.scanFolder', error, {
                    folderPath: folder.folderPath,
                  });
                }
              }
            },
            { attrs: { folders: folders.length } },
          );
        }
      }

      // Phase 2: lifecycle-owned candidate selection (status, budgets, backoff,
      // and "no active outbox row" are all enforced in one query).
      const configuredMax = appConfig.BackgroundUpload.MaxFilesPerRun;
      // `MaxFilesPerRun` bounds one candidate page, not the whole pass: the page
      // loop below keeps selecting and uploading pages until nothing eligible is
      // left, so one "Sync now" (or one background run) drains the backlog in
      // batches instead of requiring a new trigger per page.
      const pageSize =
        configuredMax <= 0 ? UNBOUNDED_CANDIDATE_LIMIT : Math.min(configuredMax, UNBOUNDED_CANDIDATE_LIMIT);

      const preferences = await getUiPreferencesAsync().catch(() => null);
      const includeVideos = preferences?.backupVideos ?? true;

      // A row whose state does not change on upload would be selected again by
      // the next page query, so each file is attempted at most once per pass.
      const attempted = new Set<string>();
      let totalKnown = 0;
      let completedFiles = 0;
      let progressStarted = false;

      for (;;) {
        const candidateRows = await profileAsync(
          'background.candidates',
          () => this.deps.lifecycle.getCandidatesAsync(pageSize, maxRetries, maxHostRetries),
          { sentry: false },
        );

        // Videos excluded by preference are still marked attempted so a page
        // made up entirely of them cannot stall the loop on the same rows.
        const unattempted = candidateRows.filter((file) => !attempted.has(file.id));
        if (unattempted.length === 0) {
          break;
        }
        for (const file of unattempted) {
          attempted.add(file.id);
        }

        const videoFree = includeVideos
          ? unattempted
          : unattempted.filter((file) => !file.mimeType.toLowerCase().startsWith('video/'));

        // Presence checks fan out through a bounded pool; a serial loop over the
        // page is hundreds of bridge round trips with no UI breathing room.
        const existing = await profileAsync(
          'background.existenceChecks',
          () =>
            mapWithConcurrencyAsync(
              videoFree,
              EXISTENCE_CHECK_CONCURRENCY,
              async (file) => ({ file, present: await localFileExistsAsync(file.filePath) }),
            ),
          { sentry: false },
        );

        const candidates: FileEntity[] = [];
        const missing: FileEntity[] = [];
        for (const entry of existing) {
          if (entry.present) {
            candidates.push(entry.file);
          } else {
            missing.push(entry.file);
          }
        }

        for (const file of missing) {
          await this.deps.lifecycle.markLocalMissingAsync(file.id, 'Local file not found.');
        }

        if (candidates.length === 0) {
          // A short page means nothing is left behind it; a full page of
          // untransferable rows (missing files, excluded videos) means the next
          // page may still hold work.
          if (candidateRows.length < pageSize) {
            break;
          }
          continue;
        }

        totalKnown += candidates.length;
        if (!progressStarted) {
          this.ensureProgress('uploading', totalKnown);
          progressStarted = true;
        }

        // Ownership is stamped per chunk in one transaction, not one write per row.
        const missingOwners = candidates
          .filter((candidate) => !candidate.deviceId || !candidate.userId)
          .map((candidate) => {
            candidate.deviceId = candidate.deviceId || deviceId;
            candidate.userId = candidate.userId || userId;
            return candidate.id;
          });

        if (missingOwners.length > 0) {
          await forEachChunkedAsync(
            missingOwners,
            async (chunk) => {
              await this.deps.fileRepository.setOwnershipManyAsync(chunk, deviceId, userId);
            },
            { chunkSize: CANDIDATE_CHUNK_SIZE },
          );
        }

        // Phase 3: batch upload, then queue durable publish intents.
        const batch = await profileAsync(
          'background.uploadBatch',
          () =>
            this.deps.uploadManager.uploadBatchAsync(candidates, undefined, {
              onProgress: (processed) =>
                updateSyncProgress('uploading', completedFiles + processed, totalKnown),
            }),
          { attrs: { candidates: candidates.length } },
        );

        const filesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
        const uploadedFiles: FileEntity[] = [];

        for (const uploadResult of batch.results) {
          const file = filesById.get(uploadResult.fileId);

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

          uploadedFiles.push(file);
        }

        completedFiles += candidates.length;

        if (uploadedFiles.length > 0) {
          updateSyncProgress('publishing', 0, uploadedFiles.length);
          try {
            const publish = await profileAsync(
              'background.publish',
              () =>
                this.deps.outboxPublisher.enqueueManyAsync(
                  uploadedFiles,
                  deviceId,
                  userId,
                  (processed) =>
                    updateSyncProgress('publishing', processed, uploadedFiles.length),
                ),
              { attrs: { files: uploadedFiles.length } },
            );
            queued += publish.queued;
            failed += publish.failed;
            if (publish.dead > 0) {
              console.warn(`Outbox dead-lettered ${publish.dead} upload request(s) during the pass.`);
            }
          } catch (error) {
            console.warn(
              `Could not persist publish intents for ${uploadedFiles.length} file(s): ${messageOf(error)}`,
            );
            failed += uploadedFiles.length;
          }
        }
      }

      await profileAsync('background.flushOutbox', () => this.flushOutboxAsync(), {
        sentry: false,
      });

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
    }
  }

  /** Records the pass outcome for diagnostics, then returns it unchanged. */
  private finish(result: BackgroundUploadResult): BackgroundUploadResult {
    recordBackgroundPass(result);
    if (this.progressActive) {
      this.progressActive = false;
      endSyncProgress();
    }
    return result;
  }

  /**
   * Starts the progress banner on the first phase that has work, or moves an
   * already-running banner to the next phase.
   */
  private ensureProgress(phase: 'scanning' | 'uploading', total: number): void {
    if (this.progressActive) {
      updateSyncProgress(phase, 0, total);
      return;
    }
    beginSyncProgress(phase, total);
    this.progressActive = true;
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
      const hostFileId = await computeUploadFileIdForFile(file);
      await this.deps.kafkaProducer.produceDeadLetterAsync(
        hostFileId,
        JSON.stringify({
          fileId: hostFileId,
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