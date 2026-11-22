/**
 * Durable Kafka publisher.
 *
 * Upload requests are persisted in `outbox_messages` before any network call.
 * The publisher then claims due rows, produces them, and only marks them sent
 * after Kafka accepted the record (and the file advanced to `Processing` when
 * that transition is still legal). Retryable failures stay pending with
 * backoff; permanent failures dead-letter the request and mark the file failed.
 */
import { appConfig } from '../config/appConfig';
import type { FileRepository } from '../data/fileRepository';
import type { OutboxMessage, OutboxRepository } from '../data/outboxRepository';
import type { FileEntity } from '../models/fileEntity';
import { createUploadRequestMessage, type UploadRequestMessage } from '../models/messages';
import { UploadStatus } from '../models/uploadStatus';
import type { FileLifecycleService } from './fileLifecycleService';
import type { KafkaProducer } from './kafkaProducer';
import { computeNextAttemptAt, isAuthError, isRetryableError, nowIso } from './retryPolicy';
import { recordOutboxFlush } from './runtimeState';
import { forEachChunkedAsync, yieldToEventLoop } from '../utils/cooperative';

const DEFAULT_FLUSH_LIMIT = 50;
/** Rows sent per drain round: larger than the single-file flush default. */
const DRAIN_FLUSH_LIMIT = 100;
/** Upper bound on drain rounds so a huge backlog cannot loop forever. */
const DRAIN_MAX_ROUNDS = 200;
/** Files whose publish intent is persisted per transaction. */
const ENQUEUE_CHUNK_SIZE = 25;
const SENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface OutboxFlushResult {
  attempted: number;
  sent: number;
  retried: number;
  dead: number;
}

export interface UploadQueueOutcome {
  queued: boolean;
  processing: boolean;
  error?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parses a persisted request payload; null means the row cannot be published. */
function parsePayload(payload: string): UploadRequestMessage | null {
  try {
    const parsed = JSON.parse(payload) as Partial<UploadRequestMessage> | null;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.fileId !== 'string' || !parsed.fileId) {
      return null;
    }
    return parsed as UploadRequestMessage;
  } catch {
    return null;
  }
}

function isProcessingStatus(status: UploadStatus): boolean {
  return (
    status === UploadStatus.Processing ||
    status === UploadStatus.Completed ||
    status === UploadStatus.Deduplicated
  );
}

