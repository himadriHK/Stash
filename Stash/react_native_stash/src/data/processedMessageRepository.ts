import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from './database';
import { runSerializedAsync } from './transactionQueue';
import { nowIso } from '../services/retryPolicy';

export interface ProcessedMessageInput {
  messageId: string;
  fileId?: string | null;
  correlationId?: string | null;
  processedAt?: string;
}

interface ProcessedMessageRow {
  message_id: string;
  file_id: string | null;
  correlation_id: string | null;
  processed_at: string;
}

export async function recordProcessedMessageWithDbAsync(
  db: SQLiteDatabase,
  input: ProcessedMessageInput,
): Promise<void> {
  await db.runAsync(
    `INSERT OR IGNORE INTO processed_messages (
      message_id, file_id, correlation_id, processed_at
    ) VALUES (?, ?, ?, ?)`,
    [
      input.messageId,
      input.fileId ?? null,
      input.correlationId ?? null,
      input.processedAt ?? nowIso(),
    ],
  );
}

export class ProcessedMessageRepository {
  constructor(private readonly open: () => Promise<SQLiteDatabase> = getDatabase) {}

  async hasAsync(messageId: string): Promise<boolean> {
    const db = await this.open();
    const row = await db.getFirstAsync<ProcessedMessageRow>(
      'SELECT * FROM processed_messages WHERE message_id = ? LIMIT 1',
      [messageId],
    );
    return row !== null;
  }

  async recordAsync(input: ProcessedMessageInput): Promise<void> {
    const db = await this.open();
    // Queued so the insert cannot land inside another caller's transaction.
    await runSerializedAsync(() => recordProcessedMessageWithDbAsync(db, input));
  }
}

export const processedMessageRepository = new ProcessedMessageRepository();