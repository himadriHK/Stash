/**
 * S3 implementation of the app's StorageProvider contract.
 *
 * The app only stores logical leading-slash paths; this service maps them to
 * bucket keys (optional prefix) and performs requests through short-lived
 * presigned URLs. Credentials never leave the device except as a signature.
 */
import type { S3Config } from '../../config/appConfig';
import { logError } from '../../utils/errorLogger';
import { presignS3Url } from './s3Signing';
import { downloadFromPresignedUrlAsync, putFileToPresignedUrlAsync } from './s3Transfer';
import type { StorageProvider, StorageUploadSource } from './storageProvider';

const MIN_PRESIGN_EXPIRY_SECONDS = 1;
const MAX_PRESIGN_EXPIRY_SECONDS = 604800;
const DEFAULT_PRESIGN_EXPIRY_SECONDS = 3600;

const NOT_CONFIGURED_MESSAGE =
  'Amazon S3 is not configured. Set Storage.S3.Bucket, Region, AccessKeyId and SecretAccessKey (or the EXPO_PUBLIC_S3_* variables in .env).';

interface ResolvedS3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  endpoint: string;
  forcePathStyle: boolean;
  prefix: string;
  presignExpirySeconds: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Strips presigned credentials from text so logs never expose them. */
function redactCredentials(value: string): string {
  return value.replace(
    /(X-Amz-(?:Signature|Security-Token))=([^&\s"'<>]+)/gi,
    '$1=[redacted]',
  );
}

function redactError(error: unknown): unknown {
  if (error instanceof Error) {
    const message = redactCredentials(error.message);
    return message === error.message ? error : new Error(`${error.name}: ${message}`);
  }
  if (typeof error === 'string') {
    return redactCredentials(error);
  }
  return error;
}

function snippetOf(body: string): string {
  return body.length > 300 ? `${body.slice(0, 300)}...` : body;
}

async function responseSnippetAsync(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text ? snippetOf(text) : '(no response body)';
  } catch {
    return '(no response body)';
  }
}

async function fetchS3Async(url: string, method: 'GET' | 'HEAD' | 'DELETE'): Promise<Response> {
  try {
    return await fetch(url, { method });
  } catch (error) {
    throw new Error(`S3 ${method} request failed: ${messageOf(error)}`);
  }
}

function clampExpirySeconds(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_PRESIGN_EXPIRY_SECONDS;
  }
  return Math.min(
    MAX_PRESIGN_EXPIRY_SECONDS,
    Math.max(MIN_PRESIGN_EXPIRY_SECONDS, Math.trunc(value)),
  );
}

export class S3StorageService implements StorageProvider {
  readonly name = 'S3';

  constructor(private readonly config: S3Config) {}

  /**
   * Validates the configuration eagerly so a misconfigured build surfaces at
   * startup. Like the previous provider, failures are logged and swallowed.
   */
  async warmUpAsync(): Promise<void> {
    try {
      const config = this.resolve();
      console.log(
        `[s3] provider S3, bucket ${config.bucket}, region ${config.region}, endpoint ${
          config.endpoint || 'AWS'
        }, path-style ${config.forcePathStyle ? 'on' : 'off'}`,
      );
    } catch (error) {
      await logError('s3.warmup', redactError(error));
    }
  }

  async uploadFileAsync(source: StorageUploadSource, remotePath: string): Promise<string> {
    try {
      const config = this.resolve();
      if (source.size === 0) {
        throw new Error('Cannot upload an empty file (0 bytes) to S3.');
      }
      const canonicalPath = this.normalizeRemotePath(remotePath);
      // The key contains the content hash, so an existing object already holds
      // these exact bytes. A HEAD failure (permissions, network) is ignored and
      // the PUT still runs.
      try {
        if (await this.existsAsync(canonicalPath)) {
          return canonicalPath;
        }
      } catch {
        // Fall through to the upload path.
      }
      const url = this.presign(config, 'PUT', this.keyFor(canonicalPath));
      await putFileToPresignedUrlAsync(url, source);
      return canonicalPath;
    } catch (error) {
      await logError('s3.upload', redactError(error), { remotePath, name: source.name, size: source.size });
      throw error;
    }
  }

  async existsAsync(remotePath: string): Promise<boolean> {
    try {
      const config = this.resolve();
      const response = await fetchS3Async(
        this.presign(config, 'HEAD', this.keyFor(remotePath)),
        'HEAD',
      );
      if (response.status === 200 || response.status === 204) {
        return true;
      }
      if (response.status === 404) {
        return false;
      }
      throw new Error(
        `S3 HEAD failed (HTTP ${response.status}): ${await responseSnippetAsync(response)}`,
      );
    } catch (error) {
      await logError('s3.exists', redactError(error), { remotePath });
      throw error;
    }
  }

