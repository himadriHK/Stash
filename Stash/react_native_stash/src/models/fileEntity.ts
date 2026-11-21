import { UploadStatus } from './uploadStatus';
import { uuid } from '../utils/id';

/**
 * A local file discovered by the folder scanner and its upload/processing
 * state. Mirrors Stash.Maui.Data/Entities/FileEntity.cs.
 */
export interface FileEntity {
  id: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  /** SHA-256 content hash; the database enforces uniqueness. */
  contentHash: string;
  mimeType: string;
  createdAt: string;
  modifiedAt: string;
  discoveredAt: string;
  status: UploadStatus;
  storageTempPath?: string | null;
  permanentPath?: string | null;
  errorMessage?: string | null;
  retryCount: number;
  lastAttemptAt?: string | null;
  deviceId: string;
  userId: string;
  /** Thumbnail variants keyed by size or variant name (JSON in SQLite). */
  thumbnails: Record<string, string>;
  convertedFormat?: string | null;
  isDeduplicated: boolean;
  /** Phase 0 lifecycle timestamps; written by the Phase 1 lifecycle service. */
  uploadStartedAt?: string | null;
  processingStartedAt?: string | null;
  lastResponseAt?: string | null;
  requestCorrelationId?: string | null;
  requestMessageId?: string | null;
  /** Host-processing retry budget, separate from transfer `retryCount`. */
  hostRetryCount: number;
  nextAttemptAt?: string | null;
  failureStage?: string | null;
  updatedAt?: string | null;
}

export type FileEntityDraft = Partial<FileEntity> &
  Pick<FileEntity, 'fileName' | 'filePath' | 'contentHash'>;

export function createFileEntity(draft: FileEntityDraft): FileEntity {
  const now = new Date().toISOString();
  const discoveredAt = draft.discoveredAt ?? now;
  return {
    id: draft.id ?? uuid(),
    fileName: draft.fileName,
    filePath: draft.filePath,
    fileSize: draft.fileSize ?? 0,
    contentHash: draft.contentHash,
    mimeType: draft.mimeType ?? 'application/octet-stream',
    createdAt: draft.createdAt ?? now,
    modifiedAt: draft.modifiedAt ?? now,
    discoveredAt,
    status: draft.status ?? UploadStatus.Pending,
    storageTempPath: draft.storageTempPath ?? null,
    permanentPath: draft.permanentPath ?? null,
    errorMessage: draft.errorMessage ?? null,
    retryCount: draft.retryCount ?? 0,
    lastAttemptAt: draft.lastAttemptAt ?? null,
    deviceId: draft.deviceId ?? '',
    userId: draft.userId ?? '',
    thumbnails: draft.thumbnails ?? {},
    convertedFormat: draft.convertedFormat ?? null,
    isDeduplicated: draft.isDeduplicated ?? false,
    uploadStartedAt: draft.uploadStartedAt ?? null,
    processingStartedAt: draft.processingStartedAt ?? null,
    lastResponseAt: draft.lastResponseAt ?? null,
    requestCorrelationId: draft.requestCorrelationId ?? null,
    requestMessageId: draft.requestMessageId ?? null,
    hostRetryCount: draft.hostRetryCount ?? 0,
    nextAttemptAt: draft.nextAttemptAt ?? null,
    failureStage: draft.failureStage ?? null,
    updatedAt: draft.updatedAt ?? discoveredAt,
  };
}