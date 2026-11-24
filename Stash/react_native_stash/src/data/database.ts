/**
 * SQLite schema for the app, mirroring Stash.Maui.Data (StashDbContext):
 * `files` (with a unique metadata identity for deduplication) and
 * `folder_configs`.
 */
import * as SQLite from 'expo-sqlite';
import { runTransactionAsync } from './transactionQueue';
import { profileAsync } from '../utils/profiler';
import { computeMetadataHash } from '../utils/fileIdentity';

const DB_NAME = 'stash.db';

/**
 * Phase 0 additive objects for lifecycle tracking and Kafka delivery. This block
 * is shared by the fresh-install schema and the version-2 migration so both
 * paths converge on the same shape.
 */
const LIFECYCLE_SCHEMA = `
CREATE INDEX IF NOT EXISTS idx_files_status_retry ON files (status, retry_count);

CREATE TABLE IF NOT EXISTS outbox_messages (
  id TEXT PRIMARY KEY NOT NULL,
  file_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_status_next ON outbox_messages(status, next_attempt_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_active_file ON outbox_messages(file_id) WHERE status IN ('pending', 'sending');

CREATE TABLE IF NOT EXISTS file_events (
  id TEXT PRIMARY KEY NOT NULL,
  file_id TEXT NOT NULL,
  event TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  correlation_id TEXT,
  error_code TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_events_file ON file_events(file_id, created_at);

CREATE TABLE IF NOT EXISTS processed_messages (
  message_id TEXT PRIMARY KEY NOT NULL,
  file_id TEXT,
  correlation_id TEXT,
  processed_at TEXT NOT NULL
);

`;

/**
 * Physical schema for a fresh install. It already contains every object the
 * migration runner adds, so a new database reaches the latest `user_version`
 * without relying on migration ordering.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY NOT NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  metadata_hash TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  status TEXT NOT NULL,
  storage_temp_path TEXT,
  permanent_path TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  device_id TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL DEFAULT '',
  thumbnails TEXT NOT NULL DEFAULT '{}',
  converted_format TEXT,
  is_deduplicated INTEGER NOT NULL DEFAULT 0,
  upload_started_at TEXT,
  processing_started_at TEXT,
  last_response_at TEXT,
  request_correlation_id TEXT,
  request_message_id TEXT,
  host_retry_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  failure_stage TEXT,
  updated_at TEXT
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
CREATE INDEX IF NOT EXISTS idx_files_metadata_hash ON files (metadata_hash);
CREATE INDEX IF NOT EXISTS idx_files_discovered_at ON files (discovered_at);
CREATE INDEX IF NOT EXISTS idx_files_status_discovered ON files (status, discovered_at);

${LIFECYCLE_SCHEMA}
`;

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Adds a column only when `PRAGMA table_info` does not already report it, so the
 * migration can be re-run without failing on an existing column.
 */
async function addColumnIfMissingAsync(
  db: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  if (!IDENTIFIER_PATTERN.test(table) || !IDENTIFIER_PATTERN.test(column)) {
    throw new Error(`Refusing to alter unexpected table/column identifier: ${table}.${column}`);
  }
  const columns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  if (columns.some((existing) => existing.name === column)) {
    return;
  }
  await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Version 1 migration: one-time migration from the legacy `mega_temp_path`
 * column to the provider-agnostic `storage_temp_path` column. Idempotent: it
 * inspects the live table so older databases are upgraded exactly once.
 */
async function migrateFilesStorageTempPathAsync(db: SQLite.SQLiteDatabase): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(files)');
  const names = new Set(columns.map((column) => column.name));
  let hasNewColumn = names.has('storage_temp_path');
  let hasOldColumn = names.has('mega_temp_path');

  if (!hasNewColumn && hasOldColumn) {
    try {
      await db.execAsync('ALTER TABLE files RENAME COLUMN mega_temp_path TO storage_temp_path');
      hasNewColumn = true;
      hasOldColumn = false;
    } catch (error) {
      console.warn('Could not rename mega_temp_path; adding storage_temp_path instead.', error);
    }
  }

  if (!hasNewColumn) {
    // If this fails the new column truly cannot be created, so let it throw.
    await db.execAsync('ALTER TABLE files ADD COLUMN storage_temp_path TEXT');
  }

  if (hasOldColumn) {
    try {
      await db.execAsync(
        'UPDATE files SET storage_temp_path = mega_temp_path WHERE storage_temp_path IS NULL',
      );
      await db.execAsync('ALTER TABLE files DROP COLUMN mega_temp_path');
    } catch (error) {
      // The copy usually succeeds even when the optional DROP is unsupported on
      // older SQLite builds; the app works either way, so log and continue.
      console.warn('Could not fully retire the legacy mega_temp_path column.', error);
    }
  }
}

