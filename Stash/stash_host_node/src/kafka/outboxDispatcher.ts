import type { Logger } from 'pino';

import type { OutboxRepository, OutboxRow } from '../db/outbox';
import { outboxHeaders } from '../db/outbox';
import type { KafkaMessageHeaders } from '../kafka/producer';

export interface OutboxPublisher {
  publish(
    topic: string,
    key: string,
    value: string | Buffer,
    headers?: KafkaMessageHeaders,
  ): Promise<unknown>;
}

export interface OutboxDispatcherOptions {
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  clock?: () => Date;
  logger?: Logger;
}

export interface OutboxFlushResult {
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
  errors: string[];
}

export class OutboxDispatcher {
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly clock: () => Date;

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly publisher: OutboxPublisher,
    private readonly options: OutboxDispatcherOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 8;
    this.retryBaseMs = options.retryBaseMs ?? 2_000;
    this.retryMaxMs = options.retryMaxMs ?? 300_000;
    this.clock = options.clock ?? (() => new Date());
  }

  async flushDue(limit = 20): Promise<OutboxFlushResult> {
    const now = this.clock();
    const rows = this.outbox.claimDue(limit, now);
    const result: OutboxFlushResult = {
      claimed: rows.length,
      sent: 0,
      retried: 0,
      dead: 0,
      errors: [],
    };

    for (const row of rows) {
      const outcome = await this.publishClaimed(row, now);
      if (outcome.status === 'sent') result.sent += 1;
      else if (outcome.status === 'dead') result.dead += 1;
      else result.retried += 1;
      if (outcome.error) result.errors.push(outcome.error);
    }

    return result;
  }

  /**
   * Publishes the response outbox row for one job. Returns `missing` when no
   * row exists, `sent`/`dead` for terminal rows, and `pending` when the row is
   * still being published or was retried after a failure.
   */
  async flushJob(jobId: string, kind = 'response'): Promise<'sent' | 'pending' | 'dead' | 'missing'> {
    const row = this.outbox.getByJobAndKind(jobId, kind);
    if (!row) return 'missing';
    if (row.status === 'sent') return 'sent';
    if (row.status === 'dead') return 'dead';
    if (row.status === 'sending') return 'pending';
    if (row.status !== 'pending') return 'pending';

    const now = this.clock();
    const claimed = this.outbox.claimById(row.id, now);
    if (!claimed) return 'missing';
    if (claimed.status === 'sent') return 'sent';
    if (claimed.status === 'dead') return 'dead';
    if (claimed.status !== 'sending') return 'pending';

    const outcome = await this.publishClaimed(claimed, now);
    return outcome.status === 'sent' ? 'sent' : outcome.status === 'dead' ? 'dead' : 'pending';
  }

  private async publishClaimed(
    row: OutboxRow,
    now: Date,
  ): Promise<{ status: 'sent' | 'retried' | 'dead'; error?: string }> {
    try {
      await this.publisher.publish(row.topic, row.key ?? '', row.payload, outboxHeaders(row));
      this.outbox.markSent(row.id, this.clock());
      return { status: 'sent' };
    } catch (error) {
      const message = errorMessage(error);
      this.options.logger?.warn(
        { outboxId: row.id, jobId: row.job_id, attempts: row.attempts, error: message },
        'Outbox publish failed',
      );

      if (row.attempts >= this.maxAttempts) {
        this.outbox.markDead(row.id, message);
        return { status: 'dead', error: message };
      }

      this.outbox.markRetry(row.id, this.nextAttemptAt(row, now), message);
      return { status: 'retried', error: message };
    }
  }

  private nextAttemptAt(row: OutboxRow, now: Date): string {
    const exponent = Math.max(0, row.attempts - 1);
    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** exponent);
    return new Date(now.getTime() + delay).toISOString();
  }
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length <= 500 ? raw : `${raw.slice(0, 500)}...`;
}