import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { UploadResponseV1 } from '../../src/contracts/response';
import { closeDatabase, openDatabase } from '../../src/db/database';
import { JobRepository } from '../../src/db/jobs';
import { OutboxRepository } from '../../src/db/outbox';
import type { OutboxPublisher } from '../../src/kafka/outboxDispatcher';
import { OutboxDispatcher } from '../../src/kafka/outboxDispatcher';
import type { OutboxDispatcherOptions } from '../../src/kafka/outboxDispatcher';
import { hashFileStreaming } from '../../src/media/hash';
import type { HashFile } from '../../src/pipeline/runner';
import { PipelineRunner } from '../../src/pipeline/runner';
import { LocalLibrary } from '../../src/storage/local';
import { FakeS3Storage } from '../fakes/fakeS3';
import { createWorkspace } from '../helpers/env';

const workspace = createWorkspace({
  RETRY_BASE_MS: '100',
  RETRY_MAX_MS: '200',
});
const db = openDatabase(workspace.env.DB_PATH);
const jobs = new JobRepository(db);
const outbox = new OutboxRepository(db);
const local = new LocalLibrary(workspace.env);
const fakeS3 = new FakeS3Storage();

const testHashFile: HashFile = (target, onProgress, signal) =>
  hashFileStreaming(target, (bytes) => onProgress?.(bytes, 0), signal);

class FakePublisher implements OutboxPublisher {
  readonly messages: Array<{
    topic: string;
    key: string;
    value: string;
    headers?: Record<string, string | Buffer | undefined>;
  }> = [];
  alwaysFail = false;

  async publish(
    topic: string,
    key: string,
    value: string | Buffer,
    headers?: Record<string, string | Buffer | undefined>,
  ): Promise<unknown> {
    if (this.alwaysFail) throw new Error('publisher unavailable');
    this.messages.push({
      topic,
      key,
      value: typeof value === 'string' ? value : value.toString('utf8'),
      headers,
    });
    return { topic, partition: 0, offset: String(this.messages.length) };
  }
}

let correlationCounter = 0;

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function createImage(
  format: 'jpeg' | 'png',
  width = 320,
  height = 240,
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 180, g: 60, b: 120, alpha: 1 },
    },
  })
    .toFormat(format)
    .toBuffer();
}

interface CreateJobOptions {
  fileId?: string;
  fileName?: string;
  mimeType?: string;
  maxAttempts?: number;
}

function createJob(buffer: Buffer, options: CreateJobOptions = {}) {
  correlationCounter += 1;
  const id = randomUUID();
  const fileId = options.fileId ?? sha256(buffer);
  const fileName = options.fileName ?? 'photo.jpg';
  const mimeType = options.mimeType ?? 'image/jpeg';
  const storageKey = `stash/temp/uploads/user-1/${fileId}/${fileName}`;

  const job = jobs.insert({
    id,
    correlationId: `correlation-${correlationCounter}`,
    messageId: `message-${correlationCounter}`,
    fileId,
    requestFileId: fileId,
    fileName,
    fileSize: buffer.length,
    mimeType,
    storageProvider: 'S3',
    storageTempPath: `/temp/uploads/user-1/${fileId}/${fileName}`,
    storageKey,
    userId: 'user-1',
    deviceId: 'device-1',
    maxAttempts: options.maxAttempts ?? workspace.env.JOB_MAX_ATTEMPTS,
    tempDir: path.join(workspace.env.TEMP_DIR, 'jobs', id),
  });

  fakeS3.put(storageKey, buffer, mimeType);
  return { job, fileId, storageKey };
}

async function runQueued(
  publisher: OutboxPublisher,
  options: OutboxDispatcherOptions = {},
) {
  const dispatcher = new OutboxDispatcher(outbox, publisher, {
    maxAttempts: 4,
    retryBaseMs: 10,
    retryMaxMs: 50,
    ...options,
  });
  const runner = new PipelineRunner({
    env: workspace.env,
    jobs,
    outbox,
    outboxDispatcher: dispatcher,
    storage: fakeS3,
    local,
    hashFile: testHashFile,
  });

  const claimed = jobs.claimNextJob('worker-test', workspace.env.LEASE_SECONDS);
  if (!claimed) throw new Error('Expected a claimable job');
  await runner.runJob(claimed, 'worker-test');
  return { job: jobs.getById(claimed.id), runner, dispatcher };
}

function parseResponsePayload(payload: string): UploadResponseV1 {
  return JSON.parse(payload) as UploadResponseV1;
}

beforeEach(async () => {
  db.exec('DELETE FROM outbox; DELETE FROM job_events; DELETE FROM jobs;');
  await fs.rm(workspace.env.LOCAL_ROOT_PATH, { recursive: true, force: true });
  await fs.rm(workspace.env.TEMP_DIR, { recursive: true, force: true });
  await local.ensureReady();
  fakeS3.reset();
});

afterAll(() => {
  closeDatabase(db);
  workspace.cleanup();
});

