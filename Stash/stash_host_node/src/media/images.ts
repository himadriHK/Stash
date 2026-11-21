import fs from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

const DEFAULT_JPEG_QUALITY = 90;
const DEFAULT_MAX_PIXELS = 200_000_000;

export interface JpegConversionOptions {
  quality?: number;
  limitInputPixels?: number;
}

function isErrorWithCode(error: unknown, ...codes: string[]): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && codes.includes(code);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

async function replaceFile(part: string, output: string): Promise<void> {
  try {
    await fs.rename(part, output);
  } catch (error) {
    if (!isErrorWithCode(error, 'EEXIST', 'EPERM', 'EACCES')) throw error;
    await fs.rm(output, { force: true });
    await fs.rename(part, output);
  }
}

async function assertNonEmpty(target: string): Promise<void> {
  const stats = await fs.stat(target);
  if (stats.size <= 0) {
    await fs.rm(target, { force: true }).catch(() => undefined);
    throw new Error('Image output was empty');
  }
}

/**
 * Converts an image to JPEG with EXIF orientation applied. The output is
 * written atomically through `output.part` and renamed on success.
 */
export async function convertToJpeg(
  input: string,
  output: string,
  options: JpegConversionOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const part = `${output}.part`;
  await fs.mkdir(path.dirname(output), { recursive: true });

  try {
    await sharp(input, {
      limitInputPixels: options.limitInputPixels ?? DEFAULT_MAX_PIXELS,
    })
      .rotate()
      .jpeg({ quality: options.quality ?? DEFAULT_JPEG_QUALITY, mozjpeg: true })
      .toFile(part);

    throwIfAborted(signal);
    await assertNonEmpty(part);
    await replaceFile(part, output);
  } catch (error) {
    await fs.rm(part, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Generates one center-cropped JPEG thumbnail at the requested square size.
 * Returns the output path.
 */
export async function generateThumbnail(
  source: string,
  output: string,
  size: number,
  quality = DEFAULT_JPEG_QUALITY,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const part = `${output}.part`;

  try {
    await sharp(source, { limitInputPixels: DEFAULT_MAX_PIXELS })
      .rotate()
      .resize(size, size, { fit: 'cover', position: 'center' })
      .jpeg({ quality })
      .toFile(part);

    throwIfAborted(signal);
    await assertNonEmpty(part);
    await replaceFile(part, output);
    return output;
  } catch (error) {
    await fs.rm(part, { force: true }).catch(() => undefined);
    throw error;
  }
}

