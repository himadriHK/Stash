/**
 * FileRepository - SQLite CRUD for FileEntity rows.
 * Mirrors Stash.Maui.Data/Repositories/IFileRepository implementation
 * (get by id/hash, get all, exists by hash, add, update, delete).
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase, parseJsonColumn } from './database';
import type { FileEntity } from '../models/fileEntity';
import { parseUploadStatus, UploadStatus } from '../models/uploadStatus';

export interface FileRow {
  id: string;
  file_name: string;
  file_path: string;
  file_size: number;
  content_hash: string;
  mime_type: string;
  created_at: string;
  modified_at: string;
  discovered_at: string;
  status: string;
  storage_temp_path: string | null;
  permanent_path: string | null;
  error_message: string | null;
  retry_count: number;
  last_attempt_at: string | null;
  device_id: string;
  user_id: string;
  thumbnails: string;
  converted_format: string | null;
  is_deduplicated: number;
  upload_started_at: string | null;
  processing_started_at: string | null;
  last_response_at: string | null;
  request_correlation_id: string | null;
  request_message_id: string | null;
  host_retry_count: number;
  next_attempt_at: string | null;
  failure_stage: string | null;
  updated_at: string | null;
}

export function mapFileRow(row: FileRow): FileEntity {
  return {
    id: row.id,
    fileName: row.file_name,
    filePath: row.file_path,
    fileSize: row.file_size,
    contentHash: row.content_hash,
    mimeType: row.mime_type,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    discoveredAt: row.discovered_at,
    status: parseUploadStatus(row.status),
    storageTempPath: row.storage_temp_path,
    permanentPath: row.permanent_path,
    errorMessage: row.error_message,
    retryCount: row.retry_count,
    lastAttemptAt: row.last_attempt_at,
    deviceId: row.device_id,
    userId: row.user_id,
    thumbnails: parseJsonColumn<Record<string, string>>(row.thumbnails, {}),
    convertedFormat: row.converted_format,
    isDeduplicated: row.is_deduplicated === 1,
    uploadStartedAt: row.upload_started_at,
    processingStartedAt: row.processing_started_at,
    lastResponseAt: row.last_response_at,
    requestCorrelationId: row.request_correlation_id,
    requestMessageId: row.request_message_id,
    hostRetryCount: row.host_retry_count,
    nextAttemptAt: row.next_attempt_at,
    failureStage: row.failure_stage,
    updatedAt: row.updated_at,
  };
}

/**
 * Whole-row write parameters, named so the INSERT/UPDATE column lists and their
 * bound values stay visibly paired. Phase 1 replaces these with guarded,
 * targeted updates.
 */
function toWriteParams(file: FileEntity): Record<string, string | number | null> {
  return {
    $id: file.id,
    $file_name: file.fileName,
    $file_path: file.filePath,
    $file_size: file.fileSize,
    $content_hash: file.contentHash.toLowerCase(),
    $mime_type: file.mimeType,
    $created_at: file.createdAt,
    $modified_at: file.modifiedAt,
    $discovered_at: file.discoveredAt,
    $status: file.status,
    $storage_temp_path: file.storageTempPath ?? null,
    $permanent_path: file.permanentPath ?? null,
    $error_message: file.errorMessage ?? null,
    $retry_count: file.retryCount,
    $last_attempt_at: file.lastAttemptAt ?? null,
    $device_id: file.deviceId,
    $user_id: file.userId,
    $thumbnails: JSON.stringify(file.thumbnails ?? {}),
    $converted_format: file.convertedFormat ?? null,
    $is_deduplicated: file.isDeduplicated ? 1 : 0,
    $upload_started_at: file.uploadStartedAt ?? null,
    $processing_started_at: file.processingStartedAt ?? null,
    $last_response_at: file.lastResponseAt ?? null,
    $request_correlation_id: file.requestCorrelationId ?? null,
    $request_message_id: file.requestMessageId ?? null,
    $host_retry_count: file.hostRetryCount,
    $next_attempt_at: file.nextAttemptAt ?? null,
    $failure_stage: file.failureStage ?? null,
    $updated_at: file.updatedAt ?? null,
  };
}