  async downloadAsync(remotePath: string, destinationUri: string): Promise<string> {
    try {
      const config = this.resolve();
      const url = this.presign(config, 'GET', this.keyFor(remotePath));
      return await downloadFromPresignedUrlAsync(url, destinationUri);
    } catch (error) {
      await logError('s3.download', redactError(error), { remotePath, destinationUri });
      throw error;
    }
  }

  async deleteFileAsync(remotePath: string): Promise<boolean> {
    try {
      const config = this.resolve();
      const response = await fetchS3Async(
        this.presign(config, 'DELETE', this.keyFor(remotePath)),
        'DELETE',
      );
      if (response.status === 200 || response.status === 204) {
        return true;
      }
      if (response.status === 404) {
        return false;
      }
      throw new Error(
        `S3 DELETE failed (HTTP ${response.status}): ${await responseSnippetAsync(response)}`,
      );
    } catch (error) {
      await logError('s3.delete', redactError(error), { remotePath });
      throw error;
    }
  }

  async getFileSizeAsync(remotePath: string): Promise<number | null> {
    try {
      const config = this.resolve();
      const response = await fetchS3Async(
        this.presign(config, 'HEAD', this.keyFor(remotePath)),
        'HEAD',
      );
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(
          `S3 HEAD failed (HTTP ${response.status}): ${await responseSnippetAsync(response)}`,
        );
      }
      const header = response.headers.get('content-length');
      if (header === null) {
        return null;
      }
      const size = Number(header);
      return Number.isFinite(size) ? size : null;
    } catch (error) {
      await logError('s3.head', redactError(error), { remotePath });
      throw error;
    }
  }

  /** Validates required settings and normalizes optional ones for a request. */
  private resolve(): ResolvedS3Config {
    const bucket = (this.config.Bucket || '').trim();
    const region = (this.config.Region || '').trim();
    const accessKeyId = (this.config.AccessKeyId || '').trim();
    const secretAccessKey = (this.config.SecretAccessKey || '').trim();
    if (!bucket || !region || !accessKeyId || !secretAccessKey) {
      throw new Error(NOT_CONFIGURED_MESSAGE);
    }

    const endpoint = (this.config.Endpoint || '').trim();
    if (endpoint && !/^https?:\/\//i.test(endpoint)) {
      throw new Error(
        `Invalid S3 endpoint "${endpoint}": it must start with http:// or https://.`,
      );
    }

    return {
      bucket,
      region,
      accessKeyId,
      secretAccessKey,
      sessionToken: (this.config.SessionToken || '').trim(),
      endpoint,
      forcePathStyle: this.config.ForcePathStyle === true,
      prefix: (this.config.Prefix || '').replace(/^\/+|\/+$/g, ''),
      presignExpirySeconds: clampExpirySeconds(this.config.PresignExpirySeconds),
    };
  }

  /**
   * Canonical logical path: forward slashes, no empty/`.` segments, leading
   * slash, no trailing slash. `..` is rejected so a path cannot escape itself.
   */
  private normalizeRemotePath(remotePath: string): string {
    const segments = remotePath.replace(/\\/g, '/').split('/');
    const cleaned: string[] = [];
    for (const segment of segments) {
      if (segment === '' || segment === '.') {
        continue;
      }
      if (segment === '..') {
        throw new Error(
          `Invalid S3 path "${remotePath}": parent segments ("..") are not allowed.`,
        );
      }
      cleaned.push(segment);
    }
    if (cleaned.length === 0) {
      throw new Error('A non-empty remote storage path is required.');
    }
    return `/${cleaned.join('/')}`;
  }

  /** Maps a logical path to a bucket key, applying the optional prefix. */
  private keyFor(remotePath: string): string {
    const path = this.normalizeRemotePath(remotePath).replace(/^\/+/, '');
    const prefix = (this.config.Prefix || '').replace(/^\/+|\/+$/g, '');
    return prefix ? `${prefix}/${path}` : path;
  }

  private presign(
    config: ResolvedS3Config,
    method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
    key: string,
  ): string {
    return presignS3Url(
      {
        Bucket: config.bucket,
        Region: config.region,
        AccessKeyId: config.accessKeyId,
        SecretAccessKey: config.secretAccessKey,
        SessionToken: config.sessionToken,
        Endpoint: config.endpoint,
        ForcePathStyle: config.forcePathStyle,
      },
      method,
      key,
      config.presignExpirySeconds,
      new Date(),
    );
  }
}
