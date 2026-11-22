import fs from 'node:fs/promises';
import path from 'node:path';

import type Database from 'better-sqlite3';

import type { AppEnv } from '../config/env';
import type { Db } from '../db/database';
import { EventRepository } from '../db/events';
import type { JobEventRow } from '../db/events';
import { JobRepository } from '../db/jobs';
import type { JobRow } from '../db/jobs';
import { OutboxRepository } from '../db/outbox';
import type { HealthRegistry, HealthReport } from '../observability/health';
import type { PipelineRuntimeStatus } from '../pipeline/runtime';

export type DashboardServiceStatus = 'ok' | 'degraded' | 'down' | 'unknown';

export interface DashboardServiceOptions {
  db: Db;
  env: AppEnv;
  health: HealthRegistry;
  startedAt: number;
  version: string;
  healthCacheTtlMs?: number;
  pipelineStatus?: () => PipelineRuntimeStatus;
}

export interface DashboardServiceInfo {
  name: 'stash-host-node';
  version: string;
  environment: string;
  status: DashboardServiceStatus;
  startedAt: string;
  uptimeSeconds: number;
  nodeVersion: string;
}

export interface DashboardHealthComponent {
  component: string;
  status: string;
  latencyMs: number | null;
  message: string | null;
}

export interface DashboardHealth {
  status: string;
  checkedAt: string;
  components: DashboardHealthComponent[];
}

export interface DashboardJobs {
  total: number;
  uniqueFiles: number;
  deduplicated: number;
  byStatus: Record<string, number>;
  byStage: Record<string, number>;
  queued: number;
  running: number;
  staleLeases: number;
  oldestQueuedAt: string | null;
  failureRate: number;
  bytes: { declared: number; downloaded: number };
  processingMs: { avg: number | null; max: number | null };
}

export interface DashboardOutbox {
  pending: number;
  sending: number;
  sent: number;
  dead: number;
}

export interface DashboardStorage {
  freeBytes: number;
  totalBytes: number | null;
  libraryLabel: string;
}

export interface DashboardActivityBucket {
  bucket: string;
  completed: number;
  failed: number;
}

export interface DashboardFailure {
  code: string;
  count: number;
}

export interface DashboardRecentJob {
  id: string;
  fileName: string;
  status: string;
  stage: string;
  progress: number;
  fileSize: number;
  downloadedSize: number;
  attempts: number;
  processingTimeMs: number | null;
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface DashboardRecentEvent {
  id: number;
  jobId: string;
  at: string;
  level: string | null;
  stage: string | null;
  event: string;
  message: string | null;
}

export interface DashboardConfig {
  kafkaEnabled: boolean;
  kafkaBrokers: string[];
  s3Enabled: boolean;
  s3Bucket: string | null;
  s3Region: string;
  workerEnabled: boolean;
  workerConcurrency: number;
}

export interface DashboardPipeline {
  wired: boolean;
  note: string;
  kafka: {
    enabled: boolean;
    connected: boolean;
    running: boolean;
    paused: boolean;
    topic: string;
    groupId: string;
    lastMessageAt: string | null;
    lastError: string | null;
  };
  worker: {
    enabled: boolean;
    workers: number;
    running: number;
    queued: number;
    lastError: string | null;
  };
  outboxDispatch: {
    lastFlushAt: string | null;
    lastError: string | null;
  };
}

export interface DashboardSnapshot {
  service: DashboardServiceInfo;
  health: DashboardHealth;
  jobs: DashboardJobs;
  outbox: DashboardOutbox;
  storage: DashboardStorage;
  activity: DashboardActivityBucket[];
  failures: DashboardFailure[];
  recentJobs: DashboardRecentJob[];
  recentEvents: DashboardRecentEvent[];
  config: DashboardConfig;
  pipeline: DashboardPipeline;
}

const HOUR_MS = 3_600_000;
const ACTIVITY_BUCKET_COUNT = 24;
const RECENT_EVENT_MESSAGE_LIMIT = 200;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

const PIPELINE_NOTE = 'Background pipeline processing is not started by this server build.';
const DEFAULT_HEALTH_CACHE_TTL_MS = 10_000;

interface CountRow {
  count: number;
}

interface ByteTotalRow {
  declared: number;
  downloaded: number;
}

interface ProcessingTimeRow {
  avg: number | null;
  max: number | null;
}

interface OldestQueuedRow {
  oldest: string | null;
}

interface FailureRow {
  code: string;
  count: number;
}

interface ActivityRow {
  bucket: string | null;
  completed: number;
  failed: number;
}

export class DashboardService {
  private readonly db: Db;
  private readonly env: AppEnv;
  private readonly health: HealthRegistry;
  private readonly startedAt: number;
  private readonly version: string;
  private readonly healthCacheTtlMs: number;
  private readonly pipelineStatus: (() => PipelineRuntimeStatus) | undefined;
  private cachedHealth: HealthReport | null = null;
  private cachedHealthAt = 0;
  private readonly jobs: JobRepository;
  private readonly events: EventRepository;
  private readonly outbox: OutboxRepository;
  private readonly uniqueFilesStatement: Database.Statement;
  private readonly byteTotalsStatement: Database.Statement;
  private readonly staleLeasesStatement: Database.Statement;
  private readonly oldestQueuedStatement: Database.Statement;
  private readonly processingTimeStatement: Database.Statement;
  private readonly failuresStatement: Database.Statement;
  private readonly activityStatement: Database.Statement;

