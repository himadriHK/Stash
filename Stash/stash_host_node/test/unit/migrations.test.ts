import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase } from '../../src/db/database';
import { LATEST_SCHEMA_VERSION, migrate } from '../../src/db/migrations';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stash-migrations-test-'));

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('migrations', () => {
  it('migrates a fresh database to the latest version with the WAL pragmas', () => {
    const dbPath = path.join(root, 'fresh', 'nested', 'stash.db');
    const db = openDatabase(dbPath);

    expect(LATEST_SCHEMA_VERSION).toBe(3);
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('temp_store', { simple: true })).toBe(2);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((table) => table.name);
    expect(names).toContain('jobs');
    expect(names).toContain('job_events');
    expect(names).toContain('outbox');
    expect(names).toContain('component_checks');

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
      .all() as { name: string }[];
    const indexNames = indexes.map((index) => index.name);
    expect(indexNames).toContain('idx_jobs_status_next_attempt');
    expect(indexNames).toContain('idx_jobs_status_stage');
    expect(indexNames).toContain('idx_job_events_job');
    expect(indexNames).toContain('idx_outbox_status_next_attempt');

    const jobColumns = (
      db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(jobColumns).toContain('content_hash');
    expect(jobColumns).not.toContain('file_size');

    closeDatabase(db);
  });

  it('is idempotent when reopened and preserves rows', () => {
    const dbPath = path.join(root, 'idempotent', 'stash.db');
    const first = openDatabase(dbPath);
    const now = new Date().toISOString();
    first
      .prepare(
        `INSERT INTO jobs (id, correlation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run('job-1', 'correlation-1', now, now);
    closeDatabase(first);

    const second = openDatabase(dbPath);
    expect(second.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(migrate(second)).toBe(LATEST_SCHEMA_VERSION);
    expect(migrate(second)).toBe(LATEST_SCHEMA_VERSION);
    const row = second.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number };
    expect(row.count).toBe(1);
    closeDatabase(second);
  });

  it('defaults the required job columns', () => {
    const dbPath = path.join(root, 'defaults', 'stash.db');
    const db = openDatabase(dbPath);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO jobs (id, correlation_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('job-1', 'correlation-1', now, now);
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get('job-1') as Record<string, unknown>;

    expect(job['status']).toBe('queued');
    expect(job['stage']).toBe('queued');
    expect(job['progress']).toBe(0);
    expect(job['attempts']).toBe(0);
    expect(job['max_attempts']).toBe(4);
    expect(job['stage_attempts_json']).toBe('{}');
    expect(job['thumbnails_json']).toBe('{}');
    expect(job['cancel_requested']).toBe(0);
    expect(job['deduplicated']).toBe(0);

    closeDatabase(db);
  });
});
