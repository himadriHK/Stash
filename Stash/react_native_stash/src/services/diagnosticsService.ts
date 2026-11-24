/**
 * Read-only diagnostics collector for the Settings screen.
 *
 * Every field is gathered from the local SQLite database plus the in-memory
 * runtime snapshots. Individual queries are defensive: a table that is missing
 * on an older database yields an empty/zero field instead of crashing the
 * screen. A total database-open failure still propagates, so a broken install
 * is not silently reported as healthy.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../data/database';
import {
  getBackgroundPassSnapshot,
  getLastConsumerRecordAt,
  getOutboxFlushSnapshot,
  type BackgroundPassSnapshot,
  type OutboxFlushSnapshot,
} from './runtimeState';

/** Matches the stale-recovery default in `FileLifecycleService`. */
const STUCK_TIMEOUT_MS = 30 * 60 * 1000;
const RECENT_EVENT_LIMIT = 5;

export interface StatusCount {
  status: string;
  count: number;
}

export interface RecentFileEvent {
  fileId: string;
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  errorCode: string | null;
  createdAt: string;
}

export interface DiagnosticsSnapshot {
  generatedAt: string;
  files: StatusCount[];
  totalFiles: number;
  stuckUploading: number;
  stuckProcessing: number;
  outbox: StatusCount[];
  processedMessages: number;
  recentEvents: RecentFileEvent[];
  lastPass: BackgroundPassSnapshot | null;
  lastOutboxFlush: OutboxFlushSnapshot | null;
  lastConsumerRecordAt: string | null;
}

interface CountRow {
  count: number;
}

interface StatusCountRow {
  status: string;
  count: number;
}

interface RecentEventRow {
  file_id: string;
  event: string;
  from_status: string | null;
  to_status: string | null;
  error_code: string | null;
  created_at: string;
}

/** Runs one query, degrading to `fallback` when that table is unavailable. */
async function safeQueryAsync<T>(
  label: string,
  query: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await query();
  } catch (error) {
    console.warn(`[diagnostics] ${label} query failed; reporting an empty value.`, error);
    return fallback;
  }
}

async function filesByStatusAsync(db: SQLiteDatabase): Promise<StatusCount[]> {
  const rows = await db.getAllAsync<StatusCountRow>(
    'SELECT status, COUNT(*) AS count FROM files GROUP BY status ORDER BY status',
  );
  return rows.map((row) => ({ status: row.status, count: row.count }));
}

async function outboxByStatusAsync(db: SQLiteDatabase): Promise<StatusCount[]> {
  const rows = await db.getAllAsync<StatusCountRow>(
    'SELECT status, COUNT(*) AS count FROM outbox_messages GROUP BY status ORDER BY status',
  );
  return rows.map((row) => ({ status: row.status, count: row.count }));
}

async function recentEventsAsync(db: SQLiteDatabase): Promise<RecentFileEvent[]> {
  const rows = await db.getAllAsync<RecentEventRow>(
    `SELECT file_id, event, from_status, to_status, error_code, created_at
     FROM file_events ORDER BY created_at DESC LIMIT ?`,
    [RECENT_EVENT_LIMIT],
  );
  return rows.map((row) => ({
    fileId: row.file_id,
    event: row.event,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    errorCode: row.error_code,
    createdAt: row.created_at,
  }));
}

async function countAsync(
  db: SQLiteDatabase,
  sql: string,
  params: (string | number)[] = [],
): Promise<number> {
  const row = await db.getFirstAsync<CountRow>(sql, params);
  return row?.count ?? 0;
}

export async function collectDiagnosticsAsync(): Promise<DiagnosticsSnapshot> {
  // A failure to open the database indicates a real install problem, so it is
  // intentionally allowed to reject instead of being masked as "all zeros".
  const db = await getDatabase();
  const generatedAt = new Date();
  const cutoff = new Date(generatedAt.getTime() - STUCK_TIMEOUT_MS).toISOString();

  const [
    files,
    totalFiles,
    stuckUploading,
    stuckProcessing,
    outbox,
    processedMessages,
    recentEvents,
  ] = await Promise.all([
    safeQueryAsync('files by status', () => filesByStatusAsync(db), [] as StatusCount[]),
    safeQueryAsync('total files', () => countAsync(db, 'SELECT COUNT(*) AS count FROM files'), 0),
    safeQueryAsync(
      'stuck uploads',
      () =>
        countAsync(
          db,
          `SELECT COUNT(*) AS count FROM files
           WHERE status = 'Uploading'
             AND COALESCE(upload_started_at, last_attempt_at, updated_at, discovered_at) < ?`,
          [cutoff],
        ),
      0,
    ),
    safeQueryAsync(
      'stuck processing',
      () =>
        countAsync(
          db,
          `SELECT COUNT(*) AS count FROM files
           WHERE status = 'Processing'
             AND COALESCE(processing_started_at, last_attempt_at, updated_at) < ?`,
          [cutoff],
        ),
      0,
    ),
    safeQueryAsync('outbox by status', () => outboxByStatusAsync(db), [] as StatusCount[]),
    safeQueryAsync(
      'processed messages',
      () => countAsync(db, 'SELECT COUNT(*) AS count FROM processed_messages'),
      0,
    ),
    safeQueryAsync('recent file events', () => recentEventsAsync(db), [] as RecentFileEvent[]),
  ]);

  return {
    generatedAt: generatedAt.toISOString(),
    files,
    totalFiles,
    stuckUploading,
    stuckProcessing,
    outbox,
    processedMessages,
    recentEvents,
    lastPass: getBackgroundPassSnapshot(),
    lastOutboxFlush: getOutboxFlushSnapshot(),
    lastConsumerRecordAt: getLastConsumerRecordAt(),
  };
}