  constructor(options: DashboardServiceOptions) {
    this.db = options.db;
    this.env = options.env;
    this.health = options.health;
    this.startedAt = options.startedAt;
    this.version = options.version;
    this.healthCacheTtlMs = options.healthCacheTtlMs ?? DEFAULT_HEALTH_CACHE_TTL_MS;
    this.pipelineStatus = options.pipelineStatus;
    this.jobs = new JobRepository(this.db);
    this.events = new EventRepository(this.db);
    this.outbox = new OutboxRepository(this.db);

    this.uniqueFilesStatement = this.db.prepare(
      'SELECT COUNT(DISTINCT file_id) AS count FROM jobs',
    );
    this.byteTotalsStatement = this.db.prepare(
      `SELECT COALESCE(SUM(file_size), 0) AS declared,
              COALESCE(SUM(downloaded_size), 0) AS downloaded
       FROM jobs`,
    );
    this.staleLeasesStatement = this.db.prepare(
      `SELECT COUNT(*) AS count FROM jobs
       WHERE status = 'running'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= ?`,
    );
    this.oldestQueuedStatement = this.db.prepare(
      `SELECT MIN(created_at) AS oldest FROM jobs WHERE status = 'queued'`,
    );
    this.processingTimeStatement = this.db.prepare(
      `SELECT AVG(processing_time_ms) AS avg, MAX(processing_time_ms) AS max
       FROM jobs
       WHERE processing_time_ms IS NOT NULL`,
    );
    this.failuresStatement = this.db.prepare(
      `SELECT error_code AS code, COUNT(*) AS count
       FROM jobs
       WHERE status = 'failed' AND error_code IS NOT NULL
       GROUP BY error_code
       ORDER BY count DESC, code ASC
       LIMIT 5`,
    );
    this.activityStatement = this.db.prepare(
      `SELECT strftime('%Y-%m-%dT%H:00:00Z', finished_at) AS bucket,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM jobs
       WHERE status IN ('completed', 'failed')
         AND finished_at IS NOT NULL
         AND datetime(finished_at) >= datetime(?)
         AND datetime(finished_at) <= datetime(?)
       GROUP BY bucket`,
    );
  }

