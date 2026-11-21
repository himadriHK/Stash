import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { Logger } from 'pino';

import type { AppEnv } from '../config/env';

export interface KafkaMessageHeaders {
  [key: string]: string | Buffer | undefined;
}

export interface PublishResult {
  topic: string;
  partition: number;
  offset: string;
}

export interface KafkaRecordForDlq {
  topic: string;
  partition: number;
  offset: string;
  key?: string | Buffer | null;
  value?: string | Buffer | null;
}

function buildSasl(env: AppEnv): KafkaJS.SASLOptions | undefined {
  if (!env.KAFKA_USERNAME || !env.KAFKA_PASSWORD) return undefined;
  return {
    mechanism: env.KAFKA_SASL_MECHANISM,
    username: env.KAFKA_USERNAME,
    password: env.KAFKA_PASSWORD,
  };
}

export class KafkaProducer {
  private kafka: KafkaJS.Kafka | null = null;
  private producer: KafkaJS.Producer<string, string> | null = null;
  private connecting: Promise<KafkaJS.Producer<string, string>> | null = null;

  constructor(
    private readonly env: AppEnv,
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

  private async ensureProducer(): Promise<KafkaJS.Producer<string, string>> {
    if (this.producer) return this.producer;
    if (this.connecting) return this.connecting;

    if (!this.env.KAFKA_ENABLED) {
      throw new Error('Kafka is disabled by configuration');
    }

    this.connecting = (async () => {
      const producer = this.client().producer<string, string>({
        kafkaJS: {
          acks: -1,
          idempotent: true,
          timeout: this.env.KAFKA_COMMIT_TIMEOUT_MS,
        },
      });
      await producer.connect();
      this.producer = producer;
      this.logger?.info({ topic: this.env.KAFKA_RESPONSE_TOPIC }, 'Kafka producer connected');
      return producer;
    })().finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  async connect(): Promise<void> {
    await this.ensureProducer();
  }

  async publish(
    topic: string,
    key: string,
    value: string,
    headers?: KafkaMessageHeaders,
  ): Promise<PublishResult> {
    const producer = await this.ensureProducer();
    const metadata = await producer.send({
      topic,
      messages: [{ key, value, ...(headers ? { headers } : {}) }],
    });
    const first = metadata[0];
    return {
      topic: first?.topicName ?? topic,
      partition: first?.partition ?? 0,
      offset: first?.offset ?? '-1',
    };
  }

  async publishDlqReject(
    record: KafkaRecordForDlq,
    code: string,
    message: string,
    knownFileId?: string,
  ): Promise<PublishResult> {
    const rawKey = record.key;
    const recordKey = rawKey ? (Buffer.isBuffer(rawKey) ? rawKey.toString('utf8') : rawKey) : '';
    const key = recordKey || knownFileId || '';
    const reason = `${code}: ${message}`.slice(0, 500);
    const value = Buffer.isBuffer(record.value)
      ? record.value.toString('utf8')
      : (record.value ?? '');

    return this.publish(this.env.KAFKA_DLQ_TOPIC, key, value, {
      'x-dlq-reason': reason,
      'x-dlq-kind': 'rejection',
      'x-original-topic': record.topic,
      'x-original-partition': String(record.partition),
      'x-original-offset': String(record.offset),
      'x-attempts': '0',
      'X-Message-Version': '1',
    });
  }

  async health(): Promise<{ connected: boolean }> {
    return { connected: this.producer !== null };
  }

  async disconnect(): Promise<void> {
    const producer = this.producer;
    this.producer = null;
    if (!producer) return;
    try {
      await producer.disconnect();
    } catch (error) {
      this.logger?.warn({ error }, 'Kafka producer disconnect failed');
    }
  }
}

