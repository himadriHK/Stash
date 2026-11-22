import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Readable } from 'node:stream';

import type { AppEnv } from '../config/env';
import { buildS3Key } from './paths';

export interface S3ObjectHead {
  contentLength: number | null;
  contentType: string | null;
  etag: string | null;
}

export interface S3ObjectStream extends S3ObjectHead {
  stream: Readable;
}

export interface S3ObjectSummary {
  key: string;
  size: number;
  lastModified: Date | null;
}

const LIST_PAGE_SIZE = 1_000;
const LIST_MAX_OBJECTS_DEFAULT = 2_000;

export type S3ErrorCode =
  | 'S3_NOT_FOUND'
  | 'S3_ACCESS_DENIED'
  | 'S3_TRANSIENT'
  | 'S3_ABORTED'
  | 'S3_NO_BODY'
  | 'S3_ERROR';

export class S3Error extends Error {
  readonly code: S3ErrorCode;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { code?: S3ErrorCode; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'S3Error';
    this.code = options.code ?? 'S3_ERROR';
    this.retryable = options.retryable ?? false;
  }
}

export class S3NotFoundError extends S3Error {
  constructor(message = 'S3 object was not found', cause?: unknown) {
    super(message, { code: 'S3_NOT_FOUND', retryable: false, cause });
    this.name = 'S3NotFoundError';
  }
}

export class S3AccessError extends S3Error {
  constructor(message = 'S3 access was denied', cause?: unknown) {
    super(message, { code: 'S3_ACCESS_DENIED', retryable: false, cause });
    this.name = 'S3AccessError';
  }
}

export class S3TransientError extends S3Error {
  constructor(message = 'S3 request failed temporarily', cause?: unknown) {
    super(message, { code: 'S3_TRANSIENT', retryable: true, cause });
    this.name = 'S3TransientError';
  }
}

interface AwsErrorLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  statusCode?: unknown;
  $metadata?: { httpStatusCode?: unknown };
}

const NOT_FOUND_CODES = new Set(['NotFound', 'NoSuchKey', 'NoSuchBucket', '404']);
const ACCESS_DENIED_CODES = new Set(['Forbidden', 'AccessDenied', 'AccessDeniedException', '403']);
const TRANSIENT_CODES = new Set([
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
  'NetworkingError',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  '429',
  'SlowDown',
  'ServiceUnavailable',
]);

function readString(error: AwsErrorLike, key: 'name' | 'code'): string | null {
  const value = error[key];
  return typeof value === 'string' ? value : null;
}

function readStatus(error: AwsErrorLike): number | null {
  const status = error.$metadata?.httpStatusCode ?? error.statusCode;
  return typeof status === 'number' ? status : null;
}

/**
 * Converts an unknown AWS/transport error into a safe typed S3 error. Messages
 * never include credentials, authorization headers, or presigned URLs.
 */
export function classifyS3Error(error: unknown): S3Error {
  if (error instanceof S3Error) return error;

  if (typeof error !== 'object' || error === null) {
    return new S3Error('S3 request failed', { code: 'S3_ERROR', cause: error });
  }

  const candidate = error as AwsErrorLike;
  const name = readString(candidate, 'name');
  const code = readString(candidate, 'code');
  const status = readStatus(candidate);
  const identifiers = [name, code].filter((value): value is string => Boolean(value));

  if (name === 'AbortError') {
    return new S3Error('S3 request was aborted', { code: 'S3_ABORTED', cause: error });
  }

  if (status === 404 || identifiers.some((value) => NOT_FOUND_CODES.has(value))) {
    return new S3NotFoundError('S3 object was not found', error);
  }

  if (status === 403 || identifiers.some((value) => ACCESS_DENIED_CODES.has(value))) {
    return new S3AccessError('S3 access was denied', error);
  }

  if (
    status === 429 ||
    (status !== null && status >= 500 && status <= 599) ||
    identifiers.some((value) => TRANSIENT_CODES.has(value))
  ) {
    return new S3TransientError('S3 request failed temporarily', error);
  }

  return new S3Error('S3 request failed', { code: 'S3_ERROR', cause: error });
}

export interface S3StorageOptions {
  client?: S3Client;
}

