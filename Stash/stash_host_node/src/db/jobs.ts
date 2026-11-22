import type { JobStatus, Stage } from '../contracts/stages';
import type { Db } from './database';
import type { JobEventRow } from './events';
import { EventRepository, insertJobEvent } from './events';
import { parseJsonObject } from './json';

export interface JobRow {
  id: string;
  correlation_id: string;
  message_id: string | null;
  file_id: string | null;
  request_file_id: string | null;
  file_name: string | null;
  file_size: number | null;
  downloaded_size: number | null;
  mime_type: string | null;
  storage_provider: string | null;
  storage_temp_path: string | null;
  storage_key: string | null;
  user_id: string | null;
  device_id: string | null;
  metadata_json: string | null;
  status: JobStatus;
  stage: Stage;
  failed_stage: string | null;
  progress: number;
  attempts: number;
  max_attempts: number;
  stage_attempts_json: string;
  next_attempt_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  cancel_requested: number;
  deduplicated: number;
  permanent_path: string | null;
  thumbnails_json: string;
  converted_format: string | null;
  temp_dir: string | null;
  error_code: string | null;
  error_message: string | null;
  processing_time_ms: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface InsertJobInput {
  id: string;
  correlationId: string;
  messageId: string;
  fileId: string;
  requestFileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  storageProvider: string;
  storageTempPath: string;
  storageKey: string;
  userId: string;
  deviceId: string;
  metadataJson?: string | null;
  maxAttempts?: number;
  tempDir?: string | null;
  createdAt?: string;
}

export interface JobListFilters {
  status?: JobStatus;
  stage?: Stage;
  userId?: string;
  deviceId?: string;
  deduplicated?: boolean;
  search?: string;
  createdFrom?: string;
  createdTo?: string;
  limit?: number;
  offset?: number;
  order?: 'newest' | 'oldest' | 'longest' | 'attempts';
}

export interface JobListResult {
  items: JobRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface ReleaseRetryOptions {
  stage?: Stage;
  errorCode?: string | null;
  errorMessage?: string | null;
  nextAttemptAt: string;
  incrementStageAttempt?: boolean;
}

export interface CompleteJobOptions {
  permanentPath: string;
  thumbnails: Record<string, string>;
  convertedFormat: string | null;
  deduplicated: boolean;
}

export interface TerminalFailOptions {
  failedStage?: Stage;
  errorCode: string;
  errorMessage: string;
}

export interface MarkForFinalizationOptions {
  failedStage?: Stage | string;
  errorCode: string;
  errorMessage: string;
}

export type FinalizeJobStatus = 'completed' | 'failed' | 'cancelled';

export interface FinalizeJobOptions {
  status: FinalizeJobStatus;
  errorCode?: string;
  errorMessage?: string;
}

export interface JobStats {
  total: number;
  byStatus: Record<string, number>;
  byStage: Record<string, number>;
  deduplicated: number;
}

const JOB_PATCH_FIELDS = [
  'message_id',
  'file_id',
  'request_file_id',
  'file_name',
  'file_size',
  'downloaded_size',
  'mime_type',
  'storage_provider',
  'storage_temp_path',
  'storage_key',
  'user_id',
  'device_id',
  'metadata_json',
  'status',
  'stage',
  'failed_stage',
  'progress',
  'attempts',
  'max_attempts',
  'stage_attempts_json',
  'next_attempt_at',
  'lease_owner',
  'lease_expires_at',
  'heartbeat_at',
  'cancel_requested',
  'deduplicated',
  'permanent_path',
  'thumbnails_json',
  'converted_format',
  'temp_dir',
  'error_code',
  'error_message',
  'processing_time_ms',
  'started_at',
  'finished_at',
] as const;

export type JobPatchField = (typeof JOB_PATCH_FIELDS)[number];

export type JobPatch = Partial<Record<JobPatchField, string | number | null>>;

const JOB_PATCH_FIELD_SET = new Set<string>(JOB_PATCH_FIELDS);

export class JobRepository {
  private readonly events: EventRepository;

  constructor(private readonly db: Db) {
    this.events = new EventRepository(db);
  }

  insert(input: InsertJobInput): JobRow {
    const now = input.createdAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO jobs (
           id, correlation_id, message_id, file_id, request_file_id, file_name, file_size,
           mime_type, storage_provider, storage_temp_path, storage_key, user_id, device_id,
           metadata_json, max_attempts, temp_dir, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.correlationId,
        input.messageId,
        input.fileId,
        input.requestFileId,
        input.fileName,
        input.fileSize,
        input.mimeType,
        input.storageProvider,
        input.storageTempPath,
        input.storageKey,
        input.userId,
        input.deviceId,
        input.metadataJson ?? null,
        input.maxAttempts ?? 4,
        input.tempDir ?? null,
        now,
        now,
      );
    return this.requireById(input.id);
  }

