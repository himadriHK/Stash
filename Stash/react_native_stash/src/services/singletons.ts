/**
 * Application service wiring (dependency injection), mirroring
 * Stash.Maui/Configuration/ServiceRegistration.cs:
 * repositories -> lifecycle/outbox -> scanner/storage -> upload manager ->
 * Kafka -> background pass.
 */
import { appConfig, kafkaProxyUrl } from '../config/appConfig';
import { FileRepository } from '../data/fileRepository';
import { FolderRepository } from '../data/folderRepository';
import { HashCacheRepository } from '../data/hashCacheRepository';
import { OutboxRepository } from '../data/outboxRepository';
import { BackgroundUploadService } from './backgroundUploadService';
import { BackgroundUploadScheduler } from './backgroundUploadScheduler';
import { FileLifecycleService } from './fileLifecycleService';
import { FolderIngestionService } from './folderIngestionService';
import { folderScannerService } from './folderScannerService';
import { KafkaConsumer } from './kafkaConsumer';
import { KafkaProducer } from './kafkaProducer';
import { kafkaProxyTransport } from './kafkaProxyTransport';
import { kafkaRestTransport } from './kafkaRestTransport';
import type { KafkaTransport } from './kafkaTransport';
import { OutboxPublisher } from './outboxPublisher';
import { createStorageProvider } from './storage/storageProviderFactory';
import { UploadManager } from './uploadManager';

export const fileRepository = new FileRepository();
export const folderRepository = new FolderRepository();
export const hashCacheRepository = new HashCacheRepository();
export const folderScanner = folderScannerService;
export const folderIngestionService = new FolderIngestionService(
  folderScannerService,
  fileRepository,
  folderRepository,
  hashCacheRepository,
);

/**
 * The proxy is the supported production path (no broker credentials on the
 * device, and polling instead of a long-lived REST consumer). The direct REST
 * transport stays available for local/dev setups.
 */
function selectKafkaTransport(): KafkaTransport {
  if (appConfig.Kafka.Proxy.Enabled && kafkaProxyUrl()) {
    return kafkaProxyTransport;
  }
  return kafkaRestTransport;
}

export const kafkaTransport: KafkaTransport = selectKafkaTransport();
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
