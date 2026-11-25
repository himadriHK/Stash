/**
 * FolderIngestionService - turns a folder scan into deduplicated `Pending`
 * rows.
 *
 * Identity is metadata only: the normalised file name (`computeMetadataHash`).
 * No file content is read during a scan, so a 10k-file pass never touches the
 * native digest path; the host recomputes a SHA-256 of the bytes it downloads
 * and deduplicates on that, so byte-identical files from another folder or
 * another device still collapse there.
 *
 * Large folders are the normal case, so this pass is built around batched
 * database work instead of per-file round trips:
 *  - the set of already-tracked metadata hashes is preloaded once per folder;
 *  - rows are inserted in transactional batches;
 *  - the loop yields between chunks so the UI thread keeps painting.
 */
import type { FileRepository } from '../data/fileRepository';
import type { FolderRepository } from '../data/folderRepository';
import { createFileEntity, type FileEntity } from '../models/fileEntity';
import type { FolderConfig } from '../models/folderConfig';
import { UploadStatus } from '../models/uploadStatus';
import { logError } from '../utils/errorLogger';
import { computeMetadataHash } from '../utils/fileIdentity';
import { forEachChunkedAsync, yieldToEventLoop } from '../utils/cooperative';
import { profileAsync } from '../utils/profiler';
import { mimeTypeForFile, type FolderScannerService } from './folderScannerService';

export interface FolderIngestionResult {
  scanned: number;
  discovered: number;
  /** Scanned files skipped because their name is already tracked. */
  duplicates: number;
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

export class FolderIngestionService {
  constructor(
    private readonly scanner: FolderScannerService,
    private readonly fileRepository: FileRepository,
    private readonly folderRepository: FolderRepository,
  ) {}

  async ingestFolderAsync(
    folder: FolderConfig,
    deviceId: string,
    userId: string,
    onProgress?: FolderIngestionProgressHandler,
  ): Promise<FolderIngestionResult> {
    return profileAsync(
      'folder.ingest',
      () => this.ingestFolderInnerAsync(folder, deviceId, userId, onProgress),
      { attrs: { folderPath: folder.folderPath } },
    );
  }

  private async ingestFolderInnerAsync(
    folder: FolderConfig,
    deviceId: string,
    userId: string,
    onProgress?: FolderIngestionProgressHandler,
  ): Promise<FolderIngestionResult> {
    // Scan errors are intentionally not caught: the caller decides whether to
    // abort the pass or continue with the next folder.
    const scannedFiles = await this.scanner.scanFolderAsync(folder);

    let discovered = 0;
    let duplicates = 0;
    let processed = 0;
    let batch: FileEntity[] = [];

    // Preloaded once: a per-file read would be a bridge round trip per file.
    const knownMetadata = await this.loadKnownMetadataHashesAsync();

    const flushBatchAsync = async (): Promise<void> => {
      if (batch.length === 0) {
        return;
      }
      discovered += await this.fileRepository.addManyAsync(batch);
      batch = [];
    };

    try {
      await forEachChunkedAsync(
        scannedFiles,
        async (chunk) => {
          for (const file of chunk) {
            processed += 1;

            const metadataHash = await computeMetadataHash(file.name);
            if (knownMetadata.has(metadataHash)) {
              duplicates += 1;
              continue;
            }
            // Mark before the insert so two files with the same name in the
            // same folder only produce one row.
            knownMetadata.add(metadataHash);

            batch.push(
              createFileEntity({
                fileName: file.name,
                filePath: file.uri,
                metadataHash,
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
          onProgress?.({ processed, total: scannedFiles.length });
        },
        { chunkSize: CHUNK_SIZE },
      );

      await flushBatchAsync();

      // Preserve the previous one-stamp-per-scan behavior; update errors are
      // surfaced to the caller.
      folder.lastScannedAt = new Date().toISOString();
      await this.folderRepository.updateAsync(folder);

      return {
        scanned: scannedFiles.length,
        discovered,
        duplicates,
      };
    } finally {
      // Let the UI paint the final progress state before the caller continues.
      await yieldToEventLoop();
    }
  }

  /** Deduplication lookups are preloaded; this keeps the single-file fallback. */
  private async loadKnownMetadataHashesAsync(): Promise<Set<string>> {
    try {
      return await this.fileRepository.getAllMetadataHashesAsync();
    } catch (error) {
      await logError('folderIngestion.loadKnownHashes', error);
      return new Set();
    }
  }
}