/**
 * Shared INSERT column/value lists so the single-row and batch inserts cannot
 * drift apart. `addManyAsync` reuses these with an `INSERT OR IGNORE` prefix.
 */
const FILE_INSERT_COLUMNS = `id, file_name, file_path, file_size, content_hash, mime_type,
  created_at, modified_at, discovered_at, status, storage_temp_path,
  permanent_path, error_message, retry_count, last_attempt_at,
  device_id, user_id, thumbnails, converted_format, is_deduplicated,
  upload_started_at, processing_started_at, last_response_at,
  request_correlation_id, request_message_id, host_retry_count,
  next_attempt_at, failure_stage, updated_at`;
const FILE_INSERT_VALUES = `$id, $file_name, $file_path, $file_size, $content_hash, $mime_type,
  $created_at, $modified_at, $discovered_at, $status, $storage_temp_path,
  $permanent_path, $error_message, $retry_count, $last_attempt_at,
  $device_id, $user_id, $thumbnails, $converted_format, $is_deduplicated,
  $upload_started_at, $processing_started_at, $last_response_at,
  $request_correlation_id, $request_message_id, $host_retry_count,
  $next_attempt_at, $failure_stage, $updated_at`;
const FILE_INSERT_SQL = `INSERT INTO files (${FILE_INSERT_COLUMNS}) VALUES (${FILE_INSERT_VALUES})`;

export class FileRepository {
  constructor(private readonly open: () => Promise<SQLiteDatabase> = getDatabase) {}

  async getByIdAsync(id: string): Promise<FileEntity | null> {
    const db = await this.open();
    const row = await db.getFirstAsync<FileRow>('SELECT * FROM files WHERE id = ?', [id]);
    return row ? mapFileRow(row) : null;
  }

  async getByContentHashAsync(contentHash: string): Promise<FileEntity | null> {
    const db = await this.open();
    const row = await db.getFirstAsync<FileRow>(
      'SELECT * FROM files WHERE content_hash = ?',
      [contentHash.toLowerCase()],
    );
    return row ? mapFileRow(row) : null;
  }

  async getAllAsync(): Promise<FileEntity[]> {
    const db = await this.open();
    const rows = await db.getAllAsync<FileRow>(
      'SELECT * FROM files ORDER BY discovered_at DESC',
    );
    return rows.map(mapFileRow);
  }

  /**
   * One page for the Files list. The composite `(discovered_at, id)` ordering
   * keeps paging stable when rows share a discovery timestamp.
   */
  async getPageAsync(limit: number, offset: number): Promise<FileEntity[]> {
    const db = await this.open();
    const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
    const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    if (safeLimit === 0) {
      return [];
    }
    const rows = await db.getAllAsync<FileRow>(
      'SELECT * FROM files ORDER BY discovered_at DESC, id DESC LIMIT ? OFFSET ?',
      [safeLimit, safeOffset],
    );
    return rows.map(mapFileRow);
  }

  async countAsync(): Promise<number> {
    const db = await this.open();
    const row = await db.getFirstAsync<{ value: number }>('SELECT COUNT(*) AS value FROM files');
    return row?.value ?? 0;
  }

  async existsByContentHashAsync(contentHash: string): Promise<boolean> {
    const db = await this.open();
    const row = await db.getFirstAsync<{ value: number }>(
      'SELECT 1 AS value FROM files WHERE content_hash = ? LIMIT 1',
      [contentHash.toLowerCase()],
    );
    return row !== null;
  }

