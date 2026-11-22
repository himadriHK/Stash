/**
 * HashCacheRepository - persistence for the `file_hash_cache` table created in
 * schema version 2. A cache hit requires the same URI, size and modified time,
 * so unchanged files can skip the native digest on later scans.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from './database';
import { runTransactionAsync, runWriteAsync } from './transactionQueue';

export interface HashCacheEntry {
  uri: string;
  size: number;
  modifiedAt: string;
  contentHash: string;
  updatedAt: string;
}

export interface HashCacheWrite {
  uri: string;
  size: number;
  modifiedAt: string;
  contentHash: string;
}

const HASH_CACHE_UPSERT_SQL = `INSERT INTO file_hash_cache (uri, size, modified_at, content_hash, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(uri) DO UPDATE SET
    size = excluded.size,
    modified_at = excluded.modified_at,
    content_hash = excluded.content_hash,
    updated_at = excluded.updated_at`;

function hashCacheParams(entry: HashCacheWrite): (string | number)[] {
  return [
    entry.uri,
    entry.size,
    entry.modifiedAt,
    entry.contentHash.toLowerCase(),
    new Date().toISOString(),
  ];
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

  /**
   * Loads the whole cache in one query. Ingestion works on 10k+ files, so a
   * per-URI lookup would mean a bridge round trip per file; callers preload this
   * map once and keep it in memory for the pass.
   */
  async getAllAsync(): Promise<HashCacheEntry[]> {
    const db = await this.open();
    const rows = await db.getAllAsync<HashCacheRow>(
      `SELECT uri, size, modified_at, content_hash, updated_at FROM file_hash_cache`,
    );
    return rows.map(mapRow);
  }

  async putAsync(entry: {
    uri: string;
    size: number;
    modifiedAt: string;
    contentHash: string;
  }): Promise<void> {
    const db = await this.open();
    await runWriteAsync(db, HASH_CACHE_UPSERT_SQL, hashCacheParams(entry));
  }

  /** Writes many cache entries in one transaction (one per scanned file). */
  async putManyAsync(
    entries: readonly { uri: string; size: number; modifiedAt: string; contentHash: string }[],
  ): Promise<number> {
    if (entries.length === 0) {
      return 0;
    }
    const db = await this.open();
    let written = 0;
    await runTransactionAsync(db, async () => {
      for (const entry of entries) {
        const result = await db.runAsync(HASH_CACHE_UPSERT_SQL, hashCacheParams(entry));
        written += result.changes;
      }
    });
    return written;
  }

  async pruneAsync(olderThanIso: string): Promise<void> {
    const db = await this.open();
    await runWriteAsync(db, 'DELETE FROM file_hash_cache WHERE updated_at < ?', [olderThanIso]);
  }

  async clearAsync(): Promise<void> {
    const db = await this.open();
    await runWriteAsync(db, 'DELETE FROM file_hash_cache');
  }
}