import type { SQLiteDatabase } from 'expo-sqlite';
import { appConfig } from '../config/appConfig';
import { getDatabase } from '../data/database';
import { runTransactionAsync } from '../data/transactionQueue';
import {
  FileRepository,
  isTerminalStatus,
} from '../data/fileRepository';
import {
  FileEventRepository,
  insertFileEventWithDbAsync,
  type FileEvent,
} from '../data/fileEventRepository';
import {
  ProcessedMessageRepository,
  recordProcessedMessageWithDbAsync,
} from '../data/processedMessageRepository';
import type { FileEntity } from '../models/fileEntity';
import type { UploadResponseMessage } from '../models/messages';
import { shouldYield, yieldToEventLoop } from '../utils/cooperative';
import { profileAsync } from '../utils/profiler';
import { computeNextAttemptAt, nowIso } from './retryPolicy';

const DEFAULT_STALE_TIMEOUT_MS = 30 * 60 * 1000;
/** Rows processed between yields while recovering interrupted transfers. */
const RECOVERY_YIELD_INTERVAL = 50;
const UPLOAD_INTERRUPTED_MESSAGE = 'Upload interrupted before completion.';
const HOST_TIMEOUT_MESSAGE = 'Timed out waiting for host response.';
const HOST_FAILURE_MESSAGE = 'Host processing failed.';
const NON_TERMINAL_STATUSES = "('Completed', 'Deduplicated')";
const UPLOAD_ALLOWED_STATUSES = "('Pending', 'Retrying', 'Failed', 'Uploaded')";

export interface MarkUploadFailedOptions {
  incrementRetry?: boolean;
  terminal?: boolean;
  maxRetries?: number;
}

export interface RecoveryOptions {
  uploadTimeoutMs?: number;
  processingTimeoutMs?: number;
  maxRetries: number;
  maxHostRetries: number;
}

export interface RecoveryResult {
  recoveredUploads: number;
  recoveredProcessing: number;
}

export type ApplyResponseOutcome = 'applied' | 'ignored' | 'duplicate' | 'mismatch' | 'stale';

async function readStatusAsync(db: SQLiteDatabase, fileId: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ status: string }>(
    'SELECT status FROM files WHERE id = ?',
    [fileId],
  );
  return row?.status ?? null;
}

export class FileLifecycleService {
  constructor(
    private readonly open: () => Promise<SQLiteDatabase> = getDatabase,
    private readonly files: FileRepository = new FileRepository(open),
    private readonly events: FileEventRepository = new FileEventRepository(open),
    private readonly processedMessages: ProcessedMessageRepository =
      new ProcessedMessageRepository(open),
  ) {}

  async markUploadingAsync(fileId: string, storageTempPath: string): Promise<boolean> {
    const db = await this.open();
    let applied = false;
    await runTransactionAsync(db, async () => {
      const fromStatus = await readStatusAsync(db, fileId);
      const now = nowIso();
      const result = await db.runAsync(
        `UPDATE files SET
          status = 'Uploading',
          upload_started_at = ?,
          last_attempt_at = ?,
          storage_temp_path = ?,
          error_message = NULL,
          failure_stage = NULL,
          next_attempt_at = NULL,
          updated_at = ?
         WHERE id = ? AND status IN ${UPLOAD_ALLOWED_STATUSES}`,
        [now, now, storageTempPath, now, fileId],
      );
      if (result.changes === 0) {
        return;
      }
      applied = true;
      await insertFileEventWithDbAsync(db, {
        fileId,
        event: 'upload_started',
        fromStatus,
        toStatus: 'Uploading',
      });
    });
    return applied;
  }

  async markUploadedAsync(fileId: string, storageTempPath: string): Promise<boolean> {
    const db = await this.open();
    let applied = false;
    await runTransactionAsync(db, async () => {
      const now = nowIso();
      const result = await db.runAsync(
        `UPDATE files SET
          status = 'Uploaded',
          storage_temp_path = ?,
          upload_started_at = NULL,
          error_message = NULL,
          updated_at = ?
         WHERE id = ? AND status = 'Uploading'`,
        [storageTempPath, now, fileId],
      );
      if (result.changes === 0) {
        return;
      }
      applied = true;
      await insertFileEventWithDbAsync(db, {
        fileId,
        event: 'upload_completed',
        fromStatus: 'Uploading',
        toStatus: 'Uploaded',
      });
    });
    return applied;
  }

