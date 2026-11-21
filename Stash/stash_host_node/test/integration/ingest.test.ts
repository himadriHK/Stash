import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase } from '../../src/db/database';
import { EventRepository } from '../../src/db/events';
import { JobRepository } from '../../src/db/jobs';
import type { KafkaIncomingRecord } from '../../src/kafka/consumer';
import { ingestKafkaRecord } from '../../src/pipeline/ingest';
import type { DlqRejectPublisher, IngestDependencies } from '../../src/pipeline/ingest';
import type { RejectCode } from '../../src/validation/requestValidator';
import {
  authorizationHeader,
  createWorkspace,
  makeRecord,
  validRequest,
} from '../helpers/env';

const workspace = createWorkspace();
const db = openDatabase(workspace.env.DB_PATH);
const jobs = new JobRepository(db);
const events = new EventRepository(db);

const dlqCalls: Array<{ record: KafkaIncomingRecord; code: RejectCode; message: string }> = [];
let failDlq = false;

const dlq: DlqRejectPublisher = {
  async publishDlqReject(record, code, message) {
    if (failDlq) throw new Error('DLQ unavailable');
    dlqCalls.push({ record, code, message });
  },
};

const deps: IngestDependencies = {
  db,
  jobs,
  events,
  dlq,
  env: workspace.env,
};

beforeEach(() => {
  db.exec('DELETE FROM outbox; DELETE FROM job_events; DELETE FROM jobs;');
  dlqCalls.length = 0;
  failDlq = false;
});

afterAll(() => {
  closeDatabase(db);
  workspace.cleanup();
});

describe('ingestKafkaRecord', () => {
  it('durably enqueues a valid v2 request with the mapped storage key', async () => {
    const headers = await authorizationHeader(workspace.env);
    const request = validRequest({
      fileId: 'A'.repeat(64),
      storageTempPath: `/temp/uploads/device-1/${'A'.repeat(64)}/photo.heic`,
    });
    const record = makeRecord(request, { key: 'A'.repeat(64), headers });

    const result = await ingestKafkaRecord(record, deps);

    expect(result.status).toBe('accepted');
    expect(dlqCalls).toHaveLength(0);

    const job = jobs.getByCorrelationId('correlation-1');
    expect(job).not.toBeNull();
    expect(job?.status).toBe('queued');
    expect(job?.stage).toBe('queued');
    expect(job?.file_id).toBe('a'.repeat(64));
    expect(job?.request_file_id).toBe('A'.repeat(64));
    expect(job?.storage_key).toBe(
      `stash/temp/uploads/device-1/${'A'.repeat(64)}/photo.heic`,
    );
    expect(job?.user_id).toBe('user-1');
    expect(job?.device_id).toBe('device-1');
    expect(job?.temp_dir).toContain(job?.id ?? '');

    const jobEvents = events.listForJob(job?.id ?? '');
    expect(jobEvents).toHaveLength(1);
    expect(jobEvents[0]?.event).toBe('job_enqueued');
  });

  it('rejects invalid JSON through the DLQ without creating a job', async () => {
    const headers = await authorizationHeader(workspace.env);
    const record: KafkaIncomingRecord = {
      topic: 'stash.upload.request',
      partition: 0,
      offset: '1',
      timestamp: null,
      key: 'a'.repeat(64),
      value: '{not-json',
      headers,
    };

    const result = await ingestKafkaRecord(record, deps);

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.code).toBe('invalid_json');
    }
    expect(dlqCalls).toHaveLength(1);
    expect(dlqCalls[0]?.code).toBe('invalid_json');
    expect(jobs.list().total).toBe(0);
  });

  it('rejects an unsupported provider before enqueueing', async () => {
    const headers = await authorizationHeader(workspace.env);
    const record = makeRecord(validRequest({ storageProvider: 'MEGA' }), { headers });

    const result = await ingestKafkaRecord(record, deps);

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.code).toBe('invalid_storage_provider');
    }
    expect(dlqCalls).toHaveLength(1);
    expect(jobs.list().total).toBe(0);
  });

  it('treats a duplicate correlation id as a no-op job', async () => {
    const headers = await authorizationHeader(workspace.env);
    const first = makeRecord(validRequest(), { headers, offset: '0' });
    const second = makeRecord(
      validRequest({ messageId: 'message-2' }),
      { headers, offset: '1' },
    );

    const firstResult = await ingestKafkaRecord(first, deps);
    const secondResult = await ingestKafkaRecord(second, deps);

    expect(firstResult.status).toBe('accepted');
    expect(secondResult.status).toBe('duplicate');
    expect(jobs.list().total).toBe(1);
    expect(dlqCalls).toHaveLength(0);

    const job = jobs.getByCorrelationId('correlation-1');
    const jobEvents = events.listForJob(job?.id ?? '');
    expect(jobEvents.map((entry) => entry.event)).toContain('job_enqueued');
    expect(jobEvents.map((entry) => entry.event)).toContain('duplicate_ignored');
  });

  it('throws when the DLQ publish fails so the consumer does not commit', async () => {
    failDlq = true;
    const headers = await authorizationHeader(workspace.env);
    const record: KafkaIncomingRecord = {
      topic: 'stash.upload.request',
      partition: 0,
      offset: '2',
      timestamp: null,
      key: 'a'.repeat(64),
      value: '{not-json',
      headers,
    };

    await expect(ingestKafkaRecord(record, deps)).rejects.toThrow('DLQ unavailable');
    expect(jobs.list().total).toBe(0);
  });
});
