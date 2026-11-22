/**
 * Storage abstraction used by the upload/download pipeline.
 *
 * Logical remote paths are app-owned, leading-slash paths (for example
 * `/temp/uploads/<deviceId>/<contentHash>/photo.jpg`). Providers map them onto their own
 * namespace; they never leak provider-specific identifiers to the caller.
 */
export interface StorageUploadSource {
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
  /** Lowercase SHA-256 of the file content; used for dedup and the object key. */
  contentHash?: string;
  /** Cancels an in-flight transfer when aborted. */
  signal?: AbortSignal;
  /** Reports transfer progress when the platform supports it. */
  onProgress?: (bytesSent: number, totalBytes: number) => void;
  /** Overrides the provider's default transfer timeout. */
  timeoutMs?: number;
}

export interface StorageProvider {
  /** Human-readable provider id (`S3`). */
  readonly name: string;
  /** Validates configuration ahead of the first transfer without throwing. */
  warmUpAsync(): Promise<void>;
  /** Uploads a local file and returns the canonical logical remote path. */
  uploadFileAsync(source: StorageUploadSource, remotePath: string): Promise<string>;
  existsAsync(remotePath: string): Promise<boolean>;
  downloadAsync(remotePath: string, destinationUri: string): Promise<string>;
  deleteFileAsync(remotePath: string): Promise<boolean>;
  /** Object size in bytes, or null when it cannot be determined. */
  getFileSizeAsync(remotePath: string): Promise<number | null>;
}