  async getCandidatesAsync(
    limit: number,
    maxRetries: number,
    maxHostRetries: number,
  ): Promise<FileEntity[]> {
    const db = await this.open();
    const now = new Date().toISOString();
    const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
    const safeMaxRetries = Number.isFinite(maxRetries) ? Math.max(0, Math.floor(maxRetries)) : 0;
    const safeMaxHostRetries = Number.isFinite(maxHostRetries)
      ? Math.max(0, Math.floor(maxHostRetries))
      : 0;
    const rows = await db.getAllAsync<FileRow>(
      `SELECT f.* FROM files f
       WHERE f.status IN ('Pending', 'Retrying', 'Uploaded', 'Failed')
         AND (f.next_attempt_at IS NULL OR f.next_attempt_at <= ?)
         AND (
           f.status <> 'Failed'
           OR (f.retry_count < ? AND f.host_retry_count < ?)
         )
         -- Local- and publish-terminal rows stay terminal until a manual
         -- retry: the outbox already dead-lettered publish failures and local
         -- failures (missing/oversize) cannot succeed automatically.
         AND (f.failure_stage IS NULL OR f.failure_stage NOT IN ('local', 'publish'))
         AND NOT EXISTS (
           SELECT 1 FROM outbox_messages o
           WHERE o.file_id = f.id AND o.status IN ('pending', 'sending')
         )
       ORDER BY f.discovered_at ASC
       LIMIT ?`,
      [now, safeMaxRetries, safeMaxHostRetries, safeLimit],
    );
    return rows.map(mapFileRow);
  }

  async addAsync(file: FileEntity): Promise<void> {
    const db = await this.open();
    try {
      await db.runAsync(FILE_INSERT_SQL, toWriteParams(file));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/UNIQUE constraint failed: files\.content_hash/i.test(message)) {
        throw new Error(`A file with this content hash is already tracked: ${file.fileName}`);
      }
      throw error;
    }
  }

  /**
   * Inserts a batch of rows in one transaction. `INSERT OR IGNORE` skips
   * duplicates (for example a content hash inserted by a concurrent writer) and
   * the return value is the number of rows actually inserted.
   */
  async addManyAsync(files: FileEntity[]): Promise<number> {
    if (files.length === 0) {
      return 0;
    }
    const db = await this.open();
    let inserted = 0;
    await db.withTransactionAsync(async () => {
      for (const file of files) {
        const result = await db.runAsync(
          `INSERT OR IGNORE INTO files (${FILE_INSERT_COLUMNS}) VALUES (${FILE_INSERT_VALUES})`,
          toWriteParams(file),
        );
        inserted += result.changes;
      }
    });
    return inserted;
  }

  async updateAsync(file: FileEntity): Promise<void> {
    const db = await this.open();
    await db.runAsync(
      `UPDATE files SET
        file_name = $file_name, file_path = $file_path, file_size = $file_size,
        content_hash = $content_hash, mime_type = $mime_type,
        created_at = $created_at, modified_at = $modified_at,
        discovered_at = $discovered_at, status = $status,
        storage_temp_path = $storage_temp_path, permanent_path = $permanent_path,
        error_message = $error_message, retry_count = $retry_count,
        last_attempt_at = $last_attempt_at, device_id = $device_id,
        user_id = $user_id, thumbnails = $thumbnails,
        converted_format = $converted_format, is_deduplicated = $is_deduplicated,
        upload_started_at = $upload_started_at,
        processing_started_at = $processing_started_at,
        last_response_at = $last_response_at,
        request_correlation_id = $request_correlation_id,
        request_message_id = $request_message_id,
        host_retry_count = $host_retry_count,
        next_attempt_at = $next_attempt_at,
        failure_stage = $failure_stage,
        updated_at = $updated_at
      WHERE id = $id`,
      toWriteParams(file),
    );
  }

  /**
   * Targeted ownership stamp. Callers use this instead of rewriting the whole
   * row so a concurrent lifecycle transition is never clobbered.
   */
  async setOwnershipAsync(id: string, deviceId: string, userId: string): Promise<void> {
    const db = await this.open();
    await db.runAsync(
      `UPDATE files SET device_id = ?, user_id = ?, updated_at = ? WHERE id = ?`,
      [deviceId, userId, new Date().toISOString(), id],
    );
  }

  async deleteAsync(id: string): Promise<void> {
    const db = await this.open();
    await db.runAsync('DELETE FROM files WHERE id = ?', [id]);
  }
}

export type IFileRepository = FileRepository;

/** Convenience status guard shared with the background pass. */
export function isTerminalStatus(status: UploadStatus): boolean {
  return status === UploadStatus.Completed || status === UploadStatus.Deduplicated;
}