  async markUploadFailedAsync(
    fileId: string,
    errorMessage: string,
    opts: MarkUploadFailedOptions = {},
  ): Promise<boolean> {
    const db = await this.open();
    const maxRetries = Number.isFinite(opts.maxRetries)
      ? Math.max(0, Math.floor(opts.maxRetries as number))
      : Math.max(0, Math.floor(appConfig.UploadSettings.MaxRetries));
    let applied = false;
    await runTransactionAsync(db, async () => {
      const row = await db.getFirstAsync<{ status: string; retry_count: number }>(
        'SELECT status, retry_count FROM files WHERE id = ?',
        [fileId],
      );
      if (!row || (row.status !== 'Uploading' && row.status !== 'Pending')) {
        return;
      }
      const retryCount = row.retry_count + (opts.incrementRetry === false ? 0 : 1);
      const terminal = opts.terminal === true || retryCount >= maxRetries;
      const nextAttemptAt = terminal ? null : computeNextAttemptAt(retryCount);
      const now = nowIso();
      const result = await db.runAsync(
        `UPDATE files SET
          status = 'Failed',
          failure_stage = 'upload',
          error_message = ?,
          last_attempt_at = ?,
          upload_started_at = NULL,
          retry_count = ?,
          next_attempt_at = ?,
          updated_at = ?
         WHERE id = ? AND status IN ('Uploading', 'Pending')`,
        [errorMessage, now, retryCount, nextAttemptAt, now, fileId],
      );
      if (result.changes === 0) {
        return;
      }
      applied = true;
      await insertFileEventWithDbAsync(db, {
        fileId,
        event: 'upload_failed',
        fromStatus: row.status,
        toStatus: 'Failed',
        errorCode: 'upload_failed',
        metadata: { retryCount, terminal },
      });
    });
    return applied;
  }

  async markLocalMissingAsync(fileId: string, errorMessage: string): Promise<boolean> {
    const db = await this.open();
    let applied = false;
    await runTransactionAsync(db, async () => {
      const fromStatus = await readStatusAsync(db, fileId);
      const now = nowIso();
      const result = await db.runAsync(
        `UPDATE files SET
          status = 'Failed',
          failure_stage = 'local',
          error_message = ?,
          next_attempt_at = NULL,
          updated_at = ?
         WHERE id = ? AND status NOT IN ${NON_TERMINAL_STATUSES}`,
        [errorMessage, now, fileId],
      );
      if (result.changes === 0) {
        return;
      }
      applied = true;
      await insertFileEventWithDbAsync(db, {
        fileId,
        event: 'local_missing',
        fromStatus,
        toStatus: 'Failed',
        errorCode: 'local_missing',
      });
    });
    return applied;
  }

  async markTerminalFailureAsync(
    fileId: string,
    stage: string,
    errorMessage: string,
  ): Promise<boolean> {
    const db = await this.open();
    let applied = false;
    await runTransactionAsync(db, async () => {
      const fromStatus = await readStatusAsync(db, fileId);
      const now = nowIso();
      const result = await db.runAsync(
        `UPDATE files SET
          status = 'Failed',
          failure_stage = ?,
          error_message = ?,
          next_attempt_at = NULL,
          updated_at = ?
         WHERE id = ? AND status NOT IN ${NON_TERMINAL_STATUSES}`,
        [stage, errorMessage, now, fileId],
      );
      if (result.changes === 0) {
        return;
      }
      applied = true;
      await insertFileEventWithDbAsync(db, {
        fileId,
        event: 'terminal_failure',
        fromStatus,
        toStatus: 'Failed',
        errorCode: stage,
        metadata: { stage },
      });
    });
    return applied;
  }

  async recoverStaleAsync(opts: RecoveryOptions): Promise<RecoveryResult> {
    const db = await this.open();
    const uploadTimeoutMs = Number.isFinite(opts.uploadTimeoutMs)
      ? Math.max(0, Math.floor(opts.uploadTimeoutMs as number))
      : DEFAULT_STALE_TIMEOUT_MS;
    const processingTimeoutMs = Number.isFinite(opts.processingTimeoutMs)
      ? Math.max(0, Math.floor(opts.processingTimeoutMs as number))
      : DEFAULT_STALE_TIMEOUT_MS;
    const maxRetries = Number.isFinite(opts.maxRetries)
      ? Math.max(0, Math.floor(opts.maxRetries))
      : 0;
    const maxHostRetries = Number.isFinite(opts.maxHostRetries)
      ? Math.max(0, Math.floor(opts.maxHostRetries))
      : 0;

    const uploadCutoff = new Date(Date.now() - uploadTimeoutMs).toISOString();
    const uploadRows = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM files
       WHERE status = 'Uploading'
         AND COALESCE(upload_started_at, last_attempt_at, updated_at, discovered_at) < ?`,
      [uploadCutoff],
    );

    let recoveredUploads = 0;
    for (const row of uploadRows) {
      // Startup recovery can walk thousands of interrupted rows; yield so the
      // first screen stays interactive while the database catches up.
      if (shouldYield(recoveredUploads + 1, RECOVERY_YIELD_INTERVAL)) {
        await yieldToEventLoop();
      }
      const applied = await this.markUploadFailedAsync(row.id, UPLOAD_INTERRUPTED_MESSAGE, {
        incrementRetry: true,
        maxRetries,
      });
      if (applied) {
        recoveredUploads += 1;
      }
    }

    const processingCutoff = new Date(Date.now() - processingTimeoutMs).toISOString();
    const processingRows = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM files
       WHERE status = 'Processing'
         AND COALESCE(processing_started_at, last_attempt_at, updated_at) < ?`,
      [processingCutoff],
    );

