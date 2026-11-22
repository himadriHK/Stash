import type { Logger } from 'pino';

import type { AppEnv } from '../config/env';
import type { Db } from '../db/database';
import { EventRepository } from '../db/events';
import { JobRepository } from '../db/jobs';
import { OutboxRepository } from '../db/outbox';
import { KafkaRequestConsumer } from '../kafka/consumer';
import type { KafkaIncomingRecord } from '../kafka/consumer';
import { OutboxDispatcher } from '../kafka/outboxDispatcher';
import { KafkaProducer } from '../kafka/producer';
import { LocalLibrary } from '../storage/local';
import { S3Storage } from '../storage/s3';
import { ingestKafkaRecord } from './ingest';
import { PipelineRunner } from './runner';
import { sanitizeErrorMessage } from './response';
import { WorkerPool } from './workerPool';

export interface PipelineRuntimeKafkaStatus {
  enabled: boolean;
  connected: boolean;
  running: boolean;
  paused: boolean;
  topic: string;
  groupId: string;
  lastMessageAt: string | null;
  lastError: string | null;
}

export interface PipelineRuntimeWorkerStatus {
  enabled: boolean;
  workers: number;
  running: number;
  queued: number;
  lastError: string | null;
}

export interface PipelineRuntimeOutboxStatus {
  lastFlushAt: string | null;
  lastError: string | null;
}

export interface PipelineRuntimeStatus {
  wired: boolean;
  kafka: PipelineRuntimeKafkaStatus;
  worker: PipelineRuntimeWorkerStatus;
  outboxDispatch: PipelineRuntimeOutboxStatus;
}

export interface PipelineRuntimeDeps {
  env: AppEnv;
  db: Db;
  logger?: Logger;
}

const KAFKA_RETRY_MS = 10_000;
const OUTBOX_FLUSH_INTERVAL_MS = 5_000;
const OUTBOX_FLUSH_LIMIT = 20;

/**
 * Composes and supervises the runtime data path: Kafka intake -> ingest ->
 * job queue -> worker pool pipeline -> response outbox -> Kafka producer.
 * Kafka connection failures never prevent the HTTP server/dashboard from
 * starting; they are retried and surfaced through `status()`.
 */
export class PipelineRuntime {
  private readonly env: AppEnv;
  private readonly db: Db;
  private readonly logger?: Logger;
  private readonly jobs: JobRepository;
  private readonly events: EventRepository;
  private readonly outbox: OutboxRepository;
  private readonly local: LocalLibrary;
  private readonly storage: S3Storage;
  private readonly producer: KafkaProducer;
  private readonly dispatcher: OutboxDispatcher;
  private readonly runner: PipelineRunner;
  private readonly pool: WorkerPool;
  private readonly consumer: KafkaRequestConsumer;

  private started = false;
  private kafkaLastError: string | null = null;
  private outboxLastFlushAt: string | null = null;
  private outboxLastError: string | null = null;
  private kafkaRetryTimer: NodeJS.Timeout | null = null;
  private outboxTimer: NodeJS.Timeout | null = null;
  private outboxFlushing = false;

