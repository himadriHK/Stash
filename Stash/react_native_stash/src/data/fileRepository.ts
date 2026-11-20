/**
 * FileRepository - SQLite CRUD for FileEntity rows.
 * Mirrors Stash.Maui.Data/Repositories/IFileRepository implementation
 * (get by id/hash, get all, exists by hash, add, update, delete).
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase, parseJsonColumn } from './database';
import type { FileEntity } from '../models/fileEntity';
import { parseUploadStatus, UploadStatus } from '../models/uploadStatus';

interface FileRow {
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
  mega_temp_path: string | null;
  permanent_path: string | null;
  error_message: string | null;
  retry_count: number;
  last_attempt_at: string | null;
  device_id: string;
  user_id: string;
  thumbnails: string;
  converted_format: string | null;
  is_deduplicated: number;
}

function rowToEntity(row: FileRow): FileEntity {
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
    megaTempPath: row.mega_temp_path,
    permanentPath: row.permanent_path,
    errorMessage: row.error_message,
    retryCount: row.retry_count,
    lastAttemptAt: row.last_attempt_at,
    deviceId: row.device_id,
    userId: row.user_id,
    thumbnails: parseJsonColumn<Record<string, string>>(row.thumbnails, {}),
    convertedFormat: row.converted_format,
    isDeduplicated: row.is_deduplicated === 1,
  };
}

export class FileRepository {
  constructor(private readonly open: () => Promise<SQLiteDatabase> = getDatabase) {}

  async getByIdAsync(id: string): Promise<FileEntity | null> {
    const db = await this.open();
    const row = await db.getFirstAsync<FileRow>('SELECT * FROM files WHERE id = ?', [id]);
    return row ? rowToEntity(row) : null;
  }

  async getByContentHashAsync(contentHash: string): Promise<FileEntity | null> {
    const db = await this.open();
    const row = await db.getFirstAsync<FileRow>(
      'SELECT * FROM files WHERE content_hash = ?',
      [contentHash.toLowerCase()],
    );
    return row ? rowToEntity(row) : null;
  }

  async getAllAsync(): Promise<FileEntity[]> {
    const db = await this.open();
    const rows = await db.getAllAsync<FileRow>(
      'SELECT * FROM files ORDER BY discovered_at DESC',
    );
    return rows.map(rowToEntity);
  }

  async existsByContentHashAsync(contentHash: string): Promise<boolean> {
    const db = await this.open();
    const row = await db.getFirstAsync<{ value: number }>(
      'SELECT 1 AS value FROM files WHERE content_hash = ? LIMIT 1',
      [contentHash.toLowerCase()],
    );
    return row !== null;
  }

  async addAsync(file: FileEntity): Promise<void> {
    const db = await this.open();
    try {
      await db.runAsync(
        `INSERT INTO files (
          id, file_name, file_path, file_size, content_hash, mime_type,
          created_at, modified_at, discovered_at, status, mega_temp_path,
          permanent_path, error_message, retry_count, last_attempt_at,
          device_id, user_id, thumbnails, converted_format, is_deduplicated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          file.id,
          file.fileName,
          file.filePath,
          file.fileSize,
          file.contentHash.toLowerCase(),
          file.mimeType,
          file.createdAt,
          file.modifiedAt,
          file.discoveredAt,
          file.status,
          file.megaTempPath ?? null,
          file.permanentPath ?? null,
          file.errorMessage ?? null,
          file.retryCount,
          file.lastAttemptAt ?? null,
          file.deviceId,
          file.userId,
          JSON.stringify(file.thumbnails ?? {}),
          file.convertedFormat ?? null,
          file.isDeduplicated ? 1 : 0,
        ],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/UNIQUE constraint failed: files\.content_hash/i.test(message)) {
        throw new Error(`A file with this content hash is already tracked: ${file.fileName}`);
      }
      throw error;
    }
  }

  async updateAsync(file: FileEntity): Promise<void> {
    const db = await this.open();
    await db.runAsync(
      `UPDATE files SET
        file_name = ?, file_path = ?, file_size = ?, content_hash = ?, mime_type = ?,
        created_at = ?, modified_at = ?, discovered_at = ?, status = ?, mega_temp_path = ?,
        permanent_path = ?, error_message = ?, retry_count = ?, last_attempt_at = ?,
        device_id = ?, user_id = ?, thumbnails = ?, converted_format = ?, is_deduplicated = ?
      WHERE id = ?`,
      [
        file.fileName,
        file.filePath,
        file.fileSize,
        file.contentHash.toLowerCase(),
        file.mimeType,
        file.createdAt,
        file.modifiedAt,
        file.discoveredAt,
        file.status,
        file.megaTempPath ?? null,
        file.permanentPath ?? null,
        file.errorMessage ?? null,
        file.retryCount,
        file.lastAttemptAt ?? null,
        file.deviceId,
        file.userId,
        JSON.stringify(file.thumbnails ?? {}),
        file.convertedFormat ?? null,
        file.isDeduplicated ? 1 : 0,
        file.id,
      ],
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