  async snapshot(): Promise<DashboardSnapshot> {
    const now = new Date();
    const nowIso = now.toISOString();
    const buckets = buildHourBuckets(now);
    const oldestBucket = buckets[0] ?? formatHourBucket(now);

    const stats = this.jobs.stats();
    const recentJobs = this.jobs.list({ limit: 8 }).items;
    const recentEvents = this.events.listRecent(10);
    const outbox = this.outbox.stats();

    const uniqueFilesRow = this.uniqueFilesStatement.get() as CountRow | undefined;
    const byteTotalsRow = this.byteTotalsStatement.get() as ByteTotalRow | undefined;
    const staleLeasesRow = this.staleLeasesStatement.get(nowIso) as CountRow | undefined;
    const oldestQueuedRow = this.oldestQueuedStatement.get() as OldestQueuedRow | undefined;
    const processingTimeRow = this.processingTimeStatement.get() as
      | ProcessingTimeRow
      | undefined;
    const failureRows = this.failuresStatement.all() as FailureRow[];
    const activityRows = this.activityStatement.all(oldestBucket, nowIso) as ActivityRow[];

    const activityByBucket = new Map<string, { completed: number; failed: number }>();
    for (const row of activityRows) {
      if (row.bucket === null) continue;
      activityByBucket.set(row.bucket, {
        completed: Number(row.completed),
        failed: Number(row.failed),
      });
    }

    const [healthReport, storage] = await Promise.all([
      this.getHealthReport(now),
      this.readStorage(),
    ]);

    const failed = stats.byStatus['failed'] ?? 0;
    const completed = stats.byStatus['completed'] ?? 0;
    const terminal = failed + completed;

    return {
      service: {
        name: 'stash-host-node',
        version: this.version,
        environment: this.env.NODE_ENV,
        status:
          healthReport.status === 'down'
            ? 'down'
            : healthReport.status === 'degraded'
              ? 'degraded'
              : 'ok',
        startedAt: toIsoString(this.startedAt),
        uptimeSeconds: uptimeSeconds(this.startedAt, now.getTime()),
        nodeVersion: process.version,
      },
      health: {
        status: healthReport.status,
        checkedAt: healthReport.checkedAt,
        components: healthReport.components.map((component) => ({
          component: component.component,
          status: component.status,
          latencyMs: component.latencyMs,
          message: component.message,
        })),
      },
      jobs: {
        total: stats.total,
        uniqueFiles: uniqueFilesRow?.count ?? 0,
        deduplicated: stats.deduplicated,
        byStatus: stats.byStatus,
        byStage: stats.byStage,
        queued: stats.byStatus['queued'] ?? 0,
        running: stats.byStatus['running'] ?? 0,
        staleLeases: staleLeasesRow?.count ?? 0,
        oldestQueuedAt: oldestQueuedRow?.oldest ?? null,
        failureRate: terminal === 0 ? 0 : failed / terminal,
        bytes: {
          declared: Number(byteTotalsRow?.declared ?? 0),
          downloaded: Number(byteTotalsRow?.downloaded ?? 0),
        },
        processingMs: {
          avg: processingTimeRow?.avg ?? null,
          max: processingTimeRow?.max ?? null,
        },
      },
      outbox: {
        pending: outbox.pending,
        sending: outbox.sending,
        sent: outbox.sent,
        dead: outbox.dead,
      },
      storage,
      activity: buckets.map((bucket) => {
        const counts = activityByBucket.get(bucket);
        return {
          bucket,
          completed: counts?.completed ?? 0,
          failed: counts?.failed ?? 0,
        };
      }),
      failures: failureRows.map((row) => ({ code: row.code, count: Number(row.count) })),
      recentJobs: recentJobs.map(toRecentJob),
      recentEvents: recentEvents.map(toRecentEvent),
      config: {
        kafkaEnabled: this.env.KAFKA_ENABLED,
        kafkaBrokers: [...this.env.KAFKA_BROKERS],
        s3Enabled: this.env.S3_ENABLED,
        s3Bucket: this.env.S3_BUCKET ?? null,
        s3Region: this.env.S3_REGION,
        workerEnabled: this.env.WORKER_ENABLED,
        workerConcurrency: this.env.WORKER_CONCURRENCY,
      },
      pipeline: this.buildPipelineStatus(),
    };
  }

