import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from './database';
import { runSerializedAsync } from './transactionQueue';
import { nowIso } from '../services/retryPolicy';
import { uuid } from '../utils/id';

export interface FileEvent {
  id: string;
  fileId: string;
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  correlationId: string | null;
  errorCode: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface FileEventInput {
  id?: string;
  fileId: string;
  event: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  correlationId?: string | null;
  errorCode?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
}

interface FileEventRow {
  id: string;
  file_id: string;
  event: string;
  from_status: string | null;
  to_status: string | null;
  correlation_id: string | null;
  error_code: string | null;
  metadata: string | null;
  created_at: string;
}

function parseMetadata(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function rowToEvent(row: FileEventRow): FileEvent {
  return {
    id: row.id,
    fileId: row.file_id,
    event: row.event,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    correlationId: row.correlation_id,
    errorCode: row.error_code,
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at,
  };
}

export function buildFileEvent(input: FileEventInput): FileEvent {
  return {
    id: input.id ?? uuid(),
    fileId: input.fileId,
    event: input.event,
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus ?? null,
    correlationId: input.correlationId ?? null,
    errorCode: input.errorCode ?? null,
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? nowIso(),
  };
}

export async function insertFileEventWithDbAsync(
  db: SQLiteDatabase,
  input: FileEventInput,
): Promise<FileEvent> {
  const event = buildFileEvent(input);
  await db.runAsync(
    `INSERT INTO file_events (
      id, file_id, event, from_status, to_status, correlation_id, error_code, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.id,
      event.fileId,
      event.event,
      event.fromStatus,
      event.toStatus,
      event.correlationId,
      event.errorCode,
      Object.keys(event.metadata).length > 0 ? JSON.stringify(event.metadata) : null,
      event.createdAt,
    ],
  );
  return event;
}

export class FileEventRepository {
  constructor(private readonly open: () => Promise<SQLiteDatabase> = getDatabase) {}

  async recordAsync(input: FileEventInput): Promise<FileEvent> {
    const db = await this.open();
    // Queued so the insert cannot land inside another caller's transaction.
    return runSerializedAsync(() => insertFileEventWithDbAsync(db, input));
  }

  async getRecentAsync(fileId: string, limit: number = 50): Promise<FileEvent[]> {
    const db = await this.open();
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;
    const rows = await db.getAllAsync<FileEventRow>(
      `SELECT * FROM file_events WHERE file_id = ? ORDER BY created_at DESC LIMIT ?`,
      [fileId, safeLimit],
    );
    return rows.map(rowToEvent);
  }
}

export const fileEventRepository = new FileEventRepository();