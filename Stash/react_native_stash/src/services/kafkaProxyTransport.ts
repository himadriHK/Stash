/**
 * Kafka transport over the Stash Kafka proxy (Vercel Function).
 *
 * Produce is one authenticated POST per message. Consume is a polling loop: the
 * app asks the proxy for new records, the proxy runs a bounded Kafka poll, and
 * the app applies whatever comes back. That replaces the long-lived REST
 * consumer the mobile client cannot keep alive across background transitions.
 *
 * The proxy derives the Kafka consumer group from the access token's device
 * claim, so Kafka credentials never reach the device.
 */
import {
  ensureValidAccessTokenAsync,
  getAccessTokenAsync,
  refreshTokenAsync,
} from '../auth/authenticationService';
import { appConfig, kafkaProxyUrl, resolveUrl } from '../config/appConfig';
import type {
  KafkaTransport,
  KafkaTransportMessage,
  KafkaTransportRecord,
  RecordHandler,
} from './kafkaTransport';
import { KafkaTransportException } from './kafkaTransport';

const MAX_SEEN_RECORDS = 1000;
const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60_000;
const MAX_ERROR_CHARS = 300;

function clamp(value: number, min: number, max: number): number {
  const numeric = Number.isFinite(value) ? value : min;
  return Math.min(Math.max(numeric, min), max);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Reads the proxy's error envelope ({error:{code,message}}) or falls back to the body. */
function readErrorBody(body: string): string {
  const text = body.trim();
  if (!text) {
    return 'no response body';
  }
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === 'string' && message.length > 0) {
      return message.length <= MAX_ERROR_CHARS ? message : `${message.slice(0, MAX_ERROR_CHARS)}...`;
    }
  } catch {
    // Not the expected envelope; use the raw body.
  }
  return text.length <= MAX_ERROR_CHARS ? text : `${text.slice(0, MAX_ERROR_CHARS)}...`;
}

function readHeaders(raw: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return headers;
  }
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      headers[name] = value;
    }
  }
  return headers;
}

function readRecord(raw: unknown): KafkaTransportRecord | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.topic !== 'string' || record.topic.length === 0) {
    return null;
  }
  return {
    topic: record.topic,
    key: typeof record.key === 'string' ? record.key : '',
    value: typeof record.value === 'string' ? record.value : '',
    headers: readHeaders(record.headers),
    partition: typeof record.partition === 'number' ? record.partition : undefined,
    offset: typeof record.offset === 'number' ? record.offset : undefined,
  };
}

function readRecords(body: string): KafkaTransportRecord[] {
  if (!body.trim()) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const raw = (parsed as { records?: unknown }).records;
  if (!Array.isArray(raw)) {
    return [];
  }
  const records: KafkaTransportRecord[] = [];
  for (const element of raw) {
    const record = readRecord(element);
    if (record) {
      records.push(record);
    }
  }
  return records;
}

/** Stable identity of a delivered record, so poll retries cannot re-apply it. */
function recordKey(record: KafkaTransportRecord): string {
  if (record.partition !== undefined && record.offset !== undefined) {
    return `${record.topic}|${record.partition}|${record.offset}`;
  }
  return `${record.topic}|${record.key}|${record.value}`;
}

export class KafkaProxyTransport implements KafkaTransport {
  private readonly seen = new Set<string>();

  private baseUrl(): string {
    const base = kafkaProxyUrl();
    if (!base) {
      throw new KafkaTransportException(
        'Kafka proxy is not configured. Set Kafka.Proxy.BaseUrl in appconfig.json.',
      );
    }
    return base;
  }

  private timeoutMs(): number {
    const seconds = appConfig.Kafka.Proxy.RequestTimeoutSeconds;
    return (seconds > 0 ? seconds : 45) * 1000;
  }

  private pollIntervalMs(): number {
    return clamp(appConfig.Kafka.Proxy.PollIntervalMs, 1000, 300_000);
  }

  private pollTimeoutMs(): number {
    return clamp(appConfig.Kafka.Proxy.PollTimeoutMs, 0, 30_000);
  }

  private maxRecordsPerPoll(): number {
    return clamp(appConfig.Kafka.Proxy.MaxRecordsPerPoll, 1, 200);
  }

