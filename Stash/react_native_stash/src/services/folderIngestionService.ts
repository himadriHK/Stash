/**
 * FolderIngestionService - turns a folder scan into deduplicated `Pending`
 * rows. Hashes are cached by URI + size + modified time in `file_hash_cache`,
 * so re-scanning an unchanged folder skips the native digest.
 *
 * Large folders (10k+ files) are the normal case, so this pass is built around
 * batched database work instead of per-file round trips:
 *  - the hash cache and the set of already-tracked content hashes are preloaded
 *    once per folder, then kept in memory;
 *  - rows are inserted in transactional batches;
 *  - hash-cache writes are flushed once per chunk;
 *  - the loop yields between chunks so the UI thread keeps painting.
 */
import type { FileRepository } from '../data/fileRepository';
import type { FolderRepository } from '../data/folderRepository';
import {
  type HashCacheEntry,
  type HashCacheRepository,
  type HashCacheWrite,
} from '../data/hashCacheRepository';
import { createFileEntity, type FileEntity } from '../models/fileEntity';
import type { FolderConfig } from '../models/folderConfig';
import { UploadStatus } from '../models/uploadStatus';
import { logError } from '../utils/errorLogger';
import { forEachChunkedAsync, yieldToEventLoop } from '../utils/cooperative';
import { mimeTypeForFile, type FolderScannerService } from './folderScannerService';

export interface FolderIngestionResult {
  scanned: number;
  discovered: number;
  hashed: number;
  cacheHits: number;
}

export interface FolderIngestionProgress {
  processed: number;
  total: number;
}

export type FolderIngestionProgressHandler = (progress: FolderIngestionProgress) => void;

/** Rows inserted per transaction. Bounds the write burst on large folders. */
const BATCH_SIZE = 25;
/** Files handled per scheduling slice; the loop yields between slices. */
const CHUNK_SIZE = 250;
/** Cached hashes older than this are pruned on each ingestion. */
const HASH_CACHE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function modifiedAtIsoOf(file: { modifiedAtMs?: number | null }): string | null {
  return typeof file.modifiedAtMs === 'number' && Number.isFinite(file.modifiedAtMs)
    ? new Date(file.modifiedAtMs).toISOString()
    : null;
}

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
    onProgress?: FolderIngestionProgressHandler,
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
    let cacheWrites: HashCacheWrite[] = [];

    // Preloaded once: a per-file read would be a bridge round trip per file.
    const cacheByUri = await this.loadHashCacheAsync();
    const knownHashes = await this.loadKnownContentHashesAsync();

    const flushBatchAsync = async (): Promise<void> => {
      if (batch.length === 0) {
        return;
      }
      discovered += await this.fileRepository.addManyAsync(batch);
      batch = [];
    };

    const flushCacheWritesAsync = async (): Promise<void> => {
      if (cacheWrites.length === 0) {
        return;
      }
      const pending = cacheWrites;
      cacheWrites = [];
      try {
        await this.hashCache.putManyAsync(pending);
      } catch (error) {
        // The hash cache is an optimization; a failed write only costs a later
        // re-hash, so it must not fail the ingestion pass.
        await logError('folderIngestion.cacheWrite', error, {
          entries: pending.length,
          folderPath: folder.folderPath,
        });
      }
    };

    try {
      await forEachChunkedAsync(
        scannedFiles,
        async (chunk) => {
          for (const file of chunk) {
            processed += 1;

            const modifiedAtIso = modifiedAtIsoOf(file);
            const cached = cacheByUri.get(file.uri);

            let hash: string | null = null;
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
                const entry: HashCacheEntry = {
                  uri: file.uri,
                  size: file.size,
                  modifiedAt: modifiedAtIso,
                  contentHash: hash,
                  updatedAt: new Date().toISOString(),
                };
                cacheByUri.set(file.uri, entry);
                cacheWrites.push({
                  uri: entry.uri,
                  size: entry.size,
                  modifiedAt: entry.modifiedAt,
                  contentHash: entry.contentHash,
                });
              }
            }

            if (!hash) {
              continue;
            }

            const normalizedHash = hash.toLowerCase();
            if (knownHashes.has(normalizedHash)) {
              continue;
            }
            // Mark before the insert so two files with identical content in the
            // same folder only produce one row.
            knownHashes.add(normalizedHash);

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
              await flushBatchAsync();
            }
          }

          await flushBatchAsync();
          await flushCacheWritesAsync();
          onProgress?.({ processed, total: scannedFiles.length });
        },
        { chunkSize: CHUNK_SIZE },
      );

      await flushBatchAsync();
      await flushCacheWritesAsync();

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
      // Let the UI paint the final progress state before the caller continues.
      await yieldToEventLoop();
    }
  }

  private async loadHashCacheAsync(): Promise<Map<string, HashCacheEntry>> {
    try {
      const entries = await this.hashCache.getAllAsync();
      return new Map(entries.map((entry) => [entry.uri, entry]));
    } catch (error) {
      await logError('folderIngestion.loadHashCache', error);
      return new Map();
    }
  }

  /** Deduplication lookups are preloaded; this keeps the single-file fallback. */
  private async loadKnownContentHashesAsync(): Promise<Set<string>> {
    try {
      return await this.fileRepository.getAllContentHashesAsync();
    } catch (error) {
      await logError('folderIngestion.loadKnownHashes', error);
      return new Set();
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