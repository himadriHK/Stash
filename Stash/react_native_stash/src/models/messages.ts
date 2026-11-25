/**
 * Kafka message contracts transcribed from StashHost.Shared/Messages/Messages.cs.
 * Serialization is camelCase JSON (System.Text.Json Web defaults in the .NET
 * app; JSON.stringify here produces the same shape).
 */
import type { FileEntity } from './fileEntity';
import { computeUploadFileIdForFile } from '../utils/fileIdentity';
import { uuid } from '../utils/id';

export interface FileMetadata {
  createdAt: string;
  modifiedAt: string;
}

export interface UploadRequestMessage {
  messageId: string;
  timestamp: string;
  /**
   * Client file identifier (the row GUID salted with the metadata hash) - also
   * used as the Kafka record key. It is not a content hash: the host computes
   * the content hash itself and deduplicates on that.
   */
  fileId: string;
  fileName: string;
  mimeType: string;
  storageTempPath: string;
  storageProvider: string;
  metadata?: FileMetadata | null;
  deviceId: string;
  userId: string;
  correlationId: string;
  version: number;
}

export interface UploadResponseMessage {
  messageId: string;
  timestamp: string;
  fileId: string;
  /** 'COMPLETED' | 'FAILED' */
  status: string;
  permanentPath?: string | null;
  thumbnails: Record<string, string>;
  convertedFormat?: string | null;
  deduplicated: boolean;
  processingTimeMs: number;
  error?: string | null;
  correlationId: string;
  deviceId?: string;
  userId?: string;
  version: number;
}

export async function createUploadRequestMessage(
  file: FileEntity,
  deviceId: string,
  userId: string,
  storageProvider: string,
): Promise<UploadRequestMessage> {
  return {
    messageId: uuid(),
    timestamp: new Date().toISOString(),
    fileId: await computeUploadFileIdForFile(file),
    fileName: file.fileName,
    mimeType: file.mimeType,
    storageTempPath: file.storageTempPath ?? '',
    storageProvider,
    metadata: {
      createdAt: file.createdAt,
      modifiedAt: file.modifiedAt,
    },
    deviceId: file.deviceId || deviceId,
    userId: file.userId || userId,
    correlationId: uuid(),
    version: 2,
  };
}

export function parseUploadResponseMessage(raw: string): UploadResponseMessage | null {
  try {
    const parsed = JSON.parse(raw) as Partial<UploadResponseMessage>;
    if (!parsed || typeof parsed.fileId !== 'string' || parsed.fileId.length === 0) {
      return null;
    }
    return {
      messageId: parsed.messageId ?? uuid(),
      timestamp: parsed.timestamp ?? new Date().toISOString(),
      fileId: parsed.fileId,
      status: parsed.status ?? '',
      permanentPath: parsed.permanentPath ?? null,
      thumbnails: parsed.thumbnails ?? {},
      convertedFormat: parsed.convertedFormat ?? null,
      deduplicated: parsed.deduplicated ?? false,
      processingTimeMs: parsed.processingTimeMs ?? 0,
      error: parsed.error ?? null,
      correlationId: parsed.correlationId ?? '',
      deviceId: typeof parsed.deviceId === 'string' ? parsed.deviceId : undefined,
      userId: typeof parsed.userId === 'string' ? parsed.userId : undefined,
      version: parsed.version ?? 1,
    };
  } catch {
    return null;
  }
}
