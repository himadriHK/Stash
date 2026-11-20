/**
 * Mobile Kafka producer built on the REST transport. Mirrors
 * Stash.Maui/Services/KafkaProducer.cs + StashHost.Shared IKafkaProducer.
 */
import {
  ensureValidAccessTokenAsync,
  getAccessTokenAsync,
  getOrCreateDeviceIdAsync,
  getUserIdAsync,
} from '../auth/authenticationService';
import { appConfig } from '../config/appConfig';
import type { UploadRequestMessage, UploadResponseMessage } from '../models/messages';
import { uuid } from '../utils/id';
import type { KafkaTransport } from './kafkaTransport';

function createHeaders(): Record<string, string> {
  return { 'X-Message-Version': '1' };
}

export class KafkaProducer {
  constructor(private readonly transport: KafkaTransport) {}

  async produceUploadRequestAsync(message: UploadRequestMessage): Promise<void> {
    if (!message.fileId) {
      throw new Error('Upload requests require a file hash key.');
    }

    const authenticated = await ensureValidAccessTokenAsync();
    const accessToken = authenticated ? await getAccessTokenAsync() : '';
    if (!accessToken) {
      throw new Error('Cannot produce an upload request without an authenticated access token.');
    }

    const deviceId = message.deviceId || (await getOrCreateDeviceIdAsync());
    const userId = message.userId || (await getUserIdAsync());
    const correlationId = message.correlationId || uuid();

    message.deviceId = deviceId;
    message.userId = userId;
    message.correlationId = correlationId;

    const headers = createHeaders();
    headers.Authorization = `Bearer ${accessToken}`;
    headers['X-Correlation-Id'] = correlationId;
    if (deviceId) {
      headers['X-Device-Id'] = deviceId;
    }
    if (userId) {
      headers['X-User-Id'] = userId;
    }

    await this.transport.produceAsync({
      topic: appConfig.Kafka.TopicUploadRequest,
      key: message.fileId,
      value: JSON.stringify(message),
      headers,
    });
  }

  async produceUploadResponseAsync(message: UploadResponseMessage): Promise<void> {
    if (!message.fileId) {
      throw new Error('Upload responses require a file hash key.');
    }
    const headers = createHeaders();
    if (message.correlationId) {
      headers['X-Correlation-Id'] = message.correlationId;
    }
    await this.transport.produceAsync({
      topic: appConfig.Kafka.TopicUploadResponse,
      key: message.fileId,
      value: JSON.stringify(message),
      headers,
    });
  }

  async produceDeadLetterAsync(key: string, payload: string, reason: string): Promise<void> {
    if (!key) {
      throw new Error('A dead letter message requires a key.');
    }
    if (payload === null || payload === undefined) {
      throw new Error('A dead letter message requires a payload.');
    }
    const headers = createHeaders();
    headers['x-dlq-reason'] = reason ?? '';
    await this.transport.produceAsync({
      topic: appConfig.Kafka.TopicDeadLetter,
      key,
      value: payload,
      headers,
    });
  }
}
