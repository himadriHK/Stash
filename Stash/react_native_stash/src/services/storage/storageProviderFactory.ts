import type { StorageConfig } from '../../config/appConfig';
import { S3StorageService } from './s3StorageService';
import type { StorageProvider } from './storageProvider';

/**
 * Builds the configured storage provider.
 *
 * Only `S3` is supported (matched case-insensitively); anything else fails
 * fast so a bad config cannot silently disable uploads.
 */
export function createStorageProvider(config: StorageConfig): StorageProvider {
  const provider = (config.Provider || '').trim();
  if (provider.toLowerCase() === 's3') {
    return new S3StorageService(config.S3);
  }
  throw new Error(`Unsupported storage provider '${config.Provider}'. Supported providers: S3.`);
}