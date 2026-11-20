/**
 * SQLite schema for the app, mirroring Stash.Maui.Data (StashDbContext):
 * `files` (with a unique content hash for deduplication) and `folder_configs`.
 */
import * as SQLite from 'expo-sqlite';

const DB_NAME = 'stash.db';

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY NOT NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  status TEXT NOT NULL,
  mega_temp_path TEXT,
  permanent_path TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  device_id TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL DEFAULT '',
  thumbnails TEXT NOT NULL DEFAULT '{}',
  converted_format TEXT,
  is_deduplicated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS folder_configs (
  id TEXT PRIMARY KEY NOT NULL,
  folder_path TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  added_at TEXT NOT NULL,
  last_scanned_at TEXT,
  include_patterns TEXT NOT NULL DEFAULT '[]',
  exclude_patterns TEXT NOT NULL DEFAULT '[]',
  include_subfolders INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_files_status ON files (status);
CREATE INDEX IF NOT EXISTS idx_files_content_hash ON files (content_hash);
`;

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = (async () => {
      const db = await SQLite.openDatabaseAsync(DB_NAME);
      await db.execAsync(SCHEMA);
      return db;
    })();
    databasePromise.catch(() => {
      // Allow a retry on the next call after a failed open.
      databasePromise = null;
    });
  }
  return databasePromise;
}

/** Parses a JSON column defensively so a bad row never crashes the UI. */
export function parseJsonColumn<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
