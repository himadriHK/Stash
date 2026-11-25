import fs from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { AppEnv } from '../../src/config/env';
import type { JobStatus, Stage } from '../../src/contracts/stages';
import { DashboardService } from '../../src/dashboard/dashboardService';
import { closeDatabase, openDatabase } from '../../src/db/database';
import { EventRepository } from '../../src/db/events';
import { JobRepository } from '../../src/db/jobs';
import { OutboxRepository } from '../../src/db/outbox';
import { createBasicHealthRegistry, HealthRegistry } from '../../src/observability/health';
import { createWorkspace } from '../helpers/env';

const VERSION = '9.9.9-test';
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const CREATED_BASE_MS = Date.parse('2020-01-01T00:00:00.000Z');

const workspace = createWorkspace();
const db = openDatabase(workspace.env.DB_PATH);
const jobs = new JobRepository(db);
const events = new EventRepository(db);
const outbox = new OutboxRepository(db);

function createdAt(minutes: number): string {
  return new Date(CREATED_BASE_MS + minutes * 60_000).toISOString();
}

function bucketFor(isoTimestamp: string): string {
  return `${new Date(isoTimestamp).toISOString().slice(0, 13)}:00:00Z`;
}

function createStubHealth(env: AppEnv): HealthRegistry {
  const health = new HealthRegistry();
  health.register('database', () => ({ status: 'ok', latencyMs: 1, message: null }));
  health.register('config', () => ({
    status: 'ok',
    latencyMs: 0,
    message: null,
    details: { tempDir: env.TEMP_DIR, jwtSigningKey: env.JWT_SIGNING_KEY },
  }));
  return health;
}

function createUnknownHealth(env: AppEnv): HealthRegistry {
  const health = createStubHealth(env);
  health.register('optional', () => ({
    status: 'unknown',
    latencyMs: null,
    message: 'Check unavailable',
  }));
  return health;
}

interface SeedJobOptions {
  id: string;
  createdAt: string;
  fileId: string;
  fileName?: string;
  downloadedSize?: number;
  status?: JobStatus;
  stage?: Stage;
  progress?: number;
  processingTimeMs?: number | null;
  errorCode?: string | null;
  finishedAt?: string | null;
  deduplicated?: boolean;
  leaseExpiresAt?: string | null;
}

function seedJob(options: SeedJobOptions): void {
  jobs.insert({
    id: options.id,
    correlationId: `correlation-${options.id}`,
    messageId: `message-${options.id}`,
    fileId: options.fileId,
    requestFileId: options.fileId,
    fileName: options.fileName ?? `${options.id}.jpg`,
    mimeType: 'image/jpeg',
    storageProvider: 'S3',
    storageTempPath: 'secret-storage-temp-path',
    storageKey: 'secret-storage-key',
    userId: 'user-secret-id',
    deviceId: 'device-secret-id',
    tempDir: 'secret-temp-dir',
    createdAt: options.createdAt,
  });
  jobs.updateFields(options.id, {
    status: options.status ?? 'queued',
    stage: options.stage ?? 'queued',
    progress: options.progress ?? 0,
    downloaded_size: options.downloadedSize ?? null,
    processing_time_ms: options.processingTimeMs ?? null,
    error_code: options.errorCode ?? null,
    finished_at: options.finishedAt ?? null,
    deduplicated: options.deduplicated ? 1 : 0,
    lease_expires_at: options.leaseExpiresAt ?? null,
  });
}

interface ScenarioTimes {
  hourAgo: string;
  twoHoursAgo: string;
  threeHoursAgo: string;
  leaseExpired: string;
}

