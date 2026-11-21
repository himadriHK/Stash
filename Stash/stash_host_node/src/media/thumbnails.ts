import fs from 'node:fs/promises';
import path from 'node:path';

import type { MediaKind } from './classify';
import { isVideoLike } from './classify';
import { generateThumbnail } from './images';
import { extractVideoFrame } from './video';

export const THUMBNAIL_SIZES = [128, 256, 512] as const;

export type ThumbnailSize = (typeof THUMBNAIL_SIZES)[number];

export interface ThumbnailOptions {
  kind: MediaKind;
  quality?: number;
}

export interface ThumbnailFailure {
  size: ThumbnailSize;
  error: Error;
}

export interface ThumbnailGenerationResult {
  paths: Partial<Record<ThumbnailSize, string>>;
  failures: ThumbnailFailure[];
}

export type ThumbnailProgressCallback = (completed: number, total: number, size: ThumbnailSize) => void;

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Generates the 128/256/512 center-cropped JPEG thumbnails. Individual size
 * failures are returned rather than thrown. Video sources are sampled by
 * extracting a single frame first; the frame is cleaned up in all cases.
 */
export async function generateThumbnails(
  source: string,
  outDir: string,
  options: ThumbnailOptions,
  onProgress?: ThumbnailProgressCallback,
  signal?: AbortSignal,
): Promise<ThumbnailGenerationResult> {
  await fs.mkdir(outDir, { recursive: true });
  const paths: Partial<Record<ThumbnailSize, string>> = {};
  const failures: ThumbnailFailure[] = [];
  let framePath: string | null = null;

  try {
    let thumbnailSource = source;

    if (isVideoLike(options.kind)) {
      framePath = path.join(outDir, `.frame-${Date.now()}-${process.pid}.jpg`);
      try {
        await extractVideoFrame(source, framePath, signal);
        thumbnailSource = framePath;
      } catch (error) {
        if (signal?.aborted) throw error;
        const failure = toError(error);
        for (const size of THUMBNAIL_SIZES) failures.push({ size, error: failure });
        return { paths, failures };
      }
    }

    let completed = 0;
    for (const size of THUMBNAIL_SIZES) {
      if (signal?.aborted) {
        const error = signal.reason instanceof Error ? signal.reason : new Error('Aborted');
        failures.push({ size, error });
        continue;
      }

      const target = path.join(outDir, `thumb-${size}.jpg`);
      try {
        const output = await generateThumbnail(
          thumbnailSource,
          target,
          size,
          options.quality ?? 90,
          signal,
        );
        paths[size] = output;
      } catch (error) {
        if (signal?.aborted) throw error;
        failures.push({ size, error: toError(error) });
      }

      completed += 1;
      onProgress?.(completed, THUMBNAIL_SIZES.length, size);
    }

    return { paths, failures };
  } finally {
    if (framePath) {
      await fs.rm(framePath, { force: true }).catch(() => undefined);
    }
  }
}

