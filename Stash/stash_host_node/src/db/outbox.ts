import { randomUUID } from 'node:crypto';

import type { Db } from './database';
import { parseStringRecord } from './json';

export const OUTBOX_STATUSES = ['pending', 'sending', 'sent', 'dead'] as const;

export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export interface OutboxRow {
  id: string;
  job_id: string;
  kind: string;
  topic: string;
  key: string | null;
  payload: string;
  headers_json: string | null;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface EnqueueOutboxInput {
  id?: string;
  jobId: string;
  kind?: string;
  topic: string;
  key: string;
  payload: string;
  headers?: Record<string, string> | null;
  nextAttemptAt?: string;
  createdAt?: string;
}

export class OutboxRepository {
  constructor(private readonly db: Db) {}

  enqueue(input: EnqueueOutboxInput): { row: OutboxRow; created: boolean } {
    const id = input.id ?? randomUUID();
    const now = input.createdAt ?? new Date().toISOString();
    const kind = input.kind ?? 'response';
    const result = this.db
      .prepare(
        `INSERT INTO outbox (
           id, job_id, kind, topic, key, payload, headers_json, status, attempts,
           next_attempt_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT(job_id, kind) DO NOTHING`,
      )
      .run(
        id,
        input.jobId,
        kind,
        input.topic,
        input.key,
        input.payload,
        input.headers ? JSON.stringify(input.headers) : null,
        input.nextAttemptAt ?? now,
        now,
      );

    const row = this.getByJobAndKind(input.jobId, kind);
    if (!row) {
      throw new Error('Outbox insert was ignored but no existing row was found');
    }
    return { row, created: result.changes > 0 };
  }

  getById(id: string): OutboxRow | null {
    const row = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as OutboxRow | undefined;
    return row ?? null;
  }

  getByJobAndKind(jobId: string, kind: string): OutboxRow | null {
    const row = this.db
      .prepare('SELECT * FROM outbox WHERE job_id = ? AND kind = ?')
      .get(jobId, kind) as OutboxRow | undefined;
    return row ?? null;
  }

  due(limit = 20, now: Date = new Date()): OutboxRow[] {
    const safeLimit = clampLimit(limit);
    return this.db
      .prepare(
        `SELECT * FROM outbox
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC, created_at ASC
         LIMIT ?`,
      )
      .all(now.toISOString(), safeLimit) as OutboxRow[];
  }

  claimDue(limit = 20, now: Date = new Date()): OutboxRow[] {
    const nowIso = now.toISOString();
    const safeLimit = clampLimit(limit);

    return this.db.transaction(() => {
      const candidates = this.db
        .prepare(
          `SELECT id FROM outbox
           WHERE status = 'pending' AND next_attempt_at <= ?
           ORDER BY next_attempt_at ASC, created_at ASC
           LIMIT ?`,
        )
        .all(nowIso, safeLimit) as { id: string }[];

      if (candidates.length === 0) return [];

      const update = this.db.prepare(
        `UPDATE outbox
         SET status = 'sending', attempts = attempts + 1
         WHERE id = ? AND status = 'pending'`,
      );

      const claimed: OutboxRow[] = [];
      for (const candidate of candidates) {
        const result = update.run(candidate.id);
        if (result.changes === 0) continue;
        const row = this.getById(candidate.id);
        if (row) claimed.push(row);
      }
      return claimed;
    })();
  }

  /** Claims a specific pending row (pending -> sending, attempts + 1). */
  claimById(id: string, _now: Date = new Date()): OutboxRow | null {
    this.db
      .prepare(
        `UPDATE outbox
         SET status = 'sending', attempts = attempts + 1
         WHERE id = ? AND status = 'pending'`,
      )
      .run(id);
    return this.getById(id);
  }
  markSent(id: string, sentAt: Date = new Date()): OutboxRow | null {
    this.db
      .prepare(
        `UPDATE outbox
         SET status = 'sent', sent_at = ?, last_error = NULL
         WHERE id = ?`,
      )
      .run(sentAt.toISOString(), id);
    return this.getById(id);
  }

  markRetry(id: string, nextAttemptAt: string, lastError: string | null): OutboxRow | null {
    this.db
      .prepare(
        `UPDATE outbox
         SET status = 'pending', next_attempt_at = ?, last_error = ?
         WHERE id = ?`,
      )
      .run(nextAttemptAt, truncateError(lastError), id);
    return this.getById(id);
  }

  markDead(id: string, lastError: string | null): OutboxRow | null {
    this.db
      .prepare(
        `UPDATE outbox
         SET status = 'dead', last_error = ?
         WHERE id = ?`,
      )
      .run(truncateError(lastError), id);
    return this.getById(id);
  }

  markAllSendingAsPending(now: Date = new Date()): number {
    const result = this.db
      .prepare(
        `UPDATE outbox
         SET status = 'pending', next_attempt_at = ?
         WHERE status = 'sending'`,
      )
      .run(now.toISOString());
    return result.changes;
  }

  stats(): Record<OutboxStatus, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS count FROM outbox GROUP BY status')
      .all() as { status: OutboxStatus; count: number }[];
    const result: Record<OutboxStatus, number> = {
      pending: 0,
      sending: 0,
      sent: 0,
      dead: 0,
    };
    for (const row of rows) {
      if ((OUTBOX_STATUSES as readonly string[]).includes(row.status)) {
        result[row.status] = row.count;
      }
    }
    return result;
  }

  listByStatus(status: OutboxStatus, limit = 100): OutboxRow[] {
    return this.db
      .prepare('SELECT * FROM outbox WHERE status = ? ORDER BY created_at ASC LIMIT ?')
      .all(status, clampLimit(limit)) as OutboxRow[];
  }
}

export function outboxHeaders(row: OutboxRow): Record<string, string> {
  return parseStringRecord(row.headers_json);
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 20;
  return Math.min(Math.max(Math.trunc(limit), 1), 500);
}

function truncateError(message: string | null): string | null {
  if (message === null) return null;
  const limit = 500;
  return message.length <= limit ? message : `${message.slice(0, limit)}...`;
}