  constructor(deps: PipelineRuntimeDeps) {
    this.env = deps.env;
    this.db = deps.db;
    this.logger = deps.logger;
    this.jobs = new JobRepository(deps.db);
    this.events = new EventRepository(deps.db);
    this.outbox = new OutboxRepository(deps.db);
    this.local = new LocalLibrary(deps.env);
    this.storage = new S3Storage(deps.env);
    this.producer = new KafkaProducer(deps.env, deps.logger);
    this.dispatcher = new OutboxDispatcher(this.outbox, this.producer, {
      retryBaseMs: deps.env.RETRY_BASE_MS,
      retryMaxMs: deps.env.RETRY_MAX_MS,
      logger: deps.logger,
    });
    this.runner = new PipelineRunner({
      env: deps.env,
      jobs: this.jobs,
      outbox: this.outbox,
      outboxDispatcher: this.dispatcher,
      storage: this.storage,
      local: this.local,
      logger: deps.logger,
    });
    this.pool = new WorkerPool({
      env: deps.env,
      jobs: this.jobs,
      outbox: this.outbox,
      runner: this.runner,
      local: this.local,
      storage: this.storage,
      logger: deps.logger,
    });
    this.consumer = new KafkaRequestConsumer(
      deps.env,
      (record) => this.handleRecord(record),
      deps.logger,
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    try {
      await this.local.ensureReady();
    } catch (error) {
      this.logger?.error(
        { error: sanitizeErrorMessage(error) },
        'Local library is not ready; pipeline jobs will fail until it is writable',
      );
    }

    if (this.env.WORKER_ENABLED) {
      await this.pool.start();
      this.logger?.info(
        { workers: this.env.WORKER_CONCURRENCY },
        'Pipeline worker pool started',
      );
    } else {
      this.logger?.info('Pipeline worker pool is disabled by configuration');
    }

    if (this.env.KAFKA_ENABLED) {
      await this.startKafka();
      this.outboxTimer = setInterval(() => {
        void this.flushOutbox();
      }, OUTBOX_FLUSH_INTERVAL_MS);
      if (typeof this.outboxTimer.unref === 'function') this.outboxTimer.unref();
    } else {
      this.logger?.info('Kafka intake is disabled by configuration');
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.kafkaRetryTimer) {
      clearTimeout(this.kafkaRetryTimer);
      this.kafkaRetryTimer = null;
    }
    if (this.outboxTimer) {
      clearInterval(this.outboxTimer);
      this.outboxTimer = null;
    }

    try {
      await this.consumer.disconnect();
    } catch (error) {
      this.logger?.warn({ error: sanitizeErrorMessage(error) }, 'Kafka consumer shutdown failed');
    }
    await this.pool.stop();
    await this.producer.disconnect();
  }

  status(): PipelineRuntimeStatus {
    const kafka = this.consumer.status();
    const worker = this.pool.getStatus();
    return {
      wired: this.started,
      kafka: {
        enabled: this.env.KAFKA_ENABLED,
        connected: kafka.connected,
        running: kafka.running,
        paused: kafka.paused,
        topic: kafka.topic,
        groupId: kafka.groupId,
        lastMessageAt: kafka.lastMessageAt,
        lastError: this.kafkaLastError ?? kafka.lastError,
      },
      worker: {
        enabled: this.env.WORKER_ENABLED,
        workers: worker.workers,
        running: worker.running,
        queued: worker.queued,
        lastError: worker.lastError,
      },
      outboxDispatch: {
        lastFlushAt: this.outboxLastFlushAt,
        lastError: this.outboxLastError,
      },
    };
  }

  private async startKafka(): Promise<void> {
    this.kafkaRetryTimer = null;
    let failed = false;

    try {
      await this.producer.connect();
    } catch (error) {
      failed = true;
      this.kafkaLastError = sanitizeErrorMessage(error);
      this.logger?.error(
        { error: this.kafkaLastError, brokers: this.env.KAFKA_BROKERS },
        'Kafka producer connection failed',
      );
    }

    try {
      await this.consumer.start();
      this.kafkaLastError = null;
      this.logger?.info(
        {
          topic: this.env.KAFKA_REQUEST_TOPIC,
          groupId: this.env.KAFKA_GROUP_ID,
          brokers: this.env.KAFKA_BROKERS,
        },
        'Kafka intake listening for upload requests',
      );
    } catch (error) {
      failed = true;
      this.kafkaLastError = sanitizeErrorMessage(error);
      this.logger?.error(
        {
          error: this.kafkaLastError,
          topic: this.env.KAFKA_REQUEST_TOPIC,
          brokers: this.env.KAFKA_BROKERS,
        },
        'Kafka consumer connection failed',
      );
    }

    if (failed && this.started) {
      this.kafkaRetryTimer = setTimeout(() => {
        if (this.started) void this.startKafka();
      }, KAFKA_RETRY_MS);
      if (typeof this.kafkaRetryTimer.unref === 'function') this.kafkaRetryTimer.unref();
    }
  }

  private async handleRecord(record: KafkaIncomingRecord): Promise<void> {
    const result = await ingestKafkaRecord(record, {
      db: this.db,
      jobs: this.jobs,
      events: this.events,
      dlq: this.producer,
      env: this.env,
    });

    if (result.status === 'accepted') {
      this.logger?.info(
        {
          jobId: result.job.id,
          correlationId: result.job.correlation_id,
          fileId: result.job.file_id,
          fileName: result.job.file_name,
          kafkaTopic: record.topic,
          kafkaPartition: record.partition,
          kafkaOffset: record.offset,
        },
        'Kafka upload request ingested',
      );
      return;
    }

    if (result.status === 'duplicate') {
      this.logger?.info(
        { jobId: result.job.id, correlationId: result.job.correlation_id },
        'Duplicate Kafka upload request ignored',
      );
      return;
    }

    this.logger?.warn(
      {
        code: result.code,
        message: result.message,
        kafkaTopic: record.topic,
        kafkaPartition: record.partition,
        kafkaOffset: record.offset,
      },
      'Kafka upload request rejected and sent to the DLQ',
    );
  }

  private async flushOutbox(): Promise<void> {
    if (!this.started || this.outboxFlushing) return;
    this.outboxFlushing = true;
    try {
      const result = await this.dispatcher.flushDue(OUTBOX_FLUSH_LIMIT);
      this.outboxLastFlushAt = new Date().toISOString();
      this.outboxLastError = result.errors[0] ?? null;
      if (result.sent > 0 || result.dead > 0) {
        this.logger?.info(
          { sent: result.sent, retried: result.retried, dead: result.dead },
          'Outbox flush completed',
        );
      }
    } catch (error) {
      this.outboxLastError = sanitizeErrorMessage(error);
      this.logger?.warn({ error: this.outboxLastError }, 'Outbox flush failed');
    } finally {
      this.outboxFlushing = false;
    }
  }
}