  insertIfNew(input: InsertJobInput): { job: JobRow; created: boolean } {
    const now = input.createdAt ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs (
           id, correlation_id, message_id, file_id, request_file_id, file_name, file_size,
           mime_type, storage_provider, storage_temp_path, storage_key, user_id, device_id,
           metadata_json, max_attempts, temp_dir, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.correlationId,
        input.messageId,
        input.fileId,
        input.requestFileId,
        input.fileName,
        input.fileSize,
        input.mimeType,
        input.storageProvider,
        input.storageTempPath,
        input.storageKey,
        input.userId,
        input.deviceId,
        input.metadataJson ?? null,
        input.maxAttempts ?? 4,
        input.tempDir ?? null,
        now,
        now,
      );

    if (result.changes > 0) {
      return { job: this.requireById(input.id), created: true };
    }

    const existing = this.getByCorrelationId(input.correlationId);
    if (!existing) {
      throw new Error('Insert was ignored but no existing job was found for the correlation id');
    }
    return { job: existing, created: false };
  }

  getById(id: string): JobRow | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ?? null;
  }

  getByCorrelationId(correlationId: string): JobRow | null {
    const row = this.db
      .prepare('SELECT * FROM jobs WHERE correlation_id = ?')
      .get(correlationId) as JobRow | undefined;
    return row ?? null;
  }

  list(filters: JobListFilters = {}): JobListResult {
    const limit = clampLimit(filters.limit ?? 50);
    const offset = Math.max(0, Math.trunc(filters.offset ?? 0));
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (filters.status) {
      clauses.push('status = ?');
      params.push(filters.status);
    }
    if (filters.stage) {
      clauses.push('stage = ?');
      params.push(filters.stage);
    }
    if (filters.userId) {
      clauses.push('user_id = ?');
      params.push(filters.userId);
    }
    if (filters.deviceId) {
      clauses.push('device_id = ?');
      params.push(filters.deviceId);
    }
    if (filters.deduplicated !== undefined) {
      clauses.push('deduplicated = ?');
      params.push(filters.deduplicated ? 1 : 0);
    }
    if (filters.search) {
      const term = `%${escapeLike(filters.search)}%`;
      clauses.push(
        "(file_name LIKE ? ESCAPE '\\' OR file_id LIKE ? ESCAPE '\\' OR correlation_id LIKE ? ESCAPE '\\' OR error_code LIKE ? ESCAPE '\\')",
      );
      params.push(term, term, term, term);
    }
    if (filters.createdFrom) {
      clauses.push('created_at >= ?');
      params.push(filters.createdFrom);
    }
    if (filters.createdTo) {
      clauses.push('created_at <= ?');
      params.push(filters.createdTo);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const orderBy = selectOrder(filters.order);

    const items = this.db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as JobRow[];
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM jobs ${where}`)
      .get(...params) as { count: number } | undefined;

    return { items, total: countRow?.count ?? 0, limit, offset };
  }

  updateFields(id: string, patch: JobPatch): JobRow | null {
    const entries = Object.entries(patch).filter(([field]) => JOB_PATCH_FIELD_SET.has(field));
    if (entries.length === 0) return this.getById(id);

    const assignments = entries.map(([field]) => `${field} = ?`).join(', ');
    const values = entries.map(([, value]) => value ?? null);
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE jobs SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...values, now, id);
    return this.getById(id);
  }

  advanceStage(id: string, stage: Stage, progress?: number): JobRow | null {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs
         SET stage = ?,
             progress = MAX(progress, COALESCE(?, progress)),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(stage, progress ?? null, now, id);
    return this.getById(id);
  }

  claimNextJob(owner: string, leaseSeconds: number, now: Date = new Date()): JobRow | null {
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString();

    return this.db.transaction(() => {
      const candidate = this.db
        .prepare(
          `SELECT id FROM jobs
           WHERE status = 'queued'
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
           ORDER BY COALESCE(next_attempt_at, created_at) ASC, created_at ASC
           LIMIT 1`,
        )
        .get(nowIso, nowIso) as { id: string } | undefined;

      if (!candidate) return null;

      const result = this.db
        .prepare(
          `UPDATE jobs
           SET status = 'running',
               stage = CASE WHEN stage = 'queued' THEN 'download' ELSE stage END,
               progress = MAX(progress, 10),
               attempts = attempts + 1,
               started_at = COALESCE(started_at, ?),
               lease_owner = ?,
               lease_expires_at = ?,
               heartbeat_at = ?,
               next_attempt_at = NULL,
               error_code = CASE WHEN failed_stage IS NOT NULL THEN error_code ELSE NULL END,
               error_message = CASE WHEN failed_stage IS NOT NULL THEN error_message ELSE NULL END,
               updated_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(nowIso, owner, leaseUntil, nowIso, nowIso, candidate.id);

      if (result.changes === 0) return null;
      return this.getById(candidate.id);
    })();
  }

