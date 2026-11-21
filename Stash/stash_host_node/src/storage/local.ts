import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { AppEnv } from '../config/env';
import {
  buildLocalPermanentPath,
  buildLocalThumbnailPath,
  PathError,
  resolveLocalPath,
} from './paths';

const JOB_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

export interface FileInspection {
  size: number;
  mtimeMs: number;
}

export type ProgressCallback = (bytesWritten: number) => void;

function isErrorWithCode(error: unknown, ...codes: string[]): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && codes.includes(code);
}

function uniquePartSuffix(): string {
  return `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
}

function assertSafeJobId(jobId: string): string {
  if (
    !JOB_ID_PATTERN.test(jobId) ||
    jobId === '.' ||
    jobId === '..' ||
    jobId.includes(':') ||
    CONTROL_CHARACTER_PATTERN.test(jobId)
  ) {
    throw new PathError('Job id must be a single safe path segment');
  }
  return jobId;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Local permanent-library writer and temp-directory manager. Every physical
 * write is validated to stay below the library root (or the temp root for
 * streaming temp writes); absolute paths are never exposed to clients.
 */
export class LocalLibrary {
  readonly root: string;
  readonly tempRoot: string;

  constructor(env: AppEnv) {
    this.root = path.resolve(env.LOCAL_ROOT_PATH);
    this.tempRoot = path.resolve(env.TEMP_DIR);
  }

  /** Ensures the library root exists and can be written to. */
  async ensureReady(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const probe = path.join(this.root, `.stash-write-check-${uniquePartSuffix()}`);
    try {
      await fs.writeFile(probe, 'ok');
    } finally {
      await fs.rm(probe, { force: true }).catch(() => undefined);
    }
  }

  /** Returns available bytes on the library filesystem, or 0 when unknown. */
  async freeBytes(): Promise<number> {
    try {
      const stats = await fs.statfs(this.root);
      return Number(stats.bsize) * Number(stats.bavail);
    } catch {
      return 0;
    }
  }

  absolute(logicalPath: string): string {
    return resolveLocalPath(this.root, logicalPath);
  }

  async exists(logicalPath: string): Promise<boolean> {
    try {
      await fs.stat(this.absolute(logicalPath));
      return true;
    } catch (error) {
      if (isErrorWithCode(error, 'ENOENT', 'ENOTDIR')) return false;
      throw error;
    }
  }

  async inspect(logicalPath: string): Promise<FileInspection | null> {
    try {
      const stats = await fs.stat(this.absolute(logicalPath));
      return { size: stats.size, mtimeMs: stats.mtimeMs };
    } catch (error) {
      if (isErrorWithCode(error, 'ENOENT', 'ENOTDIR')) return null;
      throw error;
    }
  }

  tempJobDir(jobId: string): string {
    return path.join(this.tempRoot, 'jobs', assertSafeJobId(jobId));
  }

  async ensureTempDir(jobId: string): Promise<string> {
    const dir = this.tempJobDir(jobId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async cleanupTempDir(jobId: string): Promise<void> {
    await fs.rm(this.tempJobDir(jobId), { recursive: true, force: true });
  }

  /**
   * Copies a file into the local library. The destination is written to a
   * unique `.part` file, fsynced, then renamed. An existing destination with
   * the same size is treated as already stored.
   */
  async atomicCopyFile(sourceAbsolute: string, logicalDestination: string): Promise<void> {
    const destination = this.absolute(logicalDestination);
    const sourceStat = await fs.stat(sourceAbsolute);
    const destinationStat = await statOrNull(destination);
    if (destinationStat && destinationStat.size === sourceStat.size) return;

    await fs.mkdir(path.dirname(destination), { recursive: true });
    const part = `${destination}.part-${uniquePartSuffix()}`;
    try {
      await fs.copyFile(sourceAbsolute, part);
      await fsyncFile(part);
      await replaceFile(part, destination);
    } catch (error) {
      await fs.rm(part, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Writes a buffer into the local library atomically. An existing destination
   * with the same byte length is treated as already stored.
   */
  async atomicWriteFile(buffer: Uint8Array, logicalDestination: string): Promise<void> {
    const destination = this.absolute(logicalDestination);
    const destinationStat = await statOrNull(destination);
    if (destinationStat && destinationStat.size === buffer.byteLength) return;

    await fs.mkdir(path.dirname(destination), { recursive: true });
    const part = `${destination}.part-${uniquePartSuffix()}`;
    try {
      await fs.writeFile(part, buffer);
      await fsyncFile(part);
      await replaceFile(part, destination);
    } catch (error) {
      await fs.rm(part, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Streams a Readable to an absolute path (under the library or temp root),
   * writing to a `.part` file, fsyncing, then renaming. Returns bytes written.
   */
  async writeStreamToTemp(
    stream: Readable,
    destAbsolute: string,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<number> {
    const destination = path.resolve(destAbsolute);
    this.assertWritableAbsolute(destination);
    await fs.mkdir(path.dirname(destination), { recursive: true });

    const part = `${destination}.part-${uniquePartSuffix()}`;
    let bytesWritten = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytesWritten += chunk.length;
        onProgress?.(bytesWritten);
        callback(null, chunk);
      },
    });

    try {
      if (signal) {
        await pipeline(stream, counter, createWriteStream(part), { signal });
      } else {
        await pipeline(stream, counter, createWriteStream(part));
      }
      await fsyncFile(part);
      await replaceFile(part, destination);
      return bytesWritten;
    } catch (error) {
      await fs.rm(part, { force: true }).catch(() => undefined);
      throw toError(error);
    }
  }

  permanentLogical(userId: string, hash: string, extension: string): string {
    return buildLocalPermanentPath(userId, hash, extension);
  }

  thumbnailLogical(userId: string, hash: string, size: number | string): string {
    return buildLocalThumbnailPath(userId, hash, size);
  }

  resolvePermanent(userId: string, hash: string, extension: string): string {
    return this.absolute(this.permanentLogical(userId, hash, extension));
  }

  resolveThumbnail(userId: string, hash: string, size: number | string): string {
    return this.absolute(this.thumbnailLogical(userId, hash, size));
  }

  private assertWritableAbsolute(target: string): void {
    if (!isWithin(this.root, target) && !isWithin(this.tempRoot, target)) {
      throw new PathError('Destination escapes the storage roots');
    }
  }
}

function isWithin(root: string, target: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target.startsWith(prefix);
}

async function statOrNull(target: string): Promise<{ size: number } | null> {
  try {
    return await fs.stat(target);
  } catch (error) {
    if (isErrorWithCode(error, 'ENOENT', 'ENOTDIR')) return null;
    throw error;
  }
}

async function fsyncFile(target: string): Promise<void> {
  const handle = await fs.open(target, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceFile(part: string, destination: string): Promise<void> {
  try {
    await fs.rename(part, destination);
  } catch (error) {
    if (!isErrorWithCode(error, 'EEXIST', 'EPERM', 'EACCES')) throw error;
    await fs.rm(destination, { force: true });
    await fs.rename(part, destination);
  }
}