/**
 * Version 2 migration: additive lifecycle columns plus the delivery/audit
 * tables. SQLite supports transactional DDL on both native and WASM builds, so
 * the object creation and backfill run in one transaction. `PRAGMA user_version`
 * is written after the transaction commits so a failure never leaves a
 * half-applied version marker.
 */
async function migrateLifecycleAndDeliveryAsync(db: SQLite.SQLiteDatabase): Promise<void> {
  await runTransactionAsync(db, async () => {
    await addColumnIfMissingAsync(db, 'files', 'upload_started_at', 'TEXT');
    await addColumnIfMissingAsync(db, 'files', 'processing_started_at', 'TEXT');
    await addColumnIfMissingAsync(db, 'files', 'last_response_at', 'TEXT');
    await addColumnIfMissingAsync(db, 'files', 'request_correlation_id', 'TEXT');
    await addColumnIfMissingAsync(db, 'files', 'request_message_id', 'TEXT');
    await addColumnIfMissingAsync(db, 'files', 'host_retry_count', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissingAsync(db, 'files', 'next_attempt_at', 'TEXT');
    await addColumnIfMissingAsync(db, 'files', 'failure_stage', 'TEXT');
    await addColumnIfMissingAsync(db, 'files', 'updated_at', 'TEXT');

    await db.execAsync(
      'CREATE INDEX IF NOT EXISTS idx_files_next_attempt ON files (next_attempt_at);',
    );

    await db.execAsync(`
      UPDATE files
      SET updated_at = COALESCE(updated_at, discovered_at, created_at, modified_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      WHERE updated_at IS NULL;
    `);

    await db.execAsync(LIFECYCLE_SCHEMA);
  });
}

/**
 * Version 3 migration: indexes for paginated file lists and status+discovered
 * ordering. Additive and idempotent; the fresh SCHEMA already declares the same
 * indexes so both install paths converge.
 */
async function migrateScalingIndexesAsync(db: SQLite.SQLiteDatabase): Promise<void> {
  await runTransactionAsync(db, async () => {
    await db.execAsync(
      'CREATE INDEX IF NOT EXISTS idx_files_discovered_at ON files(discovered_at);',
    );
    await db.execAsync(
      'CREATE INDEX IF NOT EXISTS idx_files_status_discovered ON files(status, discovered_at);',
    );
  });
}

/**
 * Version 4 migration: replace the content-hash identity with the metadata
 * identity (normalised name + size). The column is renamed so existing values
 * stay until they are recomputed, the unique index keeps enforcing one row per
 * identity, and the hash cache table (which existed only to remember content
 * digests) is dropped.
 *
 * Recomputing may collide when two tracked rows share a name and size; that row
 * keeps its legacy value rather than failing the upgrade, and a later scan
 * simply inserts it under the shared identity.
 */
async function migrateMetadataIdentityAsync(db: SQLite.SQLiteDatabase): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(files)');
  const names = new Set(columns.map((column) => column.name));

  if (!names.has('metadata_hash') && names.has('content_hash')) {
    await db.execAsync('ALTER TABLE files RENAME COLUMN content_hash TO metadata_hash');
  } else if (!names.has('metadata_hash')) {
    await db.execAsync('ALTER TABLE files ADD COLUMN metadata_hash TEXT');
  }

  await db.execAsync('DROP INDEX IF EXISTS idx_files_content_hash;');
  await db.execAsync(
    'CREATE INDEX IF NOT EXISTS idx_files_metadata_hash ON files (metadata_hash);',
  );

  const rows = await db.getAllAsync<{ id: string; file_name: string; file_size: number }>(
    'SELECT id, file_name, file_size FROM files',
  );
  for (const row of rows) {
    const metadataHash = await computeMetadataHash(row.file_name ?? '', row.file_size ?? 0);
    try {
      await db.runAsync('UPDATE files SET metadata_hash = ? WHERE id = ?', [metadataHash, row.id]);
    } catch (error) {
      console.warn(
        '[database] Kept the legacy identity for a row that collides with an existing name + size.',
        error,
      );
    }
  }

  await db.execAsync('DROP TABLE IF EXISTS file_hash_cache;');
}