  heartbeat(id: string, owner: string, leaseSeconds: number, now: Date = new Date()): boolean {
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
    const result = this.db
      .prepare(
        `UPDATE jobs
         SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
         WHERE id = ? AND lease_owner = ? AND status = 'running'`,
      )
      .run(leaseUntil, nowIso, nowIso, id, owner);
    return result.changes > 0;
  }

  releaseForRetry(id: string, owner: string | null, options: ReleaseRetryOptions): JobRow | null {
    return this.db.transaction(() => {
      const job = this.getById(id);
      if (!job) return null;
      if (owner !== null && job.lease_owner !== null && job.lease_owner !== owner) return null;

      const stage = options.stage ?? job.stage;
      const stageAttempts = parseJsonObject(job.stage_attempts_json);
      const currentAttempt = typeof stageAttempts[stage] === 'number' ? (stageAttempts[stage] as number) : 0;
      if (options.incrementStageAttempt !== false) {
        stageAttempts[stage] = currentAttempt + 1;
      }

      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE jobs
           SET status = 'queued',
               stage = ?,
               stage_attempts_json = ?,
               next_attempt_at = ?,
               lease_owner = NULL,
               lease_expires_at = NULL,
               heartbeat_at = NULL,
               error_code = ?,
               error_message = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          stage,
          JSON.stringify(stageAttempts),
          options.nextAttemptAt,
          options.errorCode ?? null,
          options.errorMessage ?? null,
          now,
          id,
        );

      insertJobEvent(this.db, {
        jobId: id,
        event: 'retry_scheduled',
        level: 'warn',
        stage,
        message: options.errorMessage ?? null,
        data: { nextAttemptAt: options.nextAttemptAt, errorCode: options.errorCode ?? null },
        at: now,
      });

      return this.getById(id);
    })();
  }

  terminalFail(id: string, options: TerminalFailOptions): JobRow | null {
    return this.db.transaction(() => {
      const job = this.getById(id);
      if (!job) return null;
      const now = new Date().toISOString();
      const failedStage = options.failedStage ?? job.stage;
      const processingTimeMs = computeProcessingTime(job, now);

      this.db
        .prepare(
          `UPDATE jobs
           SET status = 'failed',
               failed_stage = ?,
               error_code = ?,
               error_message = ?,
               finished_at = ?,
               processing_time_ms = ?,
               lease_owner = NULL,
               lease_expires_at = NULL,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(failedStage, options.errorCode, options.errorMessage, now, processingTimeMs, now, id);

      insertJobEvent(this.db, {
        jobId: id,
        event: 'terminal_failure',
        level: 'error',
        stage: failedStage,
        message: options.errorMessage,
        data: { errorCode: options.errorCode },
        at: now,
      });

      return this.getById(id);
    })();
  }

  /**
   * Stages a job for finalization instead of finalizing it. The response stage
   * (and subsequent guarded S3 deletion) must run before a job becomes
   * terminal, so failures and cancellations are queued at `respond`.
   */
  markForFinalization(
    id: string,
    options: MarkForFinalizationOptions,
    now: Date = new Date(),
  ): JobRow | null {
    return this.db.transaction(() => {
      const job = this.getById(id);
      if (!job) return null;
      this.applyFinalization(job, options, now.toISOString());
      return this.getById(id);
    })();
  }

  private applyFinalization(
    job: JobRow,
    options: MarkForFinalizationOptions,
    nowIso: string,
  ): void {
    const failedStage = options.failedStage ?? job.failed_stage ?? job.stage;
    this.db
      .prepare(
        `UPDATE jobs
         SET status = 'queued',
             stage = 'respond',
             progress = MAX(progress, 92),
             failed_stage = ?,
             error_code = ?,
             error_message = ?,
             next_attempt_at = ?,
             lease_owner = NULL,
             lease_expires_at = NULL,
             heartbeat_at = NULL,
             finished_at = NULL,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(failedStage, options.errorCode, options.errorMessage, nowIso, nowIso, job.id);

    insertJobEvent(this.db, {
      jobId: job.id,
      event: 'finalization_queued',
      level: 'warn',
      stage: 'respond',
      message: options.errorMessage,
      data: { failedStage, errorCode: options.errorCode },
      at: nowIso,
    });
  }

  /** Moves a job to a terminal state after its response and cleanup stages. */
  finalize(id: string, options: FinalizeJobOptions, now: Date = new Date()): JobRow | null {
    return this.db.transaction(() => {
      const job = this.getById(id);
      if (!job) return null;
      const finishedAt = now.toISOString();
      const processingTimeMs = computeProcessingTime(job, finishedAt);
      const completed = options.status === 'completed';
      const errorCode = completed ? null : (options.errorCode ?? job.error_code);
      const errorMessage = completed ? null : (options.errorMessage ?? job.error_message);
      const failedStage = completed ? null : job.failed_stage;
      const event =
        options.status === 'completed'
          ? 'job_completed'
          : options.status === 'cancelled'
            ? 'job_cancelled'
            : 'job_failed';
      const level = options.status === 'completed' ? 'info' : options.status === 'cancelled' ? 'warn' : 'error';

      this.db
        .prepare(
          `UPDATE jobs
           SET status = ?,
               stage = 'done',
               progress = 100,
               finished_at = ?,
               processing_time_ms = ?,
               lease_owner = NULL,
               lease_expires_at = NULL,
               heartbeat_at = NULL,
               next_attempt_at = NULL,
               error_code = ?,
               error_message = ?,
               failed_stage = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          options.status,
          finishedAt,
          processingTimeMs,
          errorCode,
          errorMessage,
          failedStage,
          finishedAt,
          id,
        );

      insertJobEvent(this.db, {
        jobId: id,
        event,
        level,
        stage: 'done',
        message: errorMessage,
        data: { status: options.status, failedStage },
        at: finishedAt,
      });

      return this.getById(id);
    })();
  }

  complete(id: string, options: CompleteJobOptions): JobRow | null {
    return this.db.transaction(() => {
      const job = this.getById(id);
      if (!job) return null;
      const now = new Date().toISOString();
      const processingTimeMs = computeProcessingTime(job, now);

      this.db
        .prepare(
          `UPDATE jobs
           SET status = 'completed',
               stage = 'done',
               progress = 100,
               permanent_path = ?,
               thumbnails_json = ?,
               converted_format = ?,
               deduplicated = ?,
               finished_at = ?,
               processing_time_ms = ?,
               lease_owner = NULL,
               lease_expires_at = NULL,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          options.permanentPath,
          JSON.stringify(options.thumbnails),
          options.convertedFormat,
          options.deduplicated ? 1 : 0,
          now,
          processingTimeMs,
          now,
          id,
        );

      insertJobEvent(this.db, {
        jobId: id,
        event: 'job_completed',
        level: 'info',
        stage: 'done',
        data: { deduplicated: options.deduplicated, convertedFormat: options.convertedFormat },
        at: now,
      });

      return this.getById(id);
    })();
  }

  requestCancel(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE jobs
         SET cancel_requested = 1, updated_at = ?
         WHERE id = ? AND status IN ('queued','running')`,
      )
      .run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  /**
   * Queued jobs are staged for finalization so a FAILED response and guarded
   * S3 cleanup still run. Running jobs only get the cancellation flag; the
   * runner aborts the active stage and then stages finalization itself.
   */
  cancel(id: string, reason = 'Cancelled'): JobRow | null {
    return this.db.transaction(() => {
      const job = this.getById(id);
      if (!job) return null;
      const now = new Date().toISOString();

      if (job.status === 'queued') {
        this.db.prepare('UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?').run(now, id);
        this.applyFinalization(
          job,
          { failedStage: 'cancelled', errorCode: 'cancelled', errorMessage: reason },
          now,
        );
        return this.getById(id);
      }

      if (job.status === 'running') {
        this.db.prepare('UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?').run(now, id);
        insertJobEvent(this.db, {
          jobId: id,
          event: 'cancel_requested',
          level: 'warn',
          stage: job.stage,
          message: reason,
          at: now,
        });
        return this.getById(id);
      }

      return job;
    })();
  }

  recoverExpiredLeases(now: Date = new Date()): JobRow[] {
    const nowIso = now.toISOString();
    return this.db.transaction(() => {
      const expired = this.db
        .prepare(
          `SELECT * FROM jobs
           WHERE status = 'running'
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= ?`,
        )
        .all(nowIso) as JobRow[];

      const recovered: JobRow[] = [];
      for (const job of expired) {
        const stageAttempts = parseJsonObject(job.stage_attempts_json);
        const currentAttempt =
          typeof stageAttempts[job.stage] === 'number' ? (stageAttempts[job.stage] as number) : 0;
        stageAttempts[job.stage] = currentAttempt + 1;
        const attemptsJson = JSON.stringify(stageAttempts);

        const isFinalization = job.failed_stage !== null;
        const exhausted = job.attempts >= job.max_attempts;

        let message: string;
        if (isFinalization || !exhausted) {
          if (isFinalization) {
            this.db
              .prepare(
                `UPDATE jobs
                 SET status = 'queued',
                     stage_attempts_json = ?,
                     next_attempt_at = ?,
                     lease_owner = NULL,
                     lease_expires_at = NULL,
                     heartbeat_at = NULL,
                     updated_at = ?
                 WHERE id = ?`,
              )
              .run(attemptsJson, nowIso, nowIso, job.id);
            message = 'Lease expired; finalization requeued';
          } else {
            this.db
              .prepare(
                `UPDATE jobs
                 SET status = 'queued',
                     stage_attempts_json = ?,
                     next_attempt_at = ?,
                     lease_owner = NULL,
                     lease_expires_at = NULL,
                     heartbeat_at = NULL,
                     error_code = 'lease_expired',
                     error_message = 'Lease expired; job requeued',
                     updated_at = ?
                 WHERE id = ?`,
              )
              .run(attemptsJson, nowIso, nowIso, job.id);
            message = 'Lease expired; requeued';
          }
        } else {
          this.applyFinalization(
            job,
            {
              failedStage: job.stage,
              errorCode: 'lease_expired',
              errorMessage: 'Lease expired and attempts were exhausted',
            },
            nowIso,
          );
          this.db
            .prepare('UPDATE jobs SET stage_attempts_json = ? WHERE id = ?')
            .run(attemptsJson, job.id);
          message = 'Lease expired; finalization staged';
        }

        insertJobEvent(this.db, {
          jobId: job.id,
          event: 'lease_expired',
          level: 'warn',
          stage: job.stage,
          message,
          at: nowIso,
        });

        const updated = this.getById(job.id);
        if (updated) recovered.push(updated);
      }

      return recovered;
    })();
  }

  /** Storage keys still referenced by a queued or running job. */
  activeStorageKeys(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT storage_key FROM jobs
         WHERE storage_key IS NOT NULL AND status IN ('queued','running')`,
      )
      .all() as { storage_key: string }[];
    return new Set(rows.map((row) => row.storage_key));
  }

  countActiveByStorageKey(storageKey: string, excludeJobId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM jobs
         WHERE storage_key = ? AND id <> ? AND status IN ('queued','running')`,
      )
      .get(storageKey, excludeJobId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  countQueued(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'queued'")
      .get() as { count: number } | undefined;
    return row?.count ?? 0;
  }
  countsByStatus(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status')
      .all() as { status: string; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  countsByStage(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT stage, COUNT(*) AS count FROM jobs GROUP BY stage')
      .all() as { stage: string; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.stage, row.count]));
  }

  stats(): JobStats {
    const byStatus = this.countsByStatus();
    const byStage = this.countsByStage();
    const totalRow = this.db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as
      | { count: number }
      | undefined;
    const dedupRow = this.db
      .prepare('SELECT COUNT(*) AS count FROM jobs WHERE deduplicated = 1')
      .get() as { count: number } | undefined;
    return {
      total: totalRow?.count ?? 0,
      byStatus,
      byStage,
      deduplicated: dedupRow?.count ?? 0,
    };
  }

  listEvents(jobId: string, limit = 100): JobEventRow[] {
    return this.events.listForJob(jobId, limit);
  }

  appendEvent(input: Parameters<EventRepository['append']>[0]): number {
    return this.events.append(input);
  }

  private requireById(id: string): JobRow {
    const row = this.getById(id);
    if (!row) throw new Error(`Job ${id} was not found after write`);
    return row;
  }
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function selectOrder(order: JobListFilters['order']): string {
  switch (order) {
    case 'oldest':
      return 'created_at ASC';
    case 'longest':
      return 'COALESCE(processing_time_ms, 0) DESC';
    case 'attempts':
      return 'attempts DESC';
    case 'newest':
    default:
      return 'created_at DESC';
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function computeProcessingTime(job: JobRow, finishedAt: string): number {
  if (!job.started_at) return 0;
  const started = Date.parse(job.started_at);
  const finished = Date.parse(finishedAt);
  if (Number.isNaN(started) || Number.isNaN(finished)) return 0;
  return Math.max(0, finished - started);
}