  private async accessTokenAsync(): Promise<string> {
    const usable = await ensureValidAccessTokenAsync();
    const token = usable ? await getAccessTokenAsync() : '';
    if (!token) {
      throw new KafkaTransportException(
        'Cannot call the Kafka proxy without an authenticated access token.',
      );
    }
    return token;
  }

  private async requestAsync(
    url: string,
    init: RequestInit,
    outerSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    const forwardAbort = (): void => controller.abort();
    outerSignal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', forwardAbort);
    }
  }

  async produceAsync(message: KafkaTransportMessage): Promise<void> {
    if (!message.topic) {
      throw new KafkaTransportException('A Kafka topic is required.');
    }
    await this.sendProduceAsync(message, await this.accessTokenAsync(), true);
  }

  private async sendProduceAsync(
    message: KafkaTransportMessage,
    token: string,
    allowRefresh: boolean,
  ): Promise<void> {
    const response = await this.requestAsync(resolveUrl(this.baseUrl(), 'api/messages'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        topic: message.topic,
        key: message.key ?? '',
        value: message.value ?? '',
        headers: message.headers ?? {},
      }),
    });
    const body = await response.text().catch(() => '');

    // An expired access token is recoverable once: refresh, then retry.
    if (response.status === 401 && allowRefresh && (await refreshTokenAsync())) {
      await this.sendProduceAsync(message, await getAccessTokenAsync(), false);
      return;
    }

    if (!response.ok) {
      throw new KafkaTransportException(
        `Kafka proxy produce failed with ${response.status} ${response.statusText}: ${readErrorBody(body)}`,
      );
    }
  }

  /**
   * Polls the proxy until the signal is aborted.
   *
   * `groupId` is validated for parity with the REST transport; the proxy derives
   * the effective consumer group from the access token.
   */
  async consumeAsync(
    topic: string,
    groupId: string,
    onRecord: RecordHandler,
    signal: AbortSignal,
  ): Promise<void> {
    if (!topic) {
      throw new KafkaTransportException('A Kafka topic is required.');
    }
    if (!groupId) {
      throw new KafkaTransportException('A consumer group id is required.');
    }

    const intervalMs = this.pollIntervalMs();
    let backoffMs = Math.min(intervalMs, INITIAL_BACKOFF_MS);

    while (!signal.aborted) {
      try {
        const records = await this.pollOnceAsync(topic, signal);
        backoffMs = Math.min(intervalMs, INITIAL_BACKOFF_MS);

        for (const record of records) {
          if (signal.aborted) {
            break;
          }
          const key = recordKey(record);
          if (this.seen.has(key)) {
            continue;
          }
          this.remember(key);
          await onRecord(record);
        }

        // A full page means more records are waiting; otherwise wait for the interval.
        if (records.length < this.maxRecordsPerPoll()) {
          await delay(intervalMs, signal);
        }
      } catch (error) {
        if (signal.aborted) {
          break;
        }
        console.warn(`Kafka proxy poll for ${topic} failed; retrying in ${backoffMs}ms.`, error);
        await delay(backoffMs, signal);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  private async pollOnceAsync(topic: string, signal: AbortSignal): Promise<KafkaTransportRecord[]> {
    const token = await this.accessTokenAsync();
    const query =
      `?topic=${encodeURIComponent(topic)}` +
      `&timeoutMs=${this.pollTimeoutMs()}` +
      `&maxRecords=${this.maxRecordsPerPoll()}`;
    const response = await this.requestAsync(
      `${resolveUrl(this.baseUrl(), 'api/messages')}${query}`,
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      signal,
    );
    const body = await response.text().catch(() => '');

    if (!response.ok) {
      throw new KafkaTransportException(
        `Kafka proxy poll failed with ${response.status} ${response.statusText}: ${readErrorBody(body)}`,
      );
    }
    return readRecords(body);
  }

  private remember(key: string): void {
    if (this.seen.size >= MAX_SEEN_RECORDS) {
      this.seen.clear();
    }
    this.seen.add(key);
  }
}

export const kafkaProxyTransport = new KafkaProxyTransport();
