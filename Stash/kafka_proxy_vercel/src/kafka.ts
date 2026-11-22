/**
 * Confluent Kafka client behind the gateway contract.
 *
 * The producer is created once per warm function instance and reused; it is
 * dropped and reconnected on the next request after a failure. Consumption is
 * one bounded poll per HTTP request: serverless functions cannot hold a
 * long-lived consumer, so each poll joins the device's consumer group, drains
 * what is available, commits and leaves.
 */
import { KafkaJS } from '@confluentinc/kafka-javascript';

import type { AppConfig } from './config.ts';
import type { KafkaGateway, PollOptions } from './gateway.ts';
import { HttpError } from './http.ts';
import type { KafkaRecord, ProduceInput } from './records.ts';
import { toRecord } from './records.ts';

const MAX_ERROR_CHARS = 300;

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length <= MAX_ERROR_CHARS ? raw : `${raw.slice(0, MAX_ERROR_CHARS)}...`;
}

function upstreamError(action: string, error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  return new HttpError(502, 'upstream_error', `Kafka ${action} failed: ${errorMessage(error)}`);
}

/** A cancelleable delay, so a fast poll never leaves an idle timer behind. */
function waitFor(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    },
  };
}

function saslConfig(config: AppConfig): KafkaJS.SASLOptions | undefined {
  if (!config.securityProtocol.startsWith('SASL')) {
    return undefined;
  }
  const credentials = { username: config.saslUsername, password: config.saslPassword };
  switch (config.saslMechanism) {
    case 'plain':
      return { mechanism: 'plain', ...credentials };
    case 'scram-sha-512':
      return { mechanism: 'scram-sha-512', ...credentials };
    case 'scram-sha-256':
    default:
      return { mechanism: 'scram-sha-256', ...credentials };
  }
}

export class ConfluentKafkaGateway implements KafkaGateway {
  private readonly config: AppConfig;
  private kafkaInstance: KafkaJS.Kafka | null = null;
  private producerPromise: Promise<KafkaJS.Producer<string, string>> | null = null;

  constructor(config: AppConfig) {
    this.config = config;
  }

  private client(): KafkaJS.Kafka {
    if (!this.kafkaInstance) {
      const sasl = saslConfig(this.config);
      this.kafkaInstance = new KafkaJS.Kafka({
        kafkaJS: {
          clientId: this.config.clientId,
          brokers: this.config.brokers,
          ssl:
            this.config.securityProtocol === 'SSL' ||
            this.config.securityProtocol === 'SASL_SSL',
          ...(sasl ? { sasl } : {}),
          connectionTimeout: this.config.connectionTimeoutMs,
          requestTimeout: this.config.requestTimeoutMs,
          logLevel: KafkaJS.logLevel.ERROR,
          retry: { retries: 3, initialRetryTime: 200 },
        },
      });
    }
    return this.kafkaInstance;
  }

  private async producer(): Promise<KafkaJS.Producer<string, string>> {
    if (!this.producerPromise) {
      this.producerPromise = (async () => {
        const producer = this.client().producer<string, string>({
          kafkaJS: {
            acks: -1,
            compression: KafkaJS.CompressionTypes.None,
            timeout: this.config.requestTimeoutMs,
          },
        });
        await producer.connect();
        return producer;
      })().catch((error: unknown) => {
        this.producerPromise = null;
        throw error;
      });
    }
    return this.producerPromise;
  }

  private async resetProducer(): Promise<void> {
    const pending = this.producerPromise;
    this.producerPromise = null;
    if (!pending) {
      return;
    }
    try {
      const producer = await pending;
      await producer.disconnect();
    } catch {
      // The connection was already unusable; the next request reconnects.
    }
  }

  async produce(input: ProduceInput): Promise<{ partition: number; offset: number }> {
    let producer: KafkaJS.Producer<string, string>;
    try {
      producer = await this.producer();
    } catch (error) {
      throw upstreamError('connection', error);
    }

    try {
      const metadata = await producer.send({
        topic: input.topic,
        messages: [{ key: input.key, value: input.value, headers: input.headers }],
      });
      const first = metadata[0];
      return {
        partition: first?.partition ?? 0,
        offset: first?.offset === undefined ? -1 : Number(first.offset),
      };
    } catch (error) {
      await this.resetProducer();
      throw upstreamError('produce', error);
    }
  }

  async poll(options: PollOptions): Promise<KafkaRecord[]> {
    const deadline = Date.now() + options.timeoutMs;
    const consumer = this.client().consumer({
      kafkaJS: {
        groupId: options.groupId,
        fromBeginning: true,
        autoCommit: false,
        sessionTimeout: this.config.consumerSessionTimeoutMs,
        heartbeatInterval: this.config.consumerHeartbeatMs,
        rebalanceTimeout: this.config.consumerSessionTimeoutMs,
        maxWaitTimeInMs: 500,
        minBytes: 1,
        maxBytes: 1_048_576,
        allowAutoTopicCreation: false,
      },
    });

    const records: KafkaRecord[] = [];
    let finish: (() => void) | null = null;
    const limitReached = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let runError: unknown = null;

    try {
      await consumer.connect();
    } catch (error) {
      throw upstreamError('consumer connection', error);
    }

    try {
      await consumer.subscribe({ topics: [options.topic] });

      const runPromise = consumer
        .run({
          eachBatchAutoResolve: false,
          eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning }) => {
            let highest = -1;
            for (const message of batch.messages) {
              if (!isRunning() || records.length >= options.maxRecords) {
                break;
              }
              records.push(toRecord(batch.topic, batch.partition, message));
              resolveOffset(message.offset);
              highest = Math.max(highest, Number(message.offset));
            }

            await heartbeat();

            if (highest >= 0) {
              try {
                await consumer.commitOffsets([
                  { topic: batch.topic, partition: batch.partition, offset: String(highest + 1) },
                ]);
              } catch (error) {
                // A missed commit only replays records; the app de-duplicates by offset.
                console.warn('Kafka offset commit failed.', errorMessage(error));
              }
            }

            if (records.length >= options.maxRecords) {
              finish?.();
            }
          },
        })
        .catch((error: unknown) => {
          runError = error;
        });

      const timer = waitFor(Math.max(0, deadline - Date.now()));
      try {
        await Promise.race([limitReached, timer.promise]);
      } finally {
        timer.cancel();
      }

      await consumer.stop().catch(() => undefined);
      await runPromise;

      if (runError && records.length === 0) {
        throw upstreamError('consume', runError);
      }
      return records;
    } finally {
      await consumer.disconnect().catch(() => undefined);
    }
  }
}

let sharedGateway: ConfluentKafkaGateway | null = null;

/** One gateway per warm function instance, so connections survive between requests. */
export function getConfluentGateway(config: AppConfig): KafkaGateway {
  sharedGateway ??= new ConfluentKafkaGateway(config);
  return sharedGateway;
}
