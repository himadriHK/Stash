/**
 * FolderIngestionService - turns a folder scan into deduplicated `Pending`
 * rows. Hashes are cached by URI + size + modified time in `file_hash_cache`,
 * so re-scanning an unchanged folder skips the native digest. Rows are inserted
 * in transactional batches instead of one statement per file.
 */
import type { FileRepository } from '../data/fileRepository';
import type { FolderRepository } from '../data/folderRepository';
import type { HashCacheEntry, HashCacheRepository } from '../data/hashCacheRepository';
import { createFileEntity, type FileEntity } from '../models/fileEntity';
import type { FolderConfig } from '../models/folderConfig';
import { UploadStatus } from '../models/uploadStatus';
import { logError } from '../utils/errorLogger';
import { yieldToEventLoop } from '../utils/cooperative';
import { mimeTypeForFile, type FolderScannerService } from './folderScannerService';

export interface FolderIngestionResult {
  scanned: number;
  discovered: number;
  hashed: number;
  cacheHits: number;
}

/** Rows inserted per transaction. Bounds the write burst on large folders. */
const BATCH_SIZE = 25;
/** Cooperative yield cadence while processing scanned files. */
const YIELD_INTERVAL = 10;
/** Cached hashes older than this are pruned on each ingestion. */
const HASH_CACHE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class FolderIngestionService {
  constructor(
    private readonly scanner: FolderScannerService,
    private readonly fileRepository: FileRepository,
    private readonly folderRepository: FolderRepository,
    private readonly hashCache: HashCacheRepository,
  ) {}

  async ingestFolderAsync(
    folder: FolderConfig,
    deviceId: string,
    userId: string,
  ): Promise<FolderIngestionResult> {
    // Scan errors are intentionally not caught: the caller decides whether to
    // abort the pass or continue with the next folder.
    const scannedFiles = await this.scanner.scanFolderAsync(folder);

    await this.pruneHashCacheAsync();

    let discovered = 0;
    let hashed = 0;
    let cacheHits = 0;
    let processed = 0;
    let batch: FileEntity[] = [];

    const flushAsync = async (): Promise<void> => {
      if (batch.length === 0) {
        return;
      }
      discovered += await this.fileRepository.addManyAsync(batch);
      batch = [];
    };

    try {
      for (const file of scannedFiles) {
        processed += 1;
        if (processed % YIELD_INTERVAL === 0) {
          await yieldToEventLoop();
        }

        const modifiedAtMs =
          typeof file.modifiedAtMs === 'number' && Number.isFinite(file.modifiedAtMs)
            ? file.modifiedAtMs
            : null;
        const modifiedAtIso = modifiedAtMs !== null ? new Date(modifiedAtMs).toISOString() : null;

        let hash: string | null = null;
        const cached = await this.getCachedHashAsync(file.uri);

        if (
          cached &&
          cached.size === file.size &&
          modifiedAtIso !== null &&
          cached.modifiedAt === modifiedAtIso
        ) {
          hash = cached.contentHash;
          cacheHits += 1;
        } else {
          try {
            hash = await this.scanner.computeFileHashAsync(file.uri, file.size);
          } catch (error) {
            await logError('folderIngestion.hash', error, {
              uri: file.uri,
              folderPath: folder.folderPath,
            });
            continue;
          }

          if (!hash) {
            continue;
          }
          hashed += 1;

          if (modifiedAtIso !== null) {
            await this.storeCachedHashAsync(file.uri, file.size, modifiedAtIso, hash);
          }
        }

        if (!hash) {
          continue;
        }
        if (await this.fileRepository.existsByContentHashAsync(hash)) {
          continue;
        }

        batch.push(
          createFileEntity({
            fileName: file.name,
            filePath: file.uri,
            fileSize: file.size,
            contentHash: hash,
            mimeType: mimeTypeForFile(file.name),
            createdAt: file.createdAt,
            modifiedAt: file.modifiedAt,
            deviceId,
            userId,
            status: UploadStatus.Pending,
          }),
        );

        if (batch.length >= BATCH_SIZE) {
          await flushAsync();
        }
      }

      await flushAsync();

      // Preserve the previous one-stamp-per-scan behavior; update errors are
      // surfaced to the caller.
      folder.lastScannedAt = new Date().toISOString();
      await this.folderRepository.updateAsync(folder);

      return {
        scanned: scannedFiles.length,
        discovered,
        hashed,
        cacheHits,
      };
    } finally {
      await this.pruneHashCacheAsync();
    }
  }

  /** Hash-cache reads are an optimization; a cache failure must not block ingestion. */
  private async getCachedHashAsync(uri: string): Promise<HashCacheEntry | null> {
    try {
      return await this.hashCache.getAsync(uri);
    } catch (error) {
      console.warn('[folderIngestion] Could not read the hash cache.', error);
      return null;
    }
  }

  private async storeCachedHashAsync(
    uri: string,
    size: number,
    modifiedAt: string,
    contentHash: string,
  ): Promise<void> {
    try {
      await this.hashCache.putAsync({ uri, size, modifiedAt, contentHash });
    } catch (error) {
      console.warn('[folderIngestion] Could not update the hash cache.', error);
    }
  }

  private async pruneHashCacheAsync(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - HASH_CACHE_RETENTION_MS).toISOString();
      await this.hashCache.pruneAsync(cutoff);
    } catch (error) {
      console.warn('[folderIngestion] Could not prune the hash cache.', error);
    }
  }
}