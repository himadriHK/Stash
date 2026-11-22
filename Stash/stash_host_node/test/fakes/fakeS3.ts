import { Readable } from 'node:stream';

import type { S3ObjectHead, S3ObjectStream, S3ObjectSummary } from '../../src/storage/s3';
import { S3NotFoundError } from '../../src/storage/s3';

interface StoredObject {
  buffer: Buffer;
  contentType: string | null;
  lastModified: Date;
}

/** In-memory S3 staging adapter for pipeline tests. */
export class FakeS3Storage {
  readonly objects = new Map<string, StoredObject>();
  readonly deleted: string[] = [];

  reset(): void {
    this.objects.clear();
    this.deleted.length = 0;
  }

  put(
    key: string,
    buffer: Buffer,
    contentType: string | null = null,
    lastModified: Date = new Date(),
  ): void {
    this.objects.set(key, { buffer: Buffer.from(buffer), contentType, lastModified });
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  async headObject(key: string, _signal?: AbortSignal): Promise<S3ObjectHead | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      contentLength: stored.buffer.length,
      contentType: stored.contentType,
      etag: null,
    };
  }

  async getObjectStream(key: string, _signal?: AbortSignal): Promise<S3ObjectStream> {
    const stored = this.objects.get(key);
    if (!stored) throw new S3NotFoundError();
    return {
      stream: Readable.from([stored.buffer]),
      contentLength: stored.buffer.length,
      contentType: stored.contentType,
      etag: null,
    };
  }

  async listObjects(
    prefix: string,
    options: { maxObjects?: number } = {},
  ): Promise<S3ObjectSummary[]> {
    const limit = options.maxObjects ?? 1_000;
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .slice(0, limit)
      .map(([key, stored]) => ({
        key,
        size: stored.buffer.length,
        lastModified: stored.lastModified,
      }));
  }

  async deleteObject(key: string, _signal?: AbortSignal): Promise<void> {
    this.deleted.push(key);
    if (!this.objects.has(key)) throw new S3NotFoundError();
    this.objects.delete(key);
  }
}