/**
 * S3 staging adapter. S3 is used only for temporary upload staging; the
 * permanent library is written locally by LocalLibrary.
 */
export class S3Storage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(env: AppEnv, options: S3StorageOptions = {}) {
    this.bucket = env.S3_BUCKET ?? '';
    this.prefix = env.S3_PREFIX ?? '';
    this.client =
      options.client ??
      new S3Client({
        region: env.S3_REGION,
        ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
        ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
          ? {
              credentials: {
                accessKeyId: env.S3_ACCESS_KEY_ID,
                secretAccessKey: env.S3_SECRET_ACCESS_KEY,
                ...(env.S3_SESSION_TOKEN ? { sessionToken: env.S3_SESSION_TOKEN } : {}),
              },
            }
          : {}),
        requestHandler: new NodeHttpHandler({
          requestTimeout: env.S3_REQUEST_TIMEOUT_MS,
          connectionTimeout: Math.min(env.S3_REQUEST_TIMEOUT_MS, 10_000),
        }),
      });
  }

  keyForLogicalPath(logicalPath: string): string {
    return buildS3Key(logicalPath, this.prefix);
  }

  async headBucket(signal?: AbortSignal): Promise<void> {
    this.assertBucket();
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), {
        abortSignal: signal,
      });
    } catch (error) {
      throw classifyS3Error(error);
    }
  }

  async headObject(key: string, signal?: AbortSignal): Promise<S3ObjectHead | null> {
    this.assertBucket();
    try {
      const output = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: signal },
      );
      return {
        contentLength: output.ContentLength ?? null,
        contentType: output.ContentType ?? null,
        etag: output.ETag ?? null,
      };
    } catch (error) {
      const classified = classifyS3Error(error);
      if (classified instanceof S3NotFoundError) return null;
      throw classified;
    }
  }

  async getObjectStream(key: string, signal?: AbortSignal): Promise<S3ObjectStream> {
    this.assertBucket();
    let output;
    try {
      output = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: signal },
      );
    } catch (error) {
      throw classifyS3Error(error);
    }

    if (!output.Body) {
      throw new S3Error('S3 response did not include a body', { code: 'S3_NO_BODY' });
    }
    if (!(output.Body instanceof Readable)) {
      throw new S3Error('S3 response body was not a readable stream', { code: 'S3_NO_BODY' });
    }

    return {
      stream: output.Body,
      contentLength: output.ContentLength ?? null,
      contentType: output.ContentType ?? null,
      etag: output.ETag ?? null,
    };
  }

  /**
   * Lists object summaries below a key prefix (paginated, bounded by
   * `maxObjects`). Used to find staging objects that were never attached to a
   * job, or whose delete step failed.
   */
  async listObjects(
    prefix: string,
    options: { maxObjects?: number; signal?: AbortSignal } = {},
  ): Promise<S3ObjectSummary[]> {
    this.assertBucket();
    const maxObjects = Math.min(
      LIST_MAX_OBJECTS_DEFAULT * 5,
      Math.max(1, Math.trunc(options.maxObjects ?? LIST_MAX_OBJECTS_DEFAULT)),
    );
    const summaries: S3ObjectSummary[] = [];
    let token: string | undefined;

    try {
      do {
        const output = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ContinuationToken: token,
            MaxKeys: LIST_PAGE_SIZE,
          }),
          { abortSignal: options.signal },
        );
        for (const item of output.Contents ?? []) {
          if (!item.Key) continue;
          summaries.push({
            key: item.Key,
            size: item.Size ?? 0,
            lastModified: item.LastModified ?? null,
          });
        }
        token = output.IsTruncated ? output.NextContinuationToken : undefined;
      } while (token && summaries.length < maxObjects);
    } catch (error) {
      throw classifyS3Error(error);
    }

    return summaries;
  }

  async deleteObject(key: string, signal?: AbortSignal): Promise<void> {
    this.assertBucket();
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: signal },
      );
    } catch (error) {
      const classified = classifyS3Error(error);
      if (classified instanceof S3NotFoundError) return;
      throw classified;
    }
  }

  private assertBucket(): void {
    if (!this.bucket) {
      throw new S3Error('S3 bucket is not configured', { code: 'S3_ERROR' });
    }
  }
}
