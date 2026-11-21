import fs from 'node:fs/promises';
import path from 'node:path';

import type { JobRow } from '../../db/jobs';
import type { MediaClassification } from '../../media/classify';
import { classifyMedia, sniffFileType } from '../../media/classify';
import type { LocalLibrary } from '../../storage/local';

const SAFE_EXTENSION_PATTERN = /^\.[a-z0-9]{1,10}$/;

export function safeExtension(value: string | null | undefined): string {
  if (!value) return '';
  const normalized = value.trim().toLowerCase();
  const withDot = normalized.startsWith('.') ? normalized : `.${normalized}`;
  return SAFE_EXTENSION_PATTERN.test(withDot) ? withDot : '';
}

export function safeOriginalExtension(fileName: string | null): string {
  if (!fileName) return '';
  const index = fileName.lastIndexOf('.');
  if (index <= 0) return '';
  return safeExtension(fileName.slice(index));
}

export function tempSourcePath(tempDir: string, job: JobRow): string {
  return path.join(tempDir, `source${safeOriginalExtension(job.file_name)}`);
}

export function tempConvertedPath(tempDir: string, extension: string): string {
  return path.join(tempDir, `converted${safeExtension(extension)}`);
}

export async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function ensureTempDir(local: LocalLibrary, job: JobRow): Promise<string> {
  return local.ensureTempDir(job.id);
}

export async function resolveClassification(
  job: JobRow,
  sourcePath: string,
): Promise<MediaClassification> {
  let sniffed: Awaited<ReturnType<typeof sniffFileType>> = null;
  if (await fileExists(sourcePath)) {
    sniffed = await sniffFileType(sourcePath);
  }
  return classifyMedia(job.file_name ?? '', job.mime_type, sniffed);
}

export function targetMimeType(classification: MediaClassification, job: JobRow): string | null {
  return classification.targetMimeType || job.mime_type || null;
}

/** Reuses the converted output when it exists, otherwise the downloaded source. */
export async function workingSourcePath(
  tempDir: string,
  classification: MediaClassification,
  sourcePath: string,
): Promise<string> {
  const converted = tempConvertedPath(tempDir, classification.targetExtension);
  return (await fileExists(converted)) ? converted : sourcePath;
}
