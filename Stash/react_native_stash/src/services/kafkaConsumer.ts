/**
 * Mobile response consumer: applies host upload responses to the local file
 * database through the lifecycle service. Mirrors
 * Stash.Maui/Services/KafkaConsumer.cs.
 *
 * The consumer group is stable per installation (`stash-mobile-{deviceId}`).
 */
import { getOrCreateDeviceIdAsync } from '../auth/authenticationService';
import { appConfig } from '../config/appConfig';
import type { FileRepository } from '../data/fileRepository';
import { parseUploadResponseMessage } from '../models/messages';
import type { FileLifecycleService } from './fileLifecycleService';
import type { KafkaTransport, KafkaTransportRecord } from './kafkaTransport';
import { recordConsumerRecord } from './runtimeState';

export class KafkaConsumer {
  private abortController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly transport: KafkaTransport,
    private readonly fileRepository: FileRepository,
    private readonly lifecycle: FileLifecycleService,
  ) {}

  /** Runs the consume loop until the given signal is aborted. */
  async consumeUploadResponsesAsync(signal: AbortSignal): Promise<void> {
    const deviceId = await getOrCreateDeviceIdAsync();
    if (!deviceId) {
      throw new Error('Cannot consume upload responses without a stable device identifier.');
    }
    const groupId = `stash-mobile-${deviceId}`;
    await this.transport.consumeAsync(
      appConfig.Kafka.TopicUploadResponse,
      groupId,
      (record) => this.handleRecordAsync(record),
      signal,
    );
  }

  start(): void {
    if (this.loopPromise) {
      return;
    }
    this.abortController = new AbortController();
    const controller = this.abortController;
    this.loopPromise = this.consumeUploadResponsesAsync(controller.signal).catch((error) => {
      if (!controller.signal.aborted) {
        console.warn('Kafka consumer loop stopped with an error.', error);
      }
    });
  }

  async stop(): Promise<void> {
    const controller = this.abortController;
    const loop = this.loopPromise;
    this.abortController = null;
    this.loopPromise = null;
    if (!controller) {
      return;
    }
    controller.abort();
    if (loop) {
      try {
        await loop;
      } catch (error) {
        console.warn('Kafka consumer loop stopped with an error.', error);
      }
    }
  }

  get isRunning(): boolean {
    return this.loopPromise !== null;
  }

  private async handleRecordAsync(record: KafkaTransportRecord): Promise<void> {
    try {
      const response = parseUploadResponseMessage(record.value);
      if (!response || !response.fileId) {
        console.warn('Ignoring a malformed upload response.');
        return;
      }

      const status = response.status.toUpperCase();
      if (status !== 'COMPLETED' && status !== 'FAILED') {
        console.warn(
          `Ignoring upload response ${response.messageId} with unsupported status ${response.status}.`,
        );
        return;
      }

      const maxRetries = Math.max(0, Math.floor(appConfig.UploadSettings.MaxRetries));
      const outcome = await this.lifecycle.applyResponseAsync(response, maxRetries);
      switch (outcome) {
        case 'applied':
          console.info(
            `Applied upload response ${response.messageId} to file ${response.fileId}: ${status}.`,
          );
          break;
        case 'duplicate':
          console.debug(`Ignoring duplicate upload response ${response.messageId}.`);
          break;
        case 'mismatch':
          console.warn(
            `Ignoring upload response ${response.messageId}: identity or correlation mismatch for ${response.fileId}.`,
          );
          break;
        case 'stale':
          console.debug(
            `Ignoring stale upload response ${response.messageId} for ${response.fileId}.`,
          );
          break;
        default:
          console.debug(
            `Ignoring upload response ${response.messageId} for ${response.fileId}: ${outcome}.`,
          );
          break;
      }

      // A record was accepted and handled (applied, duplicate, stale or
      // ignored); surface the latest handling time in diagnostics.
      recordConsumerRecord();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      console.warn(`Failed to process an upload response from topic ${record.topic}.`, error);
    }
  }
}
