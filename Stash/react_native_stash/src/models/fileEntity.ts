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
  megaTempPath?: string | null;
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
}

export type FileEntityDraft = Partial<FileEntity> &
  Pick<FileEntity, 'fileName' | 'filePath' | 'contentHash'>;

export function createFileEntity(draft: FileEntityDraft): FileEntity {
  const now = new Date().toISOString();
  return {
    id: draft.id ?? uuid(),
    fileName: draft.fileName,
    filePath: draft.filePath,
    fileSize: draft.fileSize ?? 0,
    contentHash: draft.contentHash,
    mimeType: draft.mimeType ?? 'application/octet-stream',
    createdAt: draft.createdAt ?? now,
    modifiedAt: draft.modifiedAt ?? now,
    discoveredAt: draft.discoveredAt ?? now,
    status: draft.status ?? UploadStatus.Pending,
    megaTempPath: draft.megaTempPath ?? null,
    permanentPath: draft.permanentPath ?? null,
    errorMessage: draft.errorMessage ?? null,
    retryCount: draft.retryCount ?? 0,
    lastAttemptAt: draft.lastAttemptAt ?? null,
    deviceId: draft.deviceId ?? '',
    userId: draft.userId ?? '',
    thumbnails: draft.thumbnails ?? {},
    convertedFormat: draft.convertedFormat ?? null,
    isDeduplicated: draft.isDeduplicated ?? false,
  };
}
