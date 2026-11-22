import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from './database';
import { runTransactionAsync, runWriteAsync } from './transactionQueue';
import { insertFileEventWithDbAsync } from './fileEventRepository';
import { nowIso } from '../services/retryPolicy';
import { uuid } from '../utils/id';

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'dead';

export interface OutboxMessage {
  id: string;
  fileId: string;
  correlationId: string;
  messageId: string;
  payload: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface EnqueueOutboxParams {
  fileId: string;
  correlationId: string;
  messageId: string;
  payload: string;
}

interface OutboxRow {
  id: string;
  file_id: string;
  correlation_id: string;
  message_id: string;
  payload: string;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

class MarkSentRollback extends Error {
  constructor() {
    super('markSentAndProcessingAsync rolled back');
    this.name = 'MarkSentRollback';
  }
}

function mapOutboxRow(row: OutboxRow): OutboxMessage {
  return {
    id: row.id,
    fileId: row.file_id,
    correlationId: row.correlation_id,
    messageId: row.message_id,
    payload: row.payload,
    status: row.status as OutboxStatus,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

export class OutboxRepository {
  constructor(private readonly open: () => Promise<SQLiteDatabase> = getDatabase) {}

  async enqueueAsync(params: EnqueueOutboxParams): Promise<OutboxMessage> {
    const db = await this.open();
    const id = uuid();
    const createdAt = nowIso();
    let inserted = false;

    await runTransactionAsync(db, async () => {
      const result = await db.runAsync(
        `INSERT OR IGNORE INTO outbox_messages (
          id, file_id, correlation_id, message_id, payload, status, attempts,
          next_attempt_at, last_error, created_at, sent_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, NULL)`,
        [id, params.fileId, params.correlationId, params.messageId, params.payload, createdAt],
      );
      if (result.changes === 0) {
        return;
      }
      inserted = true;

      // Stamp the request identity on the file in the same transaction so a
      // response can be matched to the publish attempt that produced it.
      await db.runAsync(
        `UPDATE files SET
          request_correlation_id = ?,
          request_message_id = ?,
          updated_at = ?
         WHERE id = ? AND status IN ('Uploaded', 'Failed')`,
        [params.correlationId, params.messageId, createdAt, params.fileId],
      );

      await insertFileEventWithDbAsync(db, {
        fileId: params.fileId,
        event: 'publish_queued',
        correlationId: params.correlationId,
        metadata: { messageId: params.messageId, outboxMessageId: id },
        createdAt,
      });
    });

    if (!inserted) {
      const existing = await this.findActiveByFileAsync(params.fileId);
      if (existing) {
        return existing;
      }
      throw new Error(`Could not enqueue an outbox message for file ${params.fileId}.`);
    }

    const row = await db.getFirstAsync<OutboxRow>(
      'SELECT * FROM outbox_messages WHERE id = ?',
      [id],
    );
    if (!row) {
      throw new Error(`Enqueued outbox message ${id} could not be read back.`);
    }
    return mapOutboxRow(row);
  }

  /**
   * Enqueues many upload requests with one transaction per call instead of one
   * per file. Rows that already have an active message are ignored (the unique
   * partial index enforces that), which is why this reports the inserted count
   * rather than per-file rows.
   */
  async enqueueManyAsync(params: readonly EnqueueOutboxParams[]): Promise<number> {
    if (params.length === 0) {
      return 0;
    }
    const db = await this.open();
    let inserted = 0;

    await runTransactionAsync(db, async () => {
      for (const entry of params) {
        const createdAt = nowIso();
        const result = await db.runAsync(
          `INSERT OR IGNORE INTO outbox_messages (
            id, file_id, correlation_id, message_id, payload, status, attempts,
            next_attempt_at, last_error, created_at, sent_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, NULL)`,
          [
            uuid(),
            entry.fileId,
            entry.correlationId,
            entry.messageId,
            entry.payload,
            createdAt,
          ],
        );
        if (result.changes === 0) {
          continue;
        }
        inserted += 1;

        await db.runAsync(
          `UPDATE files SET
            request_correlation_id = ?,
            request_message_id = ?,
            updated_at = ?
           WHERE id = ? AND status IN ('Uploaded', 'Failed')`,
          [entry.correlationId, entry.messageId, createdAt, entry.fileId],
        );

        await insertFileEventWithDbAsync(db, {
          fileId: entry.fileId,
          event: 'publish_queued',
          correlationId: entry.correlationId,
          metadata: { messageId: entry.messageId },
          createdAt,
        });
      }
    });

    return inserted;
  }

  async findActiveByFileAsync(fileId: string): Promise<OutboxMessage | null> {
    const db = await this.open();
    const row = await db.getFirstAsync<OutboxRow>(
      `SELECT * FROM outbox_messages
       WHERE file_id = ? AND status IN ('pending', 'sending')
       ORDER BY created_at ASC LIMIT 1`,
      [fileId],
    );
    return row ? mapOutboxRow(row) : null;
  }

  async getPendingAsync(limit: number, nowIsoValue: string): Promise<OutboxMessage[]> {
    const db = await this.open();
    const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
    const rows = await db.getAllAsync<OutboxRow>(
      `SELECT * FROM outbox_messages
       WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC LIMIT ?`,
      [nowIsoValue, safeLimit],
    );
    return rows.map(mapOutboxRow);
  }

  async resetSendingAsync(): Promise<void> {
    const db = await this.open();
    await runWriteAsync(
      db,
      `UPDATE outbox_messages SET status = 'pending' WHERE status = 'sending'`,
    );
  }

  async claimAsync(id: string): Promise<boolean> {
    const db = await this.open();
    const result = await runWriteAsync(
      db,
      `UPDATE outbox_messages
       SET status = 'sending', attempts = attempts + 1
       WHERE id = ? AND status = 'pending'`,
      [id],
    );
    return result.changes > 0;
  }

  async markSentAndProcessingAsync(
    id: string,
    fileId: string,
    correlationId: string,
    messageId: string,
  ): Promise<boolean> {
    const db = await this.open();
    const now = nowIso();
    let applied = false;
    try {
      await runTransactionAsync(db, async () => {
        const outboxResult = await db.runAsync(
          `UPDATE outbox_messages
           SET status = 'sent', sent_at = ?, last_error = NULL
           WHERE id = ? AND status = 'sending'`,
          [now, id],
        );
        if (outboxResult.changes === 0) {
          throw new MarkSentRollback();
        }

        const prior = await db.getFirstAsync<{ status: string }>(
          'SELECT status FROM files WHERE id = ?',
          [fileId],
        );
        const fileResult = await db.runAsync(
          `UPDATE files SET
            status = 'Processing',
            processing_started_at = ?,
            request_correlation_id = ?,
            request_message_id = ?,
            error_message = NULL,
            failure_stage = NULL,
            next_attempt_at = NULL,
            updated_at = ?
           WHERE id = ? AND status IN ('Uploaded', 'Failed')`,
          [now, correlationId, messageId, now, fileId],
        );
        if (fileResult.changes === 0) {
          throw new MarkSentRollback();
        }

        await insertFileEventWithDbAsync(db, {
          fileId,
          event: 'publish_sent',
          fromStatus: prior?.status ?? null,
          toStatus: 'Processing',
          correlationId,
          metadata: { messageId, outboxMessageId: id },
          createdAt: now,
        });
        applied = true;
      });
    } catch (error) {
      if (error instanceof MarkSentRollback) {
        return false;
      }
      throw error;
    }
    return applied;
  }

  /**
   * Marks a claimed message sent when the file row already advanced past the
   * publish transition (for example a host response raced the publish ACK).
   */
  async markSentAsync(id: string): Promise<void> {
    const db = await this.open();
    await runWriteAsync(
      db,
      `UPDATE outbox_messages
       SET status = 'sent', sent_at = ?, last_error = NULL
       WHERE id = ? AND status = 'sending'`,
      [nowIso(), id],
    );
  }

  async markRetryAsync(id: string, error: string, nextAttemptAt: string): Promise<void> {
    const db = await this.open();
    await runWriteAsync(
      db,
      `UPDATE outbox_messages
       SET status = 'pending', last_error = ?, next_attempt_at = ?
       WHERE id = ?`,
      [error, nextAttemptAt, id],
    );
  }

  async markDeadAsync(id: string, error: string): Promise<void> {
    const db = await this.open();
    await runWriteAsync(
      db,
      `UPDATE outbox_messages
       SET status = 'dead', last_error = ?, next_attempt_at = NULL
       WHERE id = ?`,
      [error, id],
    );
  }

  async countByStatusAsync(): Promise<Record<string, number>> {
    const db = await this.open();
    const rows = await db.getAllAsync<{ status: string; count: number }>(
      'SELECT status, COUNT(*) AS count FROM outbox_messages GROUP BY status',
    );
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status] = row.count;
    }
    return counts;
  }

  async pruneSentAsync(olderThanIso: string): Promise<void> {
    const db = await this.open();
    await runWriteAsync(
      db,
      `DELETE FROM outbox_messages
       WHERE status = 'sent' AND sent_at IS NOT NULL AND sent_at < ?`,
      [olderThanIso],
    );
  }
}