export class OutboxPublisher {
  private flushing = false;

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly files: FileRepository,
    private readonly producer: KafkaProducer,
    private readonly lifecycle: FileLifecycleService,
  ) {}

  /**
   * Persists the upload request, flushes pending work, and reports whether the
   * file is now `Processing` (or already terminal). The queued flag is true as
   * soon as the outbox row exists, even when a concurrent flush owns delivery.
   */
  async enqueueAndFlushAsync(
    file: FileEntity,
    deviceId: string,
    userId: string,
  ): Promise<UploadQueueOutcome> {
    if (!file.storageTempPath || file.storageTempPath.trim().length === 0) {
      return {
        queued: false,
        processing: false,
        error: 'Upload completed without a temporary storage path.',
      };
    }

    const message = createUploadRequestMessage(file, deviceId, userId, appConfig.Storage.Provider);
    const payload = JSON.stringify(message);

    await this.outbox.enqueueAsync({
      fileId: file.id,
      correlationId: message.correlationId,
      messageId: message.messageId,
      payload,
    });

    try {
      await this.flushAsync();
    } catch (error) {
      // The row is durable; a later pass (or the next enqueue) will retry it.
      console.warn(
        `Outbox flush after enqueue failed for file ${file.id}; the message stays queued: ${messageOf(
          error,
        )}`,
      );
    }

    const fresh = await this.files.getByIdAsync(file.id);
    const active = await this.outbox.findActiveByFileAsync(file.id);

    // A terminal publish failure dead-letters the outbox row and marks the file
    // Failed. Reporting success here would hide that the request never shipped.
    if (!active && fresh && fresh.status === UploadStatus.Failed) {
      return {
        queued: false,
        processing: false,
        error: fresh.errorMessage ?? 'The upload request could not be published.',
      };
    }

    return {
      queued: true,
      processing: fresh ? isProcessingStatus(fresh.status) : false,
    };
  }

  /** Sends due outbox rows. Concurrent calls are ignored rather than queued. */
  async flushAsync(limit: number = DEFAULT_FLUSH_LIMIT): Promise<OutboxFlushResult> {
    if (this.flushing) {
      const skipped: OutboxFlushResult = { attempted: 0, sent: 0, retried: 0, dead: 0 };
      recordOutboxFlush(skipped);
      return skipped;
    }
    this.flushing = true;
    const result: OutboxFlushResult = { attempted: 0, sent: 0, retried: 0, dead: 0 };

    try {
      // Recover rows left in `sending` by a crash or a killed JS runtime.
      await this.outbox.resetSendingAsync();

      const pending = await this.outbox.getPendingAsync(limit, nowIso());
      result.attempted = pending.length;

      for (const row of pending) {
        const claimed = await this.outbox.claimAsync(row.id);
        if (!claimed) {
          continue;
        }

        // claimAsync already incremented the persisted attempt count.
        const attempt = row.attempts + 1;
        const message = parsePayload(row.payload);
        if (!message) {
          await this.failTerminallyAsync(row, 'Malformed outbox payload.');
          result.dead += 1;
          continue;
        }
        // Older or hand-edited payloads must still correlate with the outbox
        // identity used for the response match.
        message.correlationId = message.correlationId || row.correlationId;
        message.messageId = message.messageId || row.messageId;

        try {
          await this.producer.produceUploadRequestAsync(message);
          const advanced = await this.outbox.markSentAndProcessingAsync(
            row.id,
            row.fileId,
            row.correlationId,
            row.messageId,
          );
          if (!advanced) {
            await this.outbox.markSentAsync(row.id);
            console.info(
              `Outbox message ${row.id} was sent after file ${row.fileId} had already advanced.`,
            );
          }
          result.sent += 1;
        } catch (error) {
          const errorMessage = messageOf(error);

          if (isAuthError(error)) {
            // A token refresh can recover this; keep it pending without
            // spending the publish retry budget or dead-lettering.
            await this.outbox.markRetryAsync(
              row.id,
              errorMessage,
              computeNextAttemptAt(attempt),
            );
            result.retried += 1;
            continue;
          }

          if (isRetryableError(error) && attempt < appConfig.UploadSettings.MaxRetries) {
            await this.outbox.markRetryAsync(
              row.id,
              errorMessage,
              computeNextAttemptAt(attempt),
            );
            result.retried += 1;
            continue;
          }

          await this.failTerminallyAsync(row, errorMessage, message.fileId);
          result.dead += 1;
        }
      }

      await this.pruneAsync();
      recordOutboxFlush(result);
      return result;
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Persists publish intents for many uploaded files, then drains the outbox.
   *
   * A batch pass over 10k files must not run "enqueue + flush" per file: each
   * flush does recovery, pruning and a network round trip. Enqueuing in chunks
   * (one transaction per chunk) and flushing afterwards keeps the same durable
   * guarantee with a fraction of the database work.
   */
  async enqueueManyAsync(
    files: readonly FileEntity[],
    deviceId: string,
    userId: string,
    onProgress?: (processed: number, total: number) => void,
  ): Promise<{ queued: number; failed: number; sent: number; dead: number }> {
    const total = files.length;
    const enqueueable = files.filter(
      (file) => file.storageTempPath && file.storageTempPath.trim().length > 0,
    );

    let queued = 0;
    let failed = total - enqueueable.length;

    await forEachChunkedAsync(
      enqueueable,
      async (chunk) => {
        const params = chunk.map((file) => {
          const message = createUploadRequestMessage(
            file,
            deviceId,
            userId,
            appConfig.Storage.Provider,
          );
          return {
            fileId: file.id,
            correlationId: message.correlationId,
            messageId: message.messageId,
            payload: JSON.stringify(message),
          };
        });

        try {
          await this.outbox.enqueueManyAsync(params);
        } catch (error) {
          console.warn(
            `Could not persist publish intents for ${chunk.length} file(s): ${messageOf(error)}`,
          );
          failed += chunk.length;
          return;
        }
        // `INSERT OR IGNORE` only skips a row when an active message already
        // exists for the file, which means the request is still queued - so the
        // whole chunk counts as queued.
        queued += chunk.length;
      },
      {
        chunkSize: ENQUEUE_CHUNK_SIZE,
        onProgress: (processed) => onProgress?.(processed, total),
      },
    );

    const flush = await this.drainAsync();
    return { queued, failed, sent: flush.sent, dead: flush.dead };
  }

  /**
   * Flushes repeatedly until the outbox has no due rows left (or the round cap
   * is reached). Each round sends up to `limit` messages.
   */
  async drainAsync(
    limit: number = DRAIN_FLUSH_LIMIT,
    maxRounds: number = DRAIN_MAX_ROUNDS,
  ): Promise<OutboxFlushResult> {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_FLUSH_LIMIT;
    const safeRounds =
      Number.isFinite(maxRounds) && maxRounds > 0 ? Math.floor(maxRounds) : DRAIN_MAX_ROUNDS;

    const totals: OutboxFlushResult = { attempted: 0, sent: 0, retried: 0, dead: 0 };
    for (let round = 0; round < safeRounds; round += 1) {
      const result = await this.flushAsync(safeLimit);
      totals.attempted += result.attempted;
      totals.sent += result.sent;
      totals.retried += result.retried;
      totals.dead += result.dead;
      // A short round means nothing else is due; a full round means more work.
      if (result.attempted < safeLimit) {
        break;
      }
      await yieldToEventLoop();
    }
    return totals;
  }

  private async failTerminallyAsync(
    row: OutboxMessage,
    errorMessage: string,
    requestFileId?: string,
  ): Promise<void> {
    await this.outbox.markDeadAsync(row.id, errorMessage);
    await this.lifecycle.markTerminalFailureAsync(row.fileId, 'publish', errorMessage);

    try {
      const fresh = await this.files.getByIdAsync(row.fileId);
      const key = fresh?.contentHash || requestFileId || row.fileId;
      await this.producer.produceDeadLetterAsync(key, row.payload, errorMessage);
    } catch (error) {
      console.warn(`Dead letter production failed for outbox message ${row.id}: ${messageOf(error)}`);
    }
  }

  private async pruneAsync(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - SENT_RETENTION_MS).toISOString();
      await this.outbox.pruneSentAsync(cutoff);
    } catch (error) {
      console.warn(`Outbox prune failed; a later pass will retry it: ${messageOf(error)}`);
    }
  }
}