  private buildPipelineStatus(): DashboardPipeline {
    const runtime = this.pipelineStatus?.();
    if (runtime) {
      return {
        wired: runtime.wired,
        note: runtime.wired ? '' : PIPELINE_NOTE,
        kafka: runtime.kafka,
        worker: runtime.worker,
        outboxDispatch: runtime.outboxDispatch,
      };
    }
    return {
      wired: false,
      note: PIPELINE_NOTE,
      kafka: {
        enabled: this.env.KAFKA_ENABLED,
        connected: false,
        running: false,
        paused: false,
        topic: this.env.KAFKA_REQUEST_TOPIC,
        groupId: this.env.KAFKA_GROUP_ID,
        lastMessageAt: null,
        lastError: null,
      },
      worker: {
        enabled: this.env.WORKER_ENABLED,
        workers: 0,
        running: 0,
        queued: 0,
        lastError: null,
      },
      outboxDispatch: {
        lastFlushAt: null,
        lastError: null,
      },
    };
  }

  private async getHealthReport(now: Date): Promise<HealthReport> {
    if (
      this.cachedHealth !== null &&
      now.getTime() < this.cachedHealthAt + this.healthCacheTtlMs
    ) {
      return this.cachedHealth;
    }
    const report = await this.health.checkAll();
    this.cachedHealth = report;
    this.cachedHealthAt = now.getTime();
    return report;
  }

  private async readStorage(): Promise<DashboardStorage> {
    const libraryLabel = resolveLibraryLabel(this.env.LOCAL_ROOT_PATH);
    try {
      const stats = await fs.statfs(this.env.LOCAL_ROOT_PATH);
      const blockSize = Number(stats.bsize);
      return {
        freeBytes: blockSize * Number(stats.bavail),
        totalBytes: blockSize * Number(stats.blocks),
        libraryLabel,
      };
    } catch {
      return { freeBytes: 0, totalBytes: null, libraryLabel };
    }
  }
}

function toRecentJob(row: JobRow): DashboardRecentJob {
  return {
    id: row.id,
    fileName: row.file_name ?? '',
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    fileSize: row.file_size ?? 0,
    downloadedSize: row.downloaded_size ?? 0,
    attempts: row.attempts,
    processingTimeMs: row.processing_time_ms,
    errorCode: row.error_code,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function toRecentEvent(row: JobEventRow): DashboardRecentEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    at: row.at,
    level: row.level,
    stage: row.stage,
    event: row.event,
    message: sanitizeMessage(row.message),
  };
}

function sanitizeMessage(message: string | null): string | null {
  if (message === null) return null;
  const cleaned = message.replace(CONTROL_CHARACTERS, '');
  return cleaned.length > RECENT_EVENT_MESSAGE_LIMIT
    ? cleaned.slice(0, RECENT_EVENT_MESSAGE_LIMIT)
    : cleaned;
}

function resolveLibraryLabel(localRootPath: string): string {
  const label = path.basename(localRootPath);
  return label.length > 0 ? label : 'Library';
}

function buildHourBuckets(now: Date): string[] {
  const currentHour = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  const buckets: string[] = [];
  for (let offset = ACTIVITY_BUCKET_COUNT - 1; offset >= 0; offset -= 1) {
    buckets.push(formatHourBucket(new Date(currentHour - offset * HOUR_MS)));
  }
  return buckets;
}

function formatHourBucket(date: Date): string {
  return `${date.toISOString().slice(0, 13)}:00:00Z`;
}

function toIsoString(epochMs: number): string {
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function uptimeSeconds(startedAt: number, now: number): number {
  const elapsed = now - startedAt;
  if (!Number.isFinite(elapsed)) return 0;
  return Math.max(0, Math.floor(elapsed / 1000));
}
