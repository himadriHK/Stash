/**
 * Kafka transport contract.
 *
 * The app has two interchangeable implementations: the Confluent REST Proxy
 * transport (`kafkaRestTransport.ts`) and the Vercel proxy transport
 * (`kafkaProxyTransport.ts`, which polls). Producers and the response consumer
 * depend on this interface only.
 */

export interface KafkaTransportMessage {
  topic: string;
  key: string;
  value: string;
  headers: Record<string, string>;
}

export interface KafkaTransportRecord {
  topic: string;
  key: string;
  value: string;
  headers: Record<string, string>;
  /** Present when the transport reports offsets (proxy polling). */
  partition?: number;
  /** Present when the transport reports offsets (proxy polling). */
  offset?: number;
}

export type RecordHandler = (record: KafkaTransportRecord) => Promise<void>;

export interface KafkaTransport {
  produceAsync(message: KafkaTransportMessage): Promise<void>;
  /** Consumes records until the signal is aborted. */
  consumeAsync(
    topic: string,
    groupId: string,
    onRecord: RecordHandler,
    signal: AbortSignal,
  ): Promise<void>;
}

export class KafkaTransportException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KafkaTransportException';
  }
}

export class KafkaConsumerNotFoundException extends Error {
  constructor() {
    super('Kafka REST consumer instance was not found.');
    this.name = 'KafkaConsumerNotFoundException';
  }
}