interface Migration {
  version: number;
  description: string;
  run: (db: SQLite.SQLiteDatabase) => Promise<void>;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'storage_temp_path compatibility',
    run: migrateFilesStorageTempPathAsync,
  },
  {
    version: 2,
    description: 'lifecycle columns and delivery tables',
    run: migrateLifecycleAndDeliveryAsync,
  },
  {
    version: 3,
    description: 'pagination and scan indexes',
    run: migrateScalingIndexesAsync,
  },
  {
    version: 4,
    description: 'metadata identity instead of content hash',
    run: migrateMetadataIdentityAsync,
  },
];

const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

async function getSchemaVersionAsync(db: SQLite.SQLiteDatabase): Promise<number> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

/**
 * Ordered, additive migration runner. Each version records its own
 * `PRAGMA user_version` marker only after its work completes, so a failure
 * re-runs the same version on the next open instead of skipping it. The PRAGMA
 * value is interpolated because SQLite does not accept bound parameters there.
 */
async function runMigrationsAsync(db: SQLite.SQLiteDatabase): Promise<void> {
  let version = await getSchemaVersionAsync(db);

  if (version > LATEST_SCHEMA_VERSION) {
    console.warn(
      `[database] stash.db user_version ${version} is newer than this build (${LATEST_SCHEMA_VERSION}); skipping migrations.`,
    );
    return;
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= version) {
      continue;
    }
    try {
      await migration.run(db);
      await db.execAsync(`PRAGMA user_version = ${migration.version}`);
      version = migration.version;
    } catch (error) {
      console.error(
        `[database] Migration v${migration.version} (${migration.description}) failed; user_version stays at ${version}.`,
        error,
      );
      throw error;
    }
  }
}

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

/**
 * Deletes `stash.db` (rows, schema and its WAL/SHM side files) so the next
 * `getDatabase()` call recreates it from `SCHEMA` at the latest version.
 *
 * The cached open promise is cleared first and the live handle closed, so no
 * later call can reuse a handle pointing at the deleted file. The device's media
 * files and the host library are untouched.
 */
export async function resetDatabaseAsync(): Promise<void> {
  const pending = databasePromise;
  databasePromise = null;
  if (pending) {
    try {
      const db = await pending;
      await db.closeAsync();
    } catch {
      // A failed open never produced a usable handle; deleting the file is enough.
    }
  }
  await SQLite.deleteDatabaseAsync(DB_NAME);
}

export function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = profileAsync(
      'db.open',
      async () => {
        const db = await SQLite.openDatabaseAsync(DB_NAME);
        await db.execAsync(SCHEMA);
        await runMigrationsAsync(db);
        return db;
      },
      { sentry: false },
    );
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