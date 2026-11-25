import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase } from '../../src/db/database';
import { JobRepository } from '../../src/db/jobs';
import { OutboxRepository, outboxHeaders } from '../../src/db/outbox';
import { createWorkspace } from '../helpers/env';

const workspace = createWorkspace();
const db = openDatabase(workspace.env.DB_PATH);
const jobs = new JobRepository(db);
const outbox = new OutboxRepository(db);
const now = new Date('2026-11-21T00:00:00.000Z');

afterAll(() => {
  closeDatabase(db);
  workspace.cleanup();
});

function insertJob(id = 'job-1', correlationId = 'correlation-1') {
  return jobs.insert({
    id,
    correlationId,
    messageId: 'message-1',
    fileId: 'a'.repeat(64),
    requestFileId: 'a'.repeat(64),
    fileName: 'photo.heic',
    mimeType: 'image/heic',
    storageProvider: 'S3',
    storageTempPath: `/temp/uploads/device-1/${'a'.repeat(64)}/photo.heic`,
    storageKey: `stash/temp/uploads/device-1/${'a'.repeat(64)}/photo.heic`,
    userId: 'user-1',
    deviceId: 'device-1',
  });
}

describe('JobRepository', () => {
  it('inserts a job and deduplicates by correlation id', () => {
    const first = insertJob('job-1', 'correlation-1');
    expect(first.status).toBe('queued');
    expect(first.stage).toBe('queued');
    expect(first.storage_key).toBe(`stash/temp/uploads/device-1/${'a'.repeat(64)}/photo.heic`);

    const duplicate = jobs.insertIfNew({
      id: 'job-2',
      correlationId: 'correlation-1',
      messageId: 'message-2',
      fileId: 'a'.repeat(64),
      requestFileId: 'a'.repeat(64),
      fileName: 'photo.heic',
      mimeType: 'image/heic',
      storageProvider: 'S3',
      storageTempPath: `/temp/uploads/device-1/${'a'.repeat(64)}/photo.heic`,
      storageKey: `stash/temp/uploads/device-1/${'a'.repeat(64)}/photo.heic`,
      userId: 'user-1',
      deviceId: 'device-1',
    });

    expect(duplicate.created).toBe(false);
    expect(duplicate.job.id).toBe('job-1');
    expect(jobs.list().total).toBe(1);
  });

  it('lists, paginates and counts jobs', () => {
    insertJob('job-3', 'correlation-3');
    const page = jobs.list({ limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.limit).toBe(1);
    expect(page.total).toBe(2);
    const stats = jobs.stats();
    expect(stats.total).toBe(2);
    expect(stats.byStatus['queued']).toBe(2);
    expect(stats.byStage['queued']).toBe(2);
  });

  it('claims a queued job, heartbeats and recovers expired leases', () => {
    const claimed = jobs.claimNextJob('worker-1', 120, now);
    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe('running');
    expect(claimed?.lease_owner).toBe('worker-1');
    expect(claimed?.attempts).toBe(1);

    const heartbeat = jobs.heartbeat(claimed?.id ?? '', 'worker-1', 120, now);
    expect(heartbeat).toBe(true);

    const expiredAt = new Date(now.getTime() + 121_000);
    const recovered = jobs.recoverExpiredLeases(expiredAt);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe('queued');
    expect(recovered[0]?.error_code).toBe('lease_expired');
  });
});

describe('OutboxRepository', () => {
  it('enqueues exactly one row per job and kind', () => {
    insertJob('job-outbox', 'correlation-outbox');

    const first = outbox.enqueue({
      jobId: 'job-outbox',
      topic: 'stash.upload.response',
      key: 'a'.repeat(64),
      payload: '{"status":"COMPLETED"}',
      headers: { 'X-Message-Version': '1' },
      nextAttemptAt: now.toISOString(),
      createdAt: now.toISOString(),
    });
    expect(first.created).toBe(true);

    const second = outbox.enqueue({
      id: 'different-id',
      jobId: 'job-outbox',
      topic: 'stash.upload.response',
      key: 'a'.repeat(64),
      payload: '{"status":"FAILED"}',
      nextAttemptAt: now.toISOString(),
      createdAt: now.toISOString(),
    });
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.payload).toBe('{"status":"COMPLETED"}');
    expect(outbox.stats().pending).toBe(1);

    const otherKind = outbox.enqueue({
      jobId: 'job-outbox',
      kind: 'failure-dlq',
      topic: 'stash.dlq',
      key: 'a'.repeat(64),
      payload: '{}',
      nextAttemptAt: new Date(now.getTime() + 120_000).toISOString(),
      createdAt: now.toISOString(),
    });
    expect(otherKind.created).toBe(true);
    expect(outbox.stats().pending).toBe(2);
  });

  it('claims due rows, increments attempts and marks them sent', () => {
    const due = outbox.due(10, now);
    expect(due.length).toBe(1);

    const claimed = outbox.claimDue(10, now);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe('sending');
    expect(claimed[0]?.attempts).toBe(1);

    const sent = outbox.markSent(claimed[0]?.id ?? '', now);
    expect(sent?.status).toBe('sent');
    expect(sent?.sent_at).toBe(now.toISOString());
    expect(outbox.claimDue(10, now)).toHaveLength(0);
    expect(outbox.stats().sent).toBe(1);
  });

  it('does not claim future rows and supports retry/dead transitions', () => {
    const future = new Date(now.getTime() + 60_000).toISOString();
    const inserted = outbox.enqueue({
      jobId: 'job-outbox',
      kind: 'future',
      topic: 'stash.upload.response',
      key: 'a'.repeat(64),
      payload: '{}',
      nextAttemptAt: future,
      createdAt: now.toISOString(),
    });

    expect(outbox.claimDue(10, now)).toHaveLength(0);

    const retried = outbox.markRetry(inserted.row.id, now.toISOString(), 'temporary failure');
    expect(retried?.status).toBe('pending');
    expect(retried?.last_error).toBe('temporary failure');

    const dead = outbox.markDead(inserted.row.id, 'permanent failure');
    expect(dead?.status).toBe('dead');
    expect(outbox.stats().dead).toBe(1);
  });

  it('round-trips outbox headers', () => {
    const row = outbox.getById(
      outbox.enqueue({
        jobId: 'job-outbox',
        kind: 'headers',
        topic: 'stash.upload.response',
        key: 'a'.repeat(64),
        payload: '{}',
        headers: { 'X-Message-Version': '1', 'x-test': 'value' },
      }).row.id,
    );
    expect(row).not.toBeNull();
    expect(outboxHeaders(row as NonNullable<typeof row>)).toEqual({
      'X-Message-Version': '1',
      'x-test': 'value',
    });
  });
});

