import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { migrate } from './migrations';

export type Db = Database.Database;

function applyPragmas(db: Db): void {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
}

export interface OpenDatabaseOptions {
  readonly migrateOnOpen?: boolean;
}

export function openDatabase(dbPath: string, options: OpenDatabaseOptions = {}): Db {
  const resolvedPath = dbPath === ':memory:' ? dbPath : path.resolve(dbPath);
  if (resolvedPath !== ':memory:') {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const db = new Database(resolvedPath);
  applyPragmas(db);
  if (options.migrateOnOpen !== false) {
    migrate(db);
  }
  return db;
}

export function migrateDatabase(db: Db): number {
  return migrate(db);
}

export function closeDatabase(db: Db | null | undefined): void {
  if (!db) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // A checkpoint is best-effort; closing still releases the handle.
  }
  db.close();
}
