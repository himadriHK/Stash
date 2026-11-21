/**
 * HashCacheRepository - persistence for the `file_hash_cache` table created in
 * schema version 2. A cache hit requires the same URI, size and modified time,
 * so unchanged files can skip the native digest on later scans.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from './database';

export interface HashCacheEntry {
  uri: string;
  size: number;
  modifiedAt: string;
  contentHash: string;
  updatedAt: string;
}

interface HashCacheRow {
  uri: string;
  size: number;
  modified_at: string;
  content_hash: string;
  updated_at: string;
}

function mapRow(row: HashCacheRow): HashCacheEntry {
  return {
    uri: row.uri,
    size: row.size,
    modifiedAt: row.modified_at,
    contentHash: row.content_hash,
    updatedAt: row.updated_at,
  };
}

export class HashCacheRepository {
  constructor(private readonly open: () => Promise<SQLiteDatabase> = getDatabase) {}

  async getAsync(uri: string): Promise<HashCacheEntry | null> {
    const db = await this.open();
    const row = await db.getFirstAsync<HashCacheRow>(
      `SELECT uri, size, modified_at, content_hash, updated_at
       FROM file_hash_cache WHERE uri = ?`,
      [uri],
    );
    return row ? mapRow(row) : null;
  }

  async putAsync(entry: {
    uri: string;
    size: number;
    modifiedAt: string;
    contentHash: string;
  }): Promise<void> {
    const db = await this.open();
    await db.runAsync(
      `INSERT INTO file_hash_cache (uri, size, modified_at, content_hash, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(uri) DO UPDATE SET
         size = excluded.size,
         modified_at = excluded.modified_at,
         content_hash = excluded.content_hash,
         updated_at = excluded.updated_at`,
      [entry.uri, entry.size, entry.modifiedAt, entry.contentHash.toLowerCase(), new Date().toISOString()],
    );
  }

  async pruneAsync(olderThanIso: string): Promise<void> {
    const db = await this.open();
    await db.runAsync('DELETE FROM file_hash_cache WHERE updated_at < ?', [olderThanIso]);
  }

  async clearAsync(): Promise<void> {
    const db = await this.open();
    await db.runAsync('DELETE FROM file_hash_cache');
  }
}