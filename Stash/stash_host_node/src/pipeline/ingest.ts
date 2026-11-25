import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { AppEnv } from '../config/env';
import type { Db } from '../db/database';
import type { EventRepository } from '../db/events';
import type { JobRepository, JobRow } from '../db/jobs';
import type { KafkaIncomingRecord } from '../kafka/consumer';
import type { RejectCode } from '../validation/requestValidator';
import type { ValidatedUploadRequest } from '../contracts/request';
import { RejectError, validateRequest } from '../validation/requestValidator';

export interface DlqRejectPublisher {
  publishDlqReject(
    record: KafkaIncomingRecord,
    code: RejectCode,
    message: string,
    knownFileId?: string,
  ): Promise<unknown>;
}

export interface IngestDependencies {
  db: Db;
  jobs: JobRepository;
  events: EventRepository;
  dlq: DlqRejectPublisher;
  env: AppEnv;
  now?: () => Date;
}

export type IngestResult =
  | { status: 'accepted'; job: JobRow; created: true }
  | { status: 'duplicate'; job: JobRow; created: false }
  | { status: 'rejected'; code: RejectCode; message: string };

export async function ingestKafkaRecord(
  record: KafkaIncomingRecord,
  deps: IngestDependencies,
): Promise<IngestResult> {
  let validated: ValidatedUploadRequest;
  try {
    validated = await validateRequest(record.value, record.key, record.headers, deps.env);
  } catch (error) {
    if (error instanceof RejectError) {
      // The DLQ publish must be acknowledged before the consumer commits the offset.
      // If this throws, the error propagates and no commit happens.
      await deps.dlq.publishDlqReject(
        record,
        error.code,
        error.message,
        extractFileId(record.value),
      );
      return { status: 'rejected', code: error.code, message: error.message };
    }
    throw error;
  }

  const now = (deps.now?.() ?? new Date()).toISOString();
  const jobId = randomUUID();

  const outcome = deps.db.transaction(() => {
    const inserted = deps.jobs.insertIfNew({
      id: jobId,
      correlationId: validated.correlationId,
      messageId: validated.messageId,
      fileId: validated.fileId,
      requestFileId: validated.requestFileId,
      fileName: validated.fileName,
      mimeType: validated.mimeType,
      storageProvider: validated.storageProvider,
      storageTempPath: validated.storageTempPath,
      storageKey: validated.storageKey,
      userId: validated.userId,
      deviceId: validated.deviceId,
      metadataJson: validated.metadataJson,
      maxAttempts: deps.env.JOB_MAX_ATTEMPTS,
      tempDir: path.join(deps.env.TEMP_DIR, 'jobs', jobId),
      createdAt: now,
    });

    if (!inserted.created) {
      deps.events.append({
        jobId: inserted.job.id,
        event: 'duplicate_ignored',
        level: 'info',
        stage: inserted.job.stage,
        message: 'Duplicate correlation id delivered by Kafka',
        data: { correlationId: validated.correlationId },
        at: now,
      });
      return { kind: 'duplicate' as const, job: inserted.job };
    }

    deps.events.append({
      jobId: inserted.job.id,
      event: 'job_enqueued',
      level: 'info',
      stage: 'queued',
      message: 'Upload request accepted',
      data: {
        correlationId: validated.correlationId,
        messageId: validated.messageId,
        fileId: validated.fileId,
        fileName: validated.fileName,
        storageKey: validated.storageKey,
      },
      at: now,
    });

    return { kind: 'accepted' as const, job: inserted.job };
  })();

  if (outcome.kind === 'duplicate') {
    return { status: 'duplicate', job: outcome.job, created: false };
  }
  return { status: 'accepted', job: outcome.job, created: true };
}

function extractFileId(rawValue: string): string | undefined {
  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const fileId = (parsed as Record<string, unknown>)['fileId'];
    if (typeof fileId === 'string' && /^[0-9a-f]{64}$/i.test(fileId)) {
      return fileId.toLowerCase();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

