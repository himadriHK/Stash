/** Gateway contract, kept free of the native Kafka dependency so routes are testable. */
import type { KafkaRecord, ProduceInput } from './records.ts';

export interface PollOptions {
  /** Kafka consumer group; derived from the verified device identity, never from the request. */
  groupId: string;
  topic: string;
  timeoutMs: number;
  maxRecords: number;
}

export interface KafkaGateway {
  produce(input: ProduceInput): Promise<{ partition: number; offset: number }>;
  poll(options: PollOptions): Promise<KafkaRecord[]>;
}
