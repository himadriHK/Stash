import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { Logger } from 'pino';

import type { AppEnv } from '../config/env';

export interface KafkaIncomingRecord {
  topic: string;
  partition: number;
  offset: string;
  timestamp: string | null;
  key: string | null;
  value: string;
  headers: Record<string, string>;
}

export type KafkaMessageHandler = (record: KafkaIncomingRecord) => Promise<void>;

export interface KafkaConsumerStatus {
  connected: boolean;
  running: boolean;
  paused: boolean;
  topic: string;
  groupId: string;
  lastMessageAt: string | null;
  lastError: string | null;
}

function buildSasl(env: AppEnv): KafkaJS.SASLOptions | undefined {
  if (!env.KAFKA_USERNAME || !env.KAFKA_PASSWORD) return undefined;
  return {
    mechanism: env.KAFKA_SASL_MECHANISM,
    username: env.KAFKA_USERNAME,
    password: env.KAFKA_PASSWORD,
  };
}

function headerToString(value: Buffer | string | Array<Buffer | string> | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  const first = value[0];
  if (first === undefined) return null;
  return Buffer.isBuffer(first) ? first.toString('utf8') : first;
}

function decodeHeaders(headers: KafkaJS.IHeaders | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  for (const [key, value] of Object.entries(headers)) {
    const decoded = headerToString(value as Buffer | string | Array<Buffer | string> | undefined);
    if (decoded !== null) result[key] = decoded;
  }
  return result;
}

export class KafkaRequestConsumer {
  private kafka: KafkaJS.Kafka | null = null;
  private consumer: KafkaJS.Consumer | null = null;
  private runPromise: Promise<void> | null = null;
  private running = false;
  private connected = false;
  private paused = false;
  private lastMessageAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly env: AppEnv,
    private readonly handler: KafkaMessageHandler,
    private readonly logger?: Logger,
  ) {}

  private client(): KafkaJS.Kafka {
    if (!this.kafka) {
      const sasl = buildSasl(this.env);
      this.kafka = new KafkaJS.Kafka({
        kafkaJS: {
          clientId: this.env.KAFKA_CLIENT_ID,
          brokers: [...this.env.KAFKA_BROKERS],
          ssl: this.env.KAFKA_SSL,
          ...(sasl ? { sasl } : {}),
          retry: { retries: 3, initialRetryTime: 300 },
          logLevel: KafkaJS.logLevel.ERROR,
        },
      });
    }
    return this.kafka;
  }

  async connect(): Promise<void> {
    if (!this.env.KAFKA_ENABLED) {
      throw new Error('Kafka is disabled by configuration');
    }
    if (this.connected) return;

    const consumer = this.client().consumer({
      kafkaJS: {
        groupId: this.env.KAFKA_GROUP_ID,
        fromBeginning: this.env.KAFKA_FROM_BEGINNING,
        autoCommit: false,
        allowAutoTopicCreation: false,
        sessionTimeout: Math.max(10_000, this.env.HEARTBEAT_SECONDS * 3 * 1000),
        heartbeatInterval: this.env.HEARTBEAT_SECONDS * 1000,
        maxWaitTimeInMs: 500,
      },
    });
    await consumer.connect();
    await consumer.subscribe({ topics: [this.env.KAFKA_REQUEST_TOPIC] });
    this.consumer = consumer;
    this.connected = true;
    this.logger?.info(
      { topic: this.env.KAFKA_REQUEST_TOPIC, groupId: this.env.KAFKA_GROUP_ID },
      'Kafka request consumer connected',
    );
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.connect();
    const consumer = this.consumer;
    if (!consumer) throw new Error('Kafka consumer is not connected');

    this.running = true;
    this.runPromise = consumer
      .run({
        eachMessage: async ({ topic, partition, message, heartbeat }) => {
          const key = message.key ? message.key.toString('utf8') : null;
          const value = message.value ? message.value.toString('utf8') : '';
          const record: KafkaIncomingRecord = {
            topic,
            partition,
            offset: String(message.offset),
            timestamp: message.timestamp ?? null,
            key,
            value,
            headers: decodeHeaders(message.headers),
          };

          if (typeof heartbeat === 'function') await heartbeat();
          await this.handler(record);
          const nextOffset = (BigInt(record.offset) + 1n).toString();
          await consumer.commitOffsets([{ topic, partition, offset: nextOffset }]);
          this.lastMessageAt = new Date().toISOString();
        },
      })
      .catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.logger?.error({ error }, 'Kafka consumer run loop stopped');
      })
      .finally(() => {
        this.running = false;
      });

    await Promise.resolve();
  }

  async pause(): Promise<void> {
    if (!this.consumer || this.paused) return;
    this.consumer.pause([{ topic: this.env.KAFKA_REQUEST_TOPIC }]);
    this.paused = true;
  }

  async resume(): Promise<void> {
    if (!this.consumer || !this.paused) return;
    this.consumer.resume([{ topic: this.env.KAFKA_REQUEST_TOPIC }]);
    this.paused = false;
  }

  async stop(): Promise<void> {
    if (this.consumer) {
      try {
        await this.consumer.disconnect();
      } catch (error) {
        this.logger?.warn({ error }, 'Kafka consumer disconnect failed during stop');
      }
    }
    if (this.runPromise) {
      try {
        await this.runPromise;
      } catch {
        // The run loop error is recorded in lastError.
      }
      this.runPromise = null;
    }
  }

  async disconnect(): Promise<void> {
    await this.stop();
    this.consumer = null;
    this.connected = false;
    this.paused = false;
  }

  status(): KafkaConsumerStatus {
    return {
      connected: this.connected,
      running: this.running,
      paused: this.paused,
      topic: this.env.KAFKA_REQUEST_TOPIC,
      groupId: this.env.KAFKA_GROUP_ID,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
    };
  }
}




