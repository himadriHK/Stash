/**
 * Mobile response consumer: applies host upload responses to the local file
 * database. Mirrors Stash.Maui/Services/KafkaConsumer.cs.
 *
 * The consumer group is stable per installation (`stash-mobile-{deviceId}`).
 */
import { getOrCreateDeviceIdAsync } from '../auth/authenticationService';
import { appConfig } from '../config/appConfig';
import type { FileRepository } from '../data/fileRepository';
import { parseUploadResponseMessage } from '../models/messages';
import { UploadStatus } from '../models/uploadStatus';
import type { KafkaTransport, KafkaTransportRecord } from './kafkaTransport';

export class KafkaConsumer {
  private abortController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly transport: KafkaTransport,
    private readonly fileRepository: FileRepository,
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

      const completed = response.status.toUpperCase() === 'COMPLETED';
      const failed = response.status.toUpperCase() === 'FAILED';
      if (!completed && !failed) {
        console.warn(
          `Ignoring upload response ${response.messageId} with unsupported status ${response.status}.`,
        );
        return;
      }

      const file = await this.fileRepository.getByContentHashAsync(response.fileId);
      if (!file) {
        console.debug(`Ignoring response for unknown local file ${response.fileId}.`);
        return;
      }

      file.status = completed ? UploadStatus.Completed : UploadStatus.Failed;
      file.permanentPath = response.permanentPath ?? null;
      file.thumbnails = response.thumbnails ?? {};
      file.convertedFormat = response.convertedFormat ?? null;
      file.isDeduplicated = response.deduplicated;
      file.errorMessage = response.error ?? null;
      file.lastAttemptAt = new Date().toISOString();

      await this.fileRepository.updateAsync(file);
      console.info(
        `Applied upload response ${response.messageId} to file ${response.fileId}: ${response.status}.`,
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      console.warn(`Failed to process an upload response from topic ${record.topic}.`, error);
    }
  }
}
