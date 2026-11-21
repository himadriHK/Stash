import type { Logger } from 'pino';

import type { AppEnv } from '../config/env';
import type { JobRepository } from '../db/jobs';
import type { OutboxRepository } from '../db/outbox';
import type { OutboxDispatcher } from '../kafka/outboxDispatcher';
import type { LocalLibrary } from '../storage/local';
import type { S3Storage } from '../storage/s3';

export type StoragePort = Pick<S3Storage, 'getObjectStream' | 'deleteObject' | 'headObject'>;

export type HashFile = (
  path: string,
  onProgress?: (bytes: number, total: number) => void,
  signal?: AbortSignal,
) => Promise<string>;

export interface PipelineDeps {
  env: AppEnv;
  jobs: JobRepository;
  outbox: OutboxRepository;
  outboxDispatcher: OutboxDispatcher;
  storage: StoragePort;
  local: LocalLibrary;
  hashFile?: HashFile;
  logger?: Logger;
  now?: () => Date;
}
