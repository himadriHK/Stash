/**
 * Kafka transport over the Confluent REST Proxy. Mirrors
 * Stash.Maui/Services/KafkaRestTransport.cs.
 *
 * - Produce uses the v3 records API (the only produce API that carries Kafka
 *   record headers, which the host trigger requires).
 * - Consume uses the v2 consumer API (JSON values, no record headers).
 */
import { appConfig, kafkaRestUrl } from '../config/appConfig';
import { toBase64 } from '../utils/base64';
import { uuid } from '../utils/id';
import { KafkaConsumerNotFoundException, KafkaTransportException } from './kafkaTransport';
import type {
  KafkaTransport,
  KafkaTransportMessage,
  KafkaTransportRecord,
  RecordHandler,
} from './kafkaTransport';

export { KafkaConsumerNotFoundException, KafkaTransportException };
export type { KafkaTransportMessage, KafkaTransportRecord, RecordHandler };

const JSON_CONTENT_TYPE = 'application/vnd.kafka+json';
const V2_CONTENT_TYPE = 'application/vnd.kafka+json';
const CONSUMER_POLL_TIMEOUT_MS = 10_000;
const CONFIG_ERROR =
  'Kafka REST proxy is not configured. Set Kafka:RestUrl in appsettings.json.';

function truncate(value: string, maxLength = 500): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function sanitize(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned.length === 0 ? 'device' : cleaned;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** v3 record value wrapper: JSON payloads as {type:'JSON'} else {type:'STRING'}. */
function parseJsonValue(value: string): { type: string; data: unknown } {
  try {
    return { type: 'JSON', data: JSON.parse(value) };
  } catch {
    return { type: 'STRING', data: value };
  }
}

export class KafkaRestTransport implements KafkaTransport {
  private clusterId: string | null = null;
  private clusterIdPromise: Promise<string> | null = null;

  private restUrl(): string | null {
    return kafkaRestUrl();
  }

  private timeoutMs(): number {
    const seconds = appConfig.Kafka.RestTimeoutSeconds;
    return (seconds > 0 ? seconds : 30) * 1000;
  }

  private ensureConfigured(): string {
    const base = this.restUrl();
    if (!base) {
      throw new Error(CONFIG_ERROR);
    }
    return base;
  }

  private authHeader(): Record<string, string> {
    const username = appConfig.Kafka.RestUsername;
    if (!username) {
      return {};
    }
    return { Authorization: `Basic ${toBase64(`${username}:${appConfig.Kafka.RestPassword}`)}` };
  }

  private async request(
    url: string,
    init: RequestInit,
    accept: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      return await fetch(url, {
        ...init,
        headers: { Accept: accept, ...this.authHeader(), ...(init.headers ?? {}) },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async produceAsync(message: KafkaTransportMessage): Promise<void> {
    if (!message.topic) {
      throw new Error('A Kafka topic is required.');
    }
    const base = this.ensureConfigured();
    const clusterId = await this.getClusterIdAsync(base);

    const record = {
      key: { type: 'BINARY', data: toBase64(message.key ?? '') },
      value: parseJsonValue(message.value),
      headers: Object.entries(message.headers ?? {}).map(([name, value]) => ({
        name,
        value: toBase64(value ?? ''),
      })),
    };

    const url =
      `${base}v3/clusters/${encodeURIComponent(clusterId)}` +
      `/topics/${encodeURIComponent(message.topic)}/records`;
    const response = await this.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      },
      'application/json',
    );

    const body = await response.text().catch(() => '');
    if (!response.ok) {
      throw new KafkaTransportException(
        `Kafka REST produce failed with ${response.status} ${response.statusText}: ${truncate(body)}`,
      );
    }
    ensureNoRecordError(body);
  }

  /**
   * Consumes records until the signal is aborted. The handler is invoked once
   * per record and should handle its own per-record errors.
   */
  async consumeAsync(
    topic: string,
    groupId: string,
    onRecord: RecordHandler,
    signal: AbortSignal,
  ): Promise<void> {
    if (!topic) {
      throw new Error('A Kafka topic is required.');
    }
    if (!groupId) {
      throw new Error('A consumer group id is required.');
    }
    const base = this.ensureConfigured();

    let consumerUri: string | null = null;
    try {
      while (!signal.aborted) {
        try {
          consumerUri ??= await this.createConsumerAsync(base, groupId, topic);
          const records = await this.pollAsync(consumerUri);
          for (const record of records) {
            if (signal.aborted) {
              break;
            }
            await onRecord(record);
          }
        } catch (error) {
          if (signal.aborted) {
            break;
          }
          if (error instanceof KafkaConsumerNotFoundException) {
            if (consumerUri) {
              await this.deleteConsumerQuietlyAsync(consumerUri);
            }
            consumerUri = null;
            continue;
          }
          console.warn('Kafka REST consume loop failed; recreating the consumer.', error);
          if (consumerUri) {
            await this.deleteConsumerQuietlyAsync(consumerUri);
          }
          consumerUri = null;
          await delay(5000, signal);
        }
      }
    } finally {
      if (consumerUri) {
        await this.deleteConsumerQuietlyAsync(consumerUri);
      }
    }
  }

  private async getClusterIdAsync(base: string): Promise<string> {
    const configured = appConfig.Kafka.ClusterId.trim();
    if (configured) {
      return configured;
    }
    if (this.clusterId) {
      return this.clusterId;
    }

    if (!this.clusterIdPromise) {
      this.clusterIdPromise = (async () => {
        const response = await this.request(`${base}v3/clusters`, { method: 'GET' }, 'application/json');
        const body = await response.text().catch(() => '');
        if (!response.ok) {
          throw new KafkaTransportException(
            `Kafka REST cluster discovery failed with ${response.status}: ${truncate(body)}`,
          );
        }
        try {
          const parsed = JSON.parse(body) as { data?: Array<{ cluster_id?: string }> };
          const clusters = Array.isArray(parsed.data) ? parsed.data : [];
          for (const cluster of clusters) {
            const id = typeof cluster?.cluster_id === 'string' ? cluster.cluster_id.trim() : '';
            if (id) {
              this.clusterId = id;
              return id;
            }
          }
        } catch {
          // Fall through to the explicit configuration error below.
        }
        throw new KafkaTransportException(
          'Kafka REST cluster discovery returned no cluster_id. Set Kafka:ClusterId explicitly.',
        );
      })().catch((error) => {
        // Allow the next produce call to retry discovery.
        this.clusterIdPromise = null;
        throw error;
      });
    }

    return this.clusterIdPromise;
  }

  private async createConsumerAsync(
    base: string,
    groupId: string,
    topic: string,
  ): Promise<string> {
    const instanceName = `stash-mobile-${sanitize(groupId)}-${uuid().replace(/-/g, '')}`;
    const body = await this.sendJsonAsync(
      `${base}consumers/${encodeURIComponent(groupId)}`,
      'POST',
      JSON.stringify({
        name: instanceName,
        format: 'json',
        'auto.offset.reset': 'earliest',
        'auto.commit.enable': 'true',
      }),
      V2_CONTENT_TYPE,
    );

    let baseUri: unknown;
    try {
      baseUri = (JSON.parse(body) as { base_uri?: unknown }).base_uri;
    } catch {
      baseUri = undefined;
    }
    if (typeof baseUri !== 'string' || baseUri.trim().length === 0) {
      throw new KafkaTransportException('Kafka REST consumer creation returned no base_uri.');
    }

    const consumerUri = this.resolveConsumerUri(base, baseUri);
    try {
      await this.sendJsonAsync(
        `${consumerUri}/subscription`,
        'POST',
        JSON.stringify({ topics: [topic] }),
        V2_CONTENT_TYPE,
      );
    } catch (error) {
      await this.deleteConsumerQuietlyAsync(consumerUri);
      throw error;
    }
    return consumerUri;
  }

  private async pollAsync(consumerUri: string): Promise<KafkaTransportRecord[]> {
    const url = `${consumerUri}/records?timeout=${CONSUMER_POLL_TIMEOUT_MS}&max_bytes=1048576`;
    const response = await this.request(url, { method: 'GET' }, JSON_CONTENT_TYPE);

    if (response.status === 204) {
      return [];
    }
    if (response.status === 404) {
      throw new KafkaConsumerNotFoundException();
    }

    const body = await response.text().catch(() => '');
    if (!response.ok) {
      throw new KafkaTransportException(
        `Kafka REST consume failed with ${response.status} ${response.statusText}: ${truncate(body)}`,
      );
    }
    if (!body || body.trim().length === 0) {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) {
      return [];
    }

    const records: KafkaTransportRecord[] = [];
    for (const element of parsed as Array<Record<string, unknown>>) {
      records.push({
        topic: typeof element.topic === 'string' ? element.topic : '',
        key: typeof element.key === 'string' ? element.key : '',
        value: readValue(element),
        headers: readHeaders(element),
      });
    }
    return records;
  }

  private async sendJsonAsync(
    url: string,
    method: string,
    json: string,
    contentType: string,
  ): Promise<string> {
    const response = await this.request(
      url,
      { method, headers: { 'Content-Type': contentType }, body: json },
      contentType,
    );
    const body = await response.text().catch(() => '');
    if (!response.ok) {
      throw new KafkaTransportException(
        `Kafka REST ${method} ${url} failed with ${response.status} ${response.statusText}: ${truncate(body)}`,
      );
    }
    return body;
  }

  private resolveConsumerUri(base: string, baseUri: string): string {
    if (/^https?:\/\//i.test(baseUri)) {
      return baseUri.replace(/\/+$/, '');
    }
    return `${base}${baseUri.replace(/^\/+/, '')}`.replace(/\/+$/, '');
  }

  private async deleteConsumerQuietlyAsync(consumerUri: string): Promise<void> {
    try {
      await this.request(consumerUri, { method: 'DELETE' }, V2_CONTENT_TYPE);
    } catch (error) {
      console.debug('Failed to delete Kafka REST consumer instance.', error);
    }
  }
}

function readValue(record: Record<string, unknown>): string {
  const value = record.value;
  if (value === null || value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function readHeaders(record: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {};
  const raw = record.headers;
  if (!Array.isArray(raw)) {
    return headers;
  }
  for (const entry of raw as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const name = typeof entry.name === 'string' ? entry.name : typeof entry.key === 'string' ? entry.key : '';
    const value = typeof entry.value === 'string' ? entry.value : null;
    if (name && value !== null) {
      headers[name] = value;
    }
  }
  return headers;
}

function ensureNoRecordError(responseBody: string): void {
  if (!responseBody || responseBody.trim().length === 0) {
    return;
  }
  try {
    const parsed = JSON.parse(responseBody) as { error_code?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.error_code === 'number' && parsed.error_code !== 0) {
      throw new KafkaTransportException(
        `Kafka REST produce returned error_code ${parsed.error_code}: ${truncate(responseBody)}`,
      );
    }
  } catch (error) {
    if (error instanceof KafkaTransportException) {
      throw error;
    }
    // A non-JSON success body is not itself a failure.
  }
}

export const kafkaRestTransport = new KafkaRestTransport();