describe('pipeline runner', () => {
  it('processes a JPEG end to end and publishes a COMPLETED response before deleting S3', async () => {
    const buffer = await createImage('jpeg');
    const { job, fileId, storageKey } = createJob(buffer);
    const publisher = new FakePublisher();

    const { job: final } = await runQueued(publisher);

    expect(final?.status).toBe('completed');
    expect(final?.stage).toBe('done');
    expect(final?.progress).toBe(100);
    expect(final?.permanent_path).toBe(`/backups/user-1/${fileId}.jpg`);
    expect(final?.deduplicated).toBe(0);
    expect(final?.converted_format).toBe('image/jpeg');

    const permanentAbsolute = local.absolute(final?.permanent_path ?? '');
    await expect(fs.stat(permanentAbsolute)).resolves.toBeTruthy();
    const permanentBytes = await fs.readFile(permanentAbsolute);
    expect(sha256(permanentBytes)).toBe(fileId);
    await expect(sharp(permanentAbsolute).metadata()).resolves.toMatchObject({ format: 'jpeg' });

    const thumbnails = JSON.parse(final?.thumbnails_json ?? '{}') as Record<string, string>;
    expect(Object.keys(thumbnails).sort()).toEqual(['128', '256', '512']);
    for (const size of [128, 256, 512]) {
      const logical = thumbnails[String(size)];
      expect(logical).toBe(`/thumbs/user-1/${size}/${fileId}.jpg`);
      const metadata = await sharp(local.absolute(logical ?? '')).metadata();
      expect(metadata.format).toBe('jpeg');
      expect(metadata.width).toBe(size);
      expect(metadata.height).toBe(size);
    }

    const outboxRow = outbox.getByJobAndKind(job.id, 'response');
    expect(outboxRow?.status).toBe('sent');
    const payload = parseResponsePayload(outboxRow?.payload ?? '{}');
    expect(payload).toMatchObject({
      status: 'COMPLETED',
      fileId,
      version: 1,
      convertedFormat: 'image/jpeg',
      deduplicated: false,
      error: null,
      deviceId: 'device-1',
      userId: 'user-1',
      correlationId: job.correlation_id,
      permanentPath: `/backups/user-1/${fileId}.jpg`,
    });
    expect(payload.processingTimeMs).toBeGreaterThanOrEqual(0);
    expect(payload.thumbnails['128']).toBe(`/thumbs/user-1/128/${fileId}.jpg`);

    expect(publisher.messages).toHaveLength(1);
    expect(publisher.messages[0]?.key).toBe(fileId);
    expect(publisher.messages[0]?.topic).toBe(workspace.env.KAFKA_RESPONSE_TOPIC);
    expect(publisher.messages[0]?.headers).toMatchObject({
      'X-Message-Version': '1',
      'X-Correlation-Id': job.correlation_id,
      'X-Device-Id': 'device-1',
      'X-User-Id': 'user-1',
    });

    expect(fakeS3.deleted).toContain(storageKey);
  });

  it('converts PNG source to a JPEG permanent file with thumbnails', async () => {
    const buffer = await createImage('png');
    const { job, fileId } = createJob(buffer, {
      fileName: 'photo.png',
      mimeType: 'image/png',
    });
    const publisher = new FakePublisher();

    const { job: final } = await runQueued(publisher);

    expect(final?.status).toBe('completed');
    expect(final?.permanent_path).toBe(`/backups/user-1/${fileId}.jpg`);
    expect(final?.converted_format).toBe('image/jpeg');

    const metadata = await sharp(local.absolute(final?.permanent_path ?? '')).metadata();
    expect(metadata.format).toBe('jpeg');

    const payload = parseResponsePayload(
      outbox.getByJobAndKind(job.id, 'response')?.payload ?? '{}',
    );
    expect(payload.status).toBe('COMPLETED');
    expect(payload.convertedFormat).toBe('image/jpeg');
    expect(Object.keys(payload.thumbnails).sort()).toEqual(['128', '256', '512']);
  });

  it('uses an existing permanent/thumbnail set on a dedup hit without overwriting it', async () => {
    const buffer = await createImage('jpeg');
    const { job, fileId, storageKey } = createJob(buffer);

    const permanent = local.permanentLogical('user-1', fileId, '.jpg');
    await local.atomicWriteFile(buffer, permanent);
    for (const size of [128, 256, 512]) {
      const thumb = await sharp(buffer)
        .resize(size, size, { fit: 'cover' })
        .jpeg()
        .toBuffer();
      await local.atomicWriteFile(thumb, local.thumbnailLogical('user-1', fileId, size));
    }

    const before = await fs.stat(local.absolute(permanent));
    await new Promise((resolve) => setTimeout(resolve, 25));

    const publisher = new FakePublisher();
    const { job: final } = await runQueued(publisher);
    const after = await fs.stat(local.absolute(permanent));

    expect(final?.status).toBe('completed');
    expect(final?.deduplicated).toBe(1);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(fakeS3.deleted).toContain(storageKey);

    const payload = parseResponsePayload(
      outbox.getByJobAndKind(job.id, 'response')?.payload ?? '{}',
    );
    expect(payload.status).toBe('COMPLETED');
    expect(payload.deduplicated).toBe(true);
    expect(Object.keys(payload.thumbnails)).toHaveLength(3);
  });

  it('fails a hash mismatch, publishes FAILED, then deletes S3', async () => {
    const buffer = await createImage('jpeg');
    const wrongFileId = 'b'.repeat(64);
    const { job, storageKey } = createJob(buffer, { fileId: wrongFileId });
    const publisher = new FakePublisher();

    const { job: final } = await runQueued(publisher);

    expect(final?.status).toBe('failed');
    expect(final?.stage).toBe('done');
    expect(final?.failed_stage).toBe('verify');
    expect(final?.error_code).toBe('hash_mismatch');
    expect(final?.permanent_path).toBeNull();

    const payload = parseResponsePayload(
      outbox.getByJobAndKind(job.id, 'response')?.payload ?? '{}',
    );
    expect(payload.status).toBe('FAILED');
    expect(payload.permanentPath).toBeNull();
    expect(payload.error).toMatch(/hash mismatch/i);
    expect(payload.version).toBe(1);
    expect(fakeS3.deleted).toContain(storageKey);

    await expect(
      local.exists(local.permanentLogical('user-1', wrongFileId, '.jpg')),
    ).resolves.toBe(false);
  });

  it('keeps S3 staging when the response outbox row is dead', async () => {
    const buffer = await createImage('jpeg');
    const { job, storageKey } = createJob(buffer);
    const publisher = new FakePublisher();
    publisher.alwaysFail = true;

    const { job: final } = await runQueued(publisher, { maxAttempts: 1 });

    expect(final?.status).toBe('failed');
    expect(final?.stage).toBe('done');
    expect(final?.error_code).toBe('response_publish_failed');
    expect(outbox.getByJobAndKind(job.id, 'response')?.status).toBe('dead');
    expect(publisher.messages).toHaveLength(0);
    expect(fakeS3.deleted).not.toContain(storageKey);
    await expect(fs.stat(local.absolute(final?.permanent_path ?? ''))).resolves.toBeTruthy();
  });

  it('requeues an expired lease while attempts remain', async () => {
    const buffer = await createImage('jpeg');
    const { job } = createJob(buffer, { maxAttempts: 4 });
    const now = new Date('2026-11-21T00:00:00.000Z');
    const claimed = jobs.claimNextJob('worker-lease', 60, now);
    expect(claimed?.id).toBe(job.id);

    const recovered = jobs.recoverExpiredLeases(new Date(now.getTime() + 61_000));

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      status: 'queued',
      stage: 'download',
      error_code: 'lease_expired',
      failed_stage: null,
    });
  });

  it('stages finalization for an expired lease with exhausted attempts', async () => {
    const buffer = await createImage('jpeg');
    const { job, storageKey } = createJob(buffer, { maxAttempts: 1 });
    const now = new Date('2026-11-21T00:00:00.000Z');
    const claimed = jobs.claimNextJob('worker-lease', 60, now);
    expect(claimed?.id).toBe(job.id);

    const recovered = jobs.recoverExpiredLeases(new Date(now.getTime() + 61_000));

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      status: 'queued',
      stage: 'respond',
      failed_stage: 'download',
      error_code: 'lease_expired',
      finished_at: null,
    });

    const publisher = new FakePublisher();
    const { job: final } = await runQueued(publisher, { maxAttempts: 2 });

    expect(final?.status).toBe('failed');
    expect(final?.error_code).toBe('lease_expired');
    expect(fakeS3.deleted).toContain(storageKey);
  });

  it('enqueues one outbox row per job/kind and flushes idempotently', async () => {
    const buffer = await createImage('jpeg');
    const { job, fileId } = createJob(buffer);
    const now = new Date().toISOString();

    const first = outbox.enqueue({
      jobId: job.id,
      topic: workspace.env.KAFKA_RESPONSE_TOPIC,
      key: fileId,
      payload: '{"status":"COMPLETED"}',
      headers: { 'X-Message-Version': '1' },
      nextAttemptAt: now,
      createdAt: now,
    });
    const second = outbox.enqueue({
      jobId: job.id,
      topic: workspace.env.KAFKA_RESPONSE_TOPIC,
      key: fileId,
      payload: '{"status":"FAILED"}',
      nextAttemptAt: now,
      createdAt: now,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(outbox.stats().pending).toBe(1);

    const publisher = new FakePublisher();
    const dispatcher = new OutboxDispatcher(outbox, publisher, { maxAttempts: 3 });

    await expect(dispatcher.flushJob(job.id)).resolves.toBe('sent');
    await expect(dispatcher.flushJob(job.id)).resolves.toBe('sent');
    expect(publisher.messages).toHaveLength(1);
    expect(outbox.getByJobAndKind(job.id, 'response')?.status).toBe('sent');
  });

  it.skip('converts MOV to MP4 (not exercised: no ffmpeg fixture in this environment)', () => {
    // Intentionally skipped. FFmpeg availability is not guaranteed here.
  });
});
