/**
 * Application service wiring (dependency injection), mirroring
 * Stash.Maui/Configuration/ServiceRegistration.cs:
 * repositories -> scanner/mega -> upload manager -> Kafka -> background pass.
 */
import { appConfig, kafkaProxyUrl } from '../config/appConfig';
import { FileRepository } from '../data/fileRepository';
import { FolderRepository } from '../data/folderRepository';
import { BackgroundUploadService } from './backgroundUploadService';
import { BackgroundUploadScheduler } from './backgroundUploadScheduler';
import { folderScannerService } from './folderScannerService';
import { KafkaConsumer } from './kafkaConsumer';
import { KafkaProducer } from './kafkaProducer';
import { kafkaProxyTransport } from './kafkaProxyTransport';
import { kafkaRestTransport } from './kafkaRestTransport';
import type { KafkaTransport } from './kafkaTransport';
import { megaHttpService } from './megaHttpService';
import { UploadManager } from './uploadManager';

export const fileRepository = new FileRepository();
export const folderRepository = new FolderRepository();
export const folderScanner = folderScannerService;

export const megaService = megaHttpService;
export const uploadManager = new UploadManager(megaHttpService, fileRepository);

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
export const kafkaConsumer = new KafkaConsumer(kafkaTransport, fileRepository);

export const backgroundUploadService = new BackgroundUploadService({
  folderRepository,
  scanner: folderScannerService,
  fileRepository,
  uploadManager,
  kafkaProducer,
});

export const backgroundUploadScheduler = new BackgroundUploadScheduler(() =>
  backgroundUploadService.runOnceAsync(),
);
