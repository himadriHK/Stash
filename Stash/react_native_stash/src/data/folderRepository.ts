/**
 * FolderRepository - SQLite CRUD for FolderConfig rows.
 * Mirrors Stash.Maui.Data/Repositories folder repository
 * (get by id/path, get all, add, update, delete).
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase, parseJsonColumn } from './database';
import type { FolderConfig } from '../models/folderConfig';
import { createDefaultIncludePatterns } from '../models/mediaPatterns';

interface FolderRow {
  id: string;
  folder_path: string;
  folder_name: string;
  is_enabled: number;
  added_at: string;
  last_scanned_at: string | null;
  include_patterns: string;
  exclude_patterns: string;
  include_subfolders: number;
}

function rowToEntity(row: FolderRow): FolderConfig {
  return {
    id: row.id,
    folderPath: row.folder_path,
    folderName: row.folder_name,
    isEnabled: row.is_enabled === 1,
    addedAt: row.added_at,
    lastScannedAt: row.last_scanned_at,
    includePatterns: parseJsonColumn<string[]>(
      row.include_patterns,
      createDefaultIncludePatterns(),
    ),
    excludePatterns: parseJsonColumn<string[]>(row.exclude_patterns, []),
    includeSubfolders: row.include_subfolders === 1,
  };
}

export class FolderRepository {
  constructor(private readonly open: () => Promise<SQLiteDatabase> = getDatabase) {}

  async getByIdAsync(id: string): Promise<FolderConfig | null> {
    const db = await this.open();
    const row = await db.getFirstAsync<FolderRow>('SELECT * FROM folder_configs WHERE id = ?', [
      id,
    ]);
    return row ? rowToEntity(row) : null;
  }

  async getByPathAsync(folderPath: string): Promise<FolderConfig | null> {
    const db = await this.open();
    const row = await db.getFirstAsync<FolderRow>(
      'SELECT * FROM folder_configs WHERE folder_path = ?',
      [folderPath],
    );
    return row ? rowToEntity(row) : null;
  }

  async getAllAsync(): Promise<FolderConfig[]> {
    const db = await this.open();
    const rows = await db.getAllAsync<FolderRow>(
      'SELECT * FROM folder_configs ORDER BY added_at DESC',
    );
    return rows.map(rowToEntity);
  }

  async addAsync(folder: FolderConfig): Promise<void> {
    const db = await this.open();
    await db.runAsync(
      `INSERT INTO folder_configs (
        id, folder_path, folder_name, is_enabled, added_at, last_scanned_at,
        include_patterns, exclude_patterns, include_subfolders
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        folder.id,
        folder.folderPath,
        folder.folderName,
        folder.isEnabled ? 1 : 0,
        folder.addedAt,
        folder.lastScannedAt ?? null,
        JSON.stringify(folder.includePatterns ?? []),
        JSON.stringify(folder.excludePatterns ?? []),
        folder.includeSubfolders ? 1 : 0,
      ],
    );
  }

  async updateAsync(folder: FolderConfig): Promise<void> {
    const db = await this.open();
    await db.runAsync(
      `UPDATE folder_configs SET
        folder_path = ?, folder_name = ?, is_enabled = ?, added_at = ?, last_scanned_at = ?,
        include_patterns = ?, exclude_patterns = ?, include_subfolders = ?
      WHERE id = ?`,
      [
        folder.folderPath,
        folder.folderName,
        folder.isEnabled ? 1 : 0,
        folder.addedAt,
        folder.lastScannedAt ?? null,
        JSON.stringify(folder.includePatterns ?? []),
        JSON.stringify(folder.excludePatterns ?? []),
        folder.includeSubfolders ? 1 : 0,
        folder.id,
      ],
    );
  }

  async deleteAsync(id: string): Promise<void> {
    const db = await this.open();
    await db.runAsync('DELETE FROM folder_configs WHERE id = ?', [id]);
  }
}

export type IFolderRepository = FolderRepository;