function seedScenario(times: ScenarioTimes): void {
  seedJob({
    id: 'job-1',
    createdAt: createdAt(0),
    fileId: 'file-shared',
    downloadedSize: 1000,
    status: 'completed',
    stage: 'done',
    progress: 100,
    processingTimeMs: 5000,
    finishedAt: times.hourAgo,
    deduplicated: true,
  });
  seedJob({
    id: 'job-2',
    createdAt: createdAt(1),
    fileId: 'file-shared',
    downloadedSize: 500,
    status: 'failed',
    stage: 'done',
    progress: 100,
    processingTimeMs: 2000,
    errorCode: 'hash_mismatch',
    finishedAt: times.twoHoursAgo,
  });
  seedJob({
    id: 'job-3',
    createdAt: createdAt(2),
    fileId: 'file-b',
    downloadedSize: 2000,
    status: 'failed',
    stage: 'done',
    progress: 100,
    processingTimeMs: 3000,
    errorCode: 'hash_mismatch',
    finishedAt: times.twoHoursAgo,
  });
  seedJob({
    id: 'job-4',
    createdAt: createdAt(3),
    fileId: 'file-c',
    downloadedSize: 100,
    status: 'running',
    stage: 'download',
    progress: 20,
    leaseExpiresAt: times.leaseExpired,
  });
  seedJob({
    id: 'job-5',
    createdAt: createdAt(-1),
    fileId: 'file-d',
    status: 'queued',
    stage: 'queued',
  });
  seedJob({
    id: 'job-6',
    createdAt: createdAt(5),
    fileId: 'file-e',
    downloadedSize: 400,
    status: 'failed',
    stage: 'done',
    progress: 100,
    processingTimeMs: 1000,
    errorCode: 'timeout',
    finishedAt: times.threeHoursAgo,
  });
  seedJob({
    id: 'job-7',
    createdAt: createdAt(6),
    fileId: 'file-f',
    status: 'failed',
    stage: 'done',
    progress: 100,
    errorCode: 'timeout',
  });
  seedJob({
    id: 'job-8',
    createdAt: createdAt(7),
    fileId: 'file-g',
    status: 'failed',
    stage: 'done',
    progress: 100,
    errorCode: 's3_error',
  });
  seedJob({
    id: 'job-9',
    createdAt: createdAt(8),
    fileId: 'file-h',
    downloadedSize: 400,
    status: 'cancelled',
    stage: 'done',
    progress: 100,
  });
  seedJob({
    id: 'job-10',
    createdAt: createdAt(9),
    fileId: 'file-i',
    downloadedSize: 900,
    status: 'completed',
    stage: 'done',
    progress: 100,
    processingTimeMs: 4000,
    finishedAt: times.hourAgo,
  });
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

beforeEach(async () => {
  db.exec('DELETE FROM outbox; DELETE FROM job_events; DELETE FROM jobs;');
  await fs.rm(workspace.env.LOCAL_ROOT_PATH, { recursive: true, force: true });
});

afterAll(() => {
  closeDatabase(db);
  workspace.cleanup();
});

describe('DashboardService', () => {
  it('returns a JSON-safe zero-filled snapshot for an empty database', async () => {
    const startedAt = Date.now() - 5_000;
    const service = new DashboardService({
      db,
      env: workspace.env,
      health: createBasicHealthRegistry(db, workspace.env),
      startedAt,
      version: VERSION,
    });

    const snapshot = await service.snapshot();

    expect(Object.keys(snapshot).sort()).toEqual([
      'activity',
      'config',
      'failures',
      'health',
      'jobs',
      'outbox',
      'pipeline',
      'recentEvents',
      'recentJobs',
      'service',
      'storage',
    ]);

    expect(Object.keys(snapshot.service).sort()).toEqual([
      'environment',
      'name',
      'nodeVersion',
      'startedAt',
      'status',
      'uptimeSeconds',
      'version',
    ]);
    expect(snapshot.service).toMatchObject({
      name: 'stash-host-node',
      version: VERSION,
      environment: 'test',
      status: 'ok',
      startedAt: new Date(startedAt).toISOString(),
      nodeVersion: process.version,
    });
    expect(snapshot.service.uptimeSeconds).toBeGreaterThanOrEqual(5);

    expect(snapshot.health.status).toBe('ok');
    expect(snapshot.health.components.map((component) => component.component)).toEqual([
      'database',
      'temp_dir',
      'config',
    ]);
    for (const component of snapshot.health.components) {
      expect(Object.keys(component).sort()).toEqual([
        'component',
        'latencyMs',
        'message',
        'status',
      ]);
    }

    expect(snapshot.jobs).toMatchObject({
      total: 0,
      uniqueFiles: 0,
      deduplicated: 0,
      byStatus: {},
      byStage: {},
      queued: 0,
      running: 0,
      staleLeases: 0,
      oldestQueuedAt: null,
      failureRate: 0,
      bytes: { downloaded: 0 },
      processingMs: { avg: null, max: null },
    });

    expect(snapshot.outbox).toEqual({ pending: 0, sending: 0, sent: 0, dead: 0 });
    expect(snapshot.storage).toEqual({ freeBytes: 0, totalBytes: null, libraryLabel: 'library' });
    expect(snapshot.failures).toEqual([]);
    expect(snapshot.recentJobs).toEqual([]);
    expect(snapshot.recentEvents).toEqual([]);

    expect(Object.keys(snapshot.config).sort()).toEqual([
      'kafkaBrokers',
      'kafkaEnabled',
      's3Bucket',
      's3Enabled',
      's3Region',
      'workerConcurrency',
      'workerEnabled',
    ]);
    expect(snapshot.config).toEqual({
      kafkaEnabled: false,
      kafkaBrokers: [],
      s3Enabled: false,
      s3Bucket: null,
      s3Region: 'us-east-1',
      workerEnabled: true,
      workerConcurrency: 2,
    });

    expect(snapshot.pipeline).toEqual({
      wired: false,
      note: 'Background pipeline processing is not started by this server build.',
      kafka: {
        enabled: false,
        connected: false,
        running: false,
        paused: false,
        topic: 'stash.upload.request',
        groupId: 'stash-upload-request',
        lastMessageAt: null,
        lastError: null,
      },
      worker: {
        enabled: true,
        workers: 0,
        running: 0,
        queued: 0,
        lastError: null,
      },
      outboxDispatch: { lastFlushAt: null, lastError: null },
    });

    expect(snapshot.activity).toHaveLength(24);
    for (let index = 0; index < snapshot.activity.length; index += 1) {
      const bucket = snapshot.activity[index];
      expect(bucket?.bucket).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/);
      expect(bucket?.completed).toBe(0);
      expect(bucket?.failed).toBe(0);
      if (index > 0) {
        const previous = snapshot.activity[index - 1];
        expect(Date.parse(bucket?.bucket ?? '') - Date.parse(previous?.bucket ?? '')).toBe(
          3_600_000,
        );
      }
    }

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(workspace.root);
    expect(serialized).not.toContain(workspace.env.DB_PATH);
    expect(serialized).not.toContain(workspace.env.TEMP_DIR);
    expect(serialized).not.toContain(workspace.env.LOCAL_ROOT_PATH);
    expect(serialized).not.toContain(workspace.env.JWT_SIGNING_KEY);
    expect(serialized).not.toContain('"details"');
  });

  it('aggregates jobs, outbox, activity, failures, and recent rows', async () => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const times: ScenarioTimes = {
      hourAgo: new Date(now - 3_600_000).toISOString(),
      twoHoursAgo: new Date(now - 7_200_000).toISOString(),
      threeHoursAgo: new Date(now - 10_800_000).toISOString(),
      leaseExpired: new Date(now - 60_000).toISOString(),
    };
    seedScenario(times);

    const pending = outbox.enqueue({
      jobId: 'job-1',
      topic: workspace.env.KAFKA_RESPONSE_TOPIC,
      key: 'file-shared',
      payload: '{"status":"COMPLETED"}',
      nextAttemptAt: nowIso,
      createdAt: nowIso,
    });
    const sending = outbox.enqueue({
      jobId: 'job-2',
      topic: workspace.env.KAFKA_RESPONSE_TOPIC,
      key: 'file-shared',
      payload: '{"status":"FAILED"}',
      nextAttemptAt: nowIso,
      createdAt: nowIso,
    });
    outbox.claimById(sending.row.id, new Date(now));
    const sent = outbox.enqueue({
      jobId: 'job-3',
      topic: workspace.env.KAFKA_RESPONSE_TOPIC,
      key: 'file-b',
      payload: '{"status":"FAILED"}',
      nextAttemptAt: nowIso,
      createdAt: nowIso,
    });
    outbox.markSent(sent.row.id, new Date(now));
    const dead = outbox.enqueue({
      jobId: 'job-4',
      topic: workspace.env.KAFKA_RESPONSE_TOPIC,
      key: 'file-c',
      payload: '{"status":"FAILED"}',
      nextAttemptAt: nowIso,
      createdAt: nowIso,
    });
    outbox.markDead(dead.row.id, 'permanent failure');

    expect(pending.created).toBe(true);

    for (let index = 1; index <= 12; index += 1) {
      events.append({
        jobId: 'job-1',
        event: `ev-${index}`,
        level: 'info',
        stage: 'download',
        message:
          index === 12
            ? `start\nline\u0000${'y'.repeat(300)}`
            : `message-${index}`,
        at: createdAt(index),
      });
    }

    const service = new DashboardService({
      db,
      env: workspace.env,
      health: createBasicHealthRegistry(db, workspace.env),
      startedAt: now - 10_000,
      version: VERSION,
    });

    const snapshot = await service.snapshot();

    expect(snapshot.service.status).toBe('ok');
    expect(snapshot.health.status).toBe('ok');
    expect(snapshot.health.components.map((component) => component.component)).toEqual([
      'database',
      'temp_dir',
      'config',
    ]);
    for (const component of snapshot.health.components) {
      expect(component).not.toHaveProperty('details');
    }
    expect(snapshot.health.components.find((entry) => entry.component === 'database')?.status).toBe(
      'ok',
    );

    expect(snapshot.jobs.total).toBe(10);
    expect(snapshot.jobs.uniqueFiles).toBe(9);
    expect(snapshot.jobs.deduplicated).toBe(1);
    expect(snapshot.jobs.byStatus).toEqual({
      completed: 2,
      failed: 5,
      running: 1,
      queued: 1,
      cancelled: 1,
    });
    expect(snapshot.jobs.byStage).toEqual({ done: 8, download: 1, queued: 1 });
    expect(snapshot.jobs.queued).toBe(1);
    expect(snapshot.jobs.running).toBe(1);
    expect(snapshot.jobs.staleLeases).toBe(1);
    expect(snapshot.jobs.oldestQueuedAt).toBe(createdAt(-1));
    expect(snapshot.jobs.failureRate).toBeCloseTo(5 / 7, 10);
    expect(snapshot.jobs.bytes).toEqual({ downloaded: 5300 });
    expect(snapshot.jobs.processingMs.avg).toBeCloseTo(3000, 10);
    expect(snapshot.jobs.processingMs.max).toBe(5000);

    expect(snapshot.outbox).toEqual({ pending: 1, sending: 1, sent: 1, dead: 1 });

    expect(snapshot.activity).toHaveLength(24);
    expect(
      snapshot.activity.reduce((total, bucket) => total + bucket.completed, 0),
    ).toBe(2);
    expect(snapshot.activity.reduce((total, bucket) => total + bucket.failed, 0)).toBe(3);
    expect(
      snapshot.activity.find((bucket) => bucket.bucket === bucketFor(times.hourAgo))?.completed,
    ).toBe(2);
    expect(
      snapshot.activity.find((bucket) => bucket.bucket === bucketFor(times.twoHoursAgo))?.failed,
    ).toBe(2);
    expect(
      snapshot.activity.find((bucket) => bucket.bucket === bucketFor(times.threeHoursAgo))?.failed,
    ).toBe(1);

    expect(snapshot.failures).toEqual([
      { code: 'hash_mismatch', count: 2 },
      { code: 'timeout', count: 2 },
      { code: 's3_error', count: 1 },
    ]);

    expect(snapshot.recentJobs.map((job) => job.id)).toEqual([
      'job-10',
      'job-9',
      'job-8',
      'job-7',
      'job-6',
      'job-4',
      'job-3',
      'job-2',
    ]);
    expect(snapshot.recentJobs[0]).toEqual({
      id: 'job-10',
      fileName: 'job-10.jpg',
      status: 'completed',
      stage: 'done',
      progress: 100,
      downloadedSize: 900,
      attempts: 0,
      processingTimeMs: 4000,
      errorCode: null,
      createdAt: createdAt(9),
      finishedAt: times.hourAgo,
    });
    const failedJob = snapshot.recentJobs.find((job) => job.id === 'job-2');
    expect(failedJob).toMatchObject({
      status: 'failed',
      processingTimeMs: 2000,
      errorCode: 'hash_mismatch',
      downloadedSize: 500,
      finishedAt: times.twoHoursAgo,
    });

    expect(snapshot.recentEvents).toHaveLength(10);
    expect(snapshot.recentEvents[0]?.event).toBe('ev-12');
    expect(snapshot.recentEvents[0]?.jobId).toBe('job-1');
    expect(snapshot.recentEvents[0]?.message).toHaveLength(200);
    expect(snapshot.recentEvents[0]?.message?.startsWith('start')).toBe(true);
    expect(snapshot.recentEvents[0]?.message).not.toMatch(CONTROL_CHARACTER_PATTERN);
    expect(snapshot.recentEvents[snapshot.recentEvents.length - 1]?.event).toBe('ev-3');

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(workspace.root);
    expect(serialized).not.toContain(workspace.env.TEMP_DIR);
    expect(serialized).not.toContain(workspace.env.DB_PATH);
    expect(serialized).not.toContain(workspace.env.JWT_SIGNING_KEY);
    expect(serialized).not.toContain('"details"');
  });

  it('never exposes secrets, storage paths, identifiers, or health details', async () => {
    seedJob({
      id: 'secret-job',
      createdAt: createdAt(0),
      fileId: 'secret-file-id',
      downloadedSize: 42,
      status: 'completed',
      stage: 'done',
      progress: 100,
      processingTimeMs: 10,
      finishedAt: new Date().toISOString(),
    });
    events.append({
      jobId: 'secret-job',
      event: 'job_completed',
      level: 'info',
      stage: 'done',
      message: 'processed successfully',
      at: new Date().toISOString(),
    });
    outbox.enqueue({
      jobId: 'secret-job',
      topic: workspace.env.KAFKA_RESPONSE_TOPIC,
      key: 'secret-file-id',
      payload: JSON.stringify({ token: 'outbox-secret-token' }),
      nextAttemptAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const service = new DashboardService({
      db,
      env: workspace.env,
      health: createStubHealth(workspace.env),
      startedAt: Date.now(),
      version: VERSION,
    });

    const snapshot = await service.snapshot();
    const serialized = JSON.stringify(snapshot);
    const keys = collectKeys(snapshot);

    for (const key of [
      'temp_dir',
      'tempDir',
      'storage_key',
      'storageKey',
      'storage_temp_path',
      'storageTempPath',
      'user_id',
      'userId',
      'device_id',
      'deviceId',
      'permanent_path',
      'permanentPath',
      'details',
      'details_json',
      'headers_json',
      'payload',
    ]) {
      expect(keys.has(key)).toBe(false);
    }

    for (const value of [
      path.basename(workspace.root),
      workspace.env.TEMP_DIR,
      workspace.env.DB_PATH,
      workspace.env.JWT_SIGNING_KEY,
      'secret-storage-key',
      'secret-storage-temp-path',
      'user-secret-id',
      'device-secret-id',
      'secret-temp-dir',
      'outbox-secret-token',
    ]) {
      expect(serialized).not.toContain(value);
    }

    expect(snapshot.health.components).toHaveLength(2);
    for (const component of snapshot.health.components) {
      expect(component).not.toHaveProperty('details');
    }
    expect(Object.keys(snapshot.recentJobs[0] ?? {}).sort()).toEqual([
      'attempts',
      'createdAt',
      'downloadedSize',
      'errorCode',
      'fileName',
      'finishedAt',
      'id',
      'processingTimeMs',
      'progress',
      'stage',
      'status',
    ]);
    expect(Object.keys(snapshot.recentEvents[0] ?? {}).sort()).toEqual([
      'at',
      'event',
      'id',
      'jobId',
      'level',
      'message',
      'stage',
    ]);
  });

  it('keeps the service ok when a health component is unknown', async () => {
    const service = new DashboardService({
      db,
      env: workspace.env,
      health: createUnknownHealth(workspace.env),
      startedAt: Date.now(),
      version: VERSION,
    });

    const snapshot = await service.snapshot();

    expect(snapshot.service.status).toBe('ok');
    expect(snapshot.health.status).toBe('unknown');
    expect(snapshot.health.components.map((component) => component.component)).toEqual([
      'database',
      'config',
      'optional',
    ]);
  });

  it('caps failures at the top five error codes', async () => {
    const codes: string[] = [
      'hash_mismatch',
      'hash_mismatch',
      'hash_mismatch',
      'lease_expired',
      'lease_expired',
      'lease_expired',
      'timeout',
      'timeout',
      's3_error',
      's3_error',
      'disk_full',
      'permission_denied',
    ];

    codes.forEach((code, index) => {
      seedJob({
        id: `fail-${index}`,
        createdAt: createdAt(index),
        fileId: `fail-file-${index}`,
        status: 'failed',
        stage: 'done',
        progress: 100,
        processingTimeMs: 100,
        errorCode: code,
      });
    });

    const service = new DashboardService({
      db,
      env: workspace.env,
      health: createStubHealth(workspace.env),
      startedAt: Date.now(),
      version: VERSION,
    });

    const snapshot = await service.snapshot();

    expect(snapshot.failures).toEqual([
      { code: 'hash_mismatch', count: 3 },
      { code: 'lease_expired', count: 3 },
      { code: 's3_error', count: 2 },
      { code: 'timeout', count: 2 },
      { code: 'disk_full', count: 1 },
    ]);
  });
});
