/**
 * Application service wiring (dependency injection), mirroring
 * Stash.Maui/Configuration/ServiceRegistration.cs:
 * repositories -> lifecycle/outbox -> scanner/storage -> upload manager ->
 * Kafka -> background pass.
 */
import { appConfig } from '../config/appConfig';
import { FileRepository } from '../data/fileRepository';
import { FolderRepository } from '../data/folderRepository';
import { OutboxRepository } from '../data/outboxRepository';
import { BackgroundUploadService } from './backgroundUploadService';
import { BackgroundUploadScheduler } from './backgroundUploadScheduler';
import { FileLifecycleService } from './fileLifecycleService';
import { FolderIngestionService } from './folderIngestionService';
import { folderScannerService } from './folderScannerService';
import { KafkaConsumer } from './kafkaConsumer';
import { KafkaProducer } from './kafkaProducer';
import { kafkaProxyTransport } from './kafkaProxyTransport';
import type { KafkaTransport } from './kafkaTransport';
import { OutboxPublisher } from './outboxPublisher';
import { createStorageProvider } from './storage/storageProviderFactory';
import { UploadManager } from './uploadManager';

export const fileRepository = new FileRepository();
export const folderRepository = new FolderRepository();
export const folderScanner = folderScannerService;
export const folderIngestionService = new FolderIngestionService(
  folderScannerService,
  fileRepository,
  folderRepository,
);

/** Kafka traffic always goes through the Stash Kafka proxy (no broker credentials on the device). */
export const kafkaTransport: KafkaTransport = kafkaProxyTransport;
export const kafkaProducer = new KafkaProducer(kafkaTransport);
export const fileLifecycleService = new FileLifecycleService();
export const outboxRepository = new OutboxRepository();
export const outboxPublisher = new OutboxPublisher(
  outboxRepository,
  fileRepository,
  kafkaProducer,
  fileLifecycleService,
);
export const kafkaConsumer = new KafkaConsumer(kafkaTransport, fileRepository, fileLifecycleService);

export const storageProvider = createStorageProvider(appConfig.Storage);
export const uploadManager = new UploadManager(storageProvider, fileRepository, fileLifecycleService);

export const backgroundUploadService = new BackgroundUploadService({
  folderRepository,
  fileRepository,
  uploadManager,
  lifecycle: fileLifecycleService,
  outboxPublisher,
  kafkaProducer,
  folderIngestion: folderIngestionService,
});

export const backgroundUploadScheduler = new BackgroundUploadScheduler(() =>
  backgroundUploadService.runOnceAsync(),
);
