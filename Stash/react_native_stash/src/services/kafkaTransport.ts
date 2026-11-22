/**
 * Kafka transport contract.
 *
 * The app talks to Kafka through the Stash Kafka proxy
 * (`kafkaProxyTransport.ts`). Producers and the response consumer depend on
 * this interface only.
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