    let recoveredProcessing = 0;
    for (const row of processingRows) {
      if (shouldYield(recoveredProcessing + 1, RECOVERY_YIELD_INTERVAL)) {
        await yieldToEventLoop();
      }
      let applied = false;
      await runTransactionAsync(db, async () => {
        const current = await db.getFirstAsync<{ host_retry_count: number }>(
          `SELECT COALESCE(host_retry_count, 0) AS host_retry_count
           FROM files WHERE id = ? AND status = 'Processing'`,
          [row.id],
        );
        if (!current) {
          return;
        }
        const hostRetryCount = current.host_retry_count + 1;
        const terminal = hostRetryCount >= maxHostRetries;
        const nextAttemptAt = terminal ? null : computeNextAttemptAt(hostRetryCount);
        const now = nowIso();
        const result = await db.runAsync(
          `UPDATE files SET
            status = 'Failed',
            failure_stage = 'host_timeout',
            error_message = ?,
            host_retry_count = ?,
            next_attempt_at = ?,
            processing_started_at = NULL,
            updated_at = ?
           WHERE id = ? AND status = 'Processing'`,
          [HOST_TIMEOUT_MESSAGE, hostRetryCount, nextAttemptAt, now, row.id],
        );
        if (result.changes === 0) {
          return;
        }
        applied = true;
        await insertFileEventWithDbAsync(db, {
          fileId: row.id,
          event: 'host_timeout',
          fromStatus: 'Processing',
          toStatus: 'Failed',
          errorCode: 'host_timeout',
          metadata: { hostRetryCount, terminal },
        });
      });
      if (applied) {
        recoveredProcessing += 1;
      }
    }

