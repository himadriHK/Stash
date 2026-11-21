import type Database from 'better-sqlite3';

import type { Db } from './database';

export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface JobEventRow {
  id: number;
  job_id: string;
  at: string;
  level: string | null;
  stage: string | null;
  event: string;
  message: string | null;
  data_json: string | null;
}

export interface AppendJobEventInput {
  jobId: string;
  event: string;
  level?: EventLevel;
  stage?: string | null;
  message?: string | null;
  data?: unknown;
  at?: string;
}

export class EventRepository {
  constructor(private readonly db: Db) {}

  append(input: AppendJobEventInput): number {
    const at = input.at ?? new Date().toISOString();
    const dataJson = input.data === undefined ? null : JSON.stringify(input.data);
    const result = this.db
      .prepare(
        `INSERT INTO job_events (job_id, at, level, stage, event, message, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.jobId,
        at,
        input.level ?? 'info',
        input.stage ?? null,
        input.event,
        input.message ?? null,
        dataJson,
      );
    return Number(result.lastInsertRowid);
  }

  listForJob(jobId: string, limit = 100): JobEventRow[] {
    const safeLimit = clampLimit(limit);
    return this.db
      .prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT ?')
      .all(jobId, safeLimit) as JobEventRow[];
  }

  listRecent(limit = 100): JobEventRow[] {
    const safeLimit = clampLimit(limit);
    return this.db
      .prepare('SELECT * FROM job_events ORDER BY id DESC LIMIT ?')
      .all(safeLimit) as JobEventRow[];
  }

  listGlobal(limit = 100): JobEventRow[] {
    return this.listRecent(limit);
  }

  countForJob(jobId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM job_events WHERE job_id = ?')
      .get(jobId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  pruneForJob(jobId: string, keep = 5000): number {
    const result = this.db
      .prepare(
        `DELETE FROM job_events
         WHERE job_id = ?
           AND id NOT IN (
             SELECT id FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT ?
           )`,
      )
      .run(jobId, jobId, Math.max(1, keep));
    return result.changes;
  }
}

export function insertJobEvent(
  db: Db,
  input: AppendJobEventInput,
): number {
  const at = input.at ?? new Date().toISOString();
  const dataJson = input.data === undefined ? null : JSON.stringify(input.data);
  const result: Database.RunResult = db
    .prepare(
      `INSERT INTO job_events (job_id, at, level, stage, event, message, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.jobId,
      at,
      input.level ?? 'info',
      input.stage ?? null,
      input.event,
      input.message ?? null,
      dataJson,
    );
  return Number(result.lastInsertRowid);
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 100;
  return Math.min(Math.max(Math.trunc(limit), 1), 500);
}