    return { recoveredUploads, recoveredProcessing };
  }

  async getCandidatesAsync(
    limit: number,
    maxRetries: number,
    maxHostRetries: number,
  ): Promise<FileEntity[]> {
    return this.files.getCandidatesAsync(limit, maxRetries, maxHostRetries);
  }

  async countByStatusAsync(): Promise<Record<string, number>> {
    const db = await this.open();
    const rows = await db.getAllAsync<{ status: string; count: number }>(
      'SELECT status, COUNT(*) AS count FROM files GROUP BY status',
    );
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status] = row.count;
    }
    return counts;
  }

  async applyResponseAsync(
    response: UploadResponseMessage,
    maxHostRetries: number,
  ): Promise<ApplyResponseOutcome> {
    return profileAsync(
      'lifecycle.applyResponse',
      () => this.applyResponseInnerAsync(response, maxHostRetries),
      { sentry: false },
    );
  }

  private async applyResponseInnerAsync(
    response: UploadResponseMessage,
    maxHostRetries: number,
  ): Promise<ApplyResponseOutcome> {
    const responseFileId = typeof response.fileId === 'string' ? response.fileId.trim() : '';
    const responseCorrelationId = (response.correlationId ?? '').trim();
    if (!responseFileId || !responseCorrelationId) {
      return 'ignored';
    }

    // The host echoes the client file id and the request correlation id. The
    // outbox stamped the correlation id on the row when it published, so that is
    // the lookup key (the file id is a GUID salted with the metadata hash and is
    // not stored in its own column).
    const file = await this.files.getByRequestCorrelationIdAsync(responseCorrelationId);
    if (!file) {
      return 'ignored';
    }

    const responseDeviceId = (response.deviceId ?? '').trim();
    const fileDeviceId = (file.deviceId ?? '').trim();
    if (
      responseDeviceId.length > 0 &&
      fileDeviceId.length > 0 &&
      responseDeviceId !== fileDeviceId
    ) {
      return 'mismatch';
    }

    const responseUserId = (response.userId ?? '').trim();
    const fileUserId = (file.userId ?? '').trim();
    if (responseUserId.length > 0 && fileUserId.length > 0 && responseUserId !== fileUserId) {
      return 'mismatch';
    }

    if (await this.processedMessages.hasAsync(response.messageId)) {
      return 'duplicate';
    }

    const fileCorrelationId = (file.requestCorrelationId ?? '').trim();
    if (
      responseCorrelationId.length > 0 &&
      fileCorrelationId.length > 0 &&
      responseCorrelationId !== fileCorrelationId
    ) {
      return 'mismatch';
    }

    if (isTerminalStatus(file.status)) {
      return 'stale';
    }

    const status = (response.status ?? '').toUpperCase();
    if (status !== 'COMPLETED' && status !== 'FAILED') {
      return 'ignored';
    }

    const db = await this.open();
    const now = nowIso();
    const eventCorrelationId = responseCorrelationId || fileCorrelationId || null;
    const safeMaxHostRetries = Number.isFinite(maxHostRetries)
      ? Math.max(0, Math.floor(maxHostRetries))
      : 0;
    let outcome: ApplyResponseOutcome = 'stale';

    if (status === 'COMPLETED') {
      await runTransactionAsync(db, async () => {
        const fromStatus = await readStatusAsync(db, file.id);
        const result = await db.runAsync(
          `UPDATE files SET
            status = 'Completed',
            permanent_path = ?,
            thumbnails = ?,
            converted_format = ?,
            is_deduplicated = ?,
            last_response_at = ?,
            processing_started_at = NULL,
            next_attempt_at = NULL,
            error_message = NULL,
            failure_stage = NULL,
            updated_at = ?
           WHERE id = ? AND status IN ('Processing', 'Uploaded')`,
          [
            response.permanentPath ?? null,
            JSON.stringify(response.thumbnails ?? {}),
            response.convertedFormat ?? null,
            response.deduplicated ? 1 : 0,
            now,
            now,
            file.id,
          ],
        );
        if (result.changes === 0) {
          return;
        }
        await recordProcessedMessageWithDbAsync(db, {
          messageId: response.messageId,
          fileId: file.id,
          correlationId: eventCorrelationId,
          processedAt: now,
        });
        await insertFileEventWithDbAsync(db, {
          fileId: file.id,
          event: 'upload_completed',
          fromStatus,
          toStatus: 'Completed',
          correlationId: eventCorrelationId,
          metadata: { messageId: response.messageId, deduplicated: response.deduplicated },
          createdAt: now,
        });
        outcome = 'applied';
      });
      return outcome;
    }

    await runTransactionAsync(db, async () => {
      const current = await db.getFirstAsync<{ status: string; host_retry_count: number }>(
        `SELECT status, COALESCE(host_retry_count, 0) AS host_retry_count
         FROM files WHERE id = ?`,
        [file.id],
      );
      if (!current || (current.status !== 'Processing' && current.status !== 'Uploaded')) {
        return;
      }
      const hostRetryCount = current.host_retry_count + 1;
      const terminal = hostRetryCount >= safeMaxHostRetries;
      const nextAttemptAt = terminal ? null : computeNextAttemptAt(hostRetryCount);
      const errorMessage = (response.error ?? '').trim() || HOST_FAILURE_MESSAGE;
      const result = await db.runAsync(
        `UPDATE files SET
          status = 'Failed',
          failure_stage = 'host',
          error_message = ?,
          last_response_at = ?,
          host_retry_count = ?,
          next_attempt_at = ?,
          processing_started_at = NULL,
          updated_at = ?
         WHERE id = ? AND status IN ('Processing', 'Uploaded')`,
        [errorMessage, now, hostRetryCount, nextAttemptAt, now, file.id],
      );
      if (result.changes === 0) {
        return;
      }
      await recordProcessedMessageWithDbAsync(db, {
        messageId: response.messageId,
        fileId: file.id,
        correlationId: eventCorrelationId,
        processedAt: now,
      });
      await insertFileEventWithDbAsync(db, {
        fileId: file.id,
        event: 'host_failed',
        fromStatus: current.status,
        toStatus: 'Failed',
        correlationId: eventCorrelationId,
        errorCode: 'host_failed',
        metadata: { messageId: response.messageId, hostRetryCount, terminal },
        createdAt: now,
      });
      outcome = 'applied';
    });
    return outcome;
  }

  async getRecentEventsAsync(fileId: string, limit: number = 50): Promise<FileEvent[]> {
    return this.events.getRecentAsync(fileId, limit);
  }
}
