import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from 'pino';

import type { LocalLibrary } from '../storage/local';

export interface TempCleanupOptions {
  local: LocalLibrary;
  isActiveJob: (jobId: string) => boolean;
  retentionHours: number;
  logger?: Logger;
  now?: () => Date;
}

export interface TempCleanupResult {
  scanned: number;
  removed: number;
  retained: number;
  failed: number;
}

function isErrorWithCode(error: unknown, ...codes: string[]): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && codes.includes(code);
}

/**
 * Removes per-job temp directories older than the retention window that are
 * not referenced by a queued or running job. Best effort: individual failures
 * are logged and skipped.
 */
export async function cleanupStaleTempDirs(options: TempCleanupOptions): Promise<TempCleanupResult> {
  const result: TempCleanupResult = { scanned: 0, removed: 0, retained: 0, failed: 0 };
  const jobsDir = path.join(options.local.tempRoot, 'jobs');
  const now = (options.now ?? (() => new Date()))();
  const cutoff = now.getTime() - options.retentionHours * 3_600_000;

  let entries: Dirent[];
  try {
    entries = await fs.readdir(jobsDir, { withFileTypes: true });
  } catch (error) {
    if (isErrorWithCode(error, 'ENOENT', 'ENOTDIR')) return result;
    options.logger?.warn({ error: String(error) }, 'Temp cleanup could not read the jobs directory');
    result.failed += 1;
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    result.scanned += 1;

    if (options.isActiveJob(entry.name)) {
      result.retained += 1;
      continue;
    }

    const target = path.join(jobsDir, entry.name);
    try {
      const stats = await fs.stat(target);
      if (stats.mtimeMs >= cutoff) {
        result.retained += 1;
        continue;
      }
      await fs.rm(target, { recursive: true, force: true });
      result.removed += 1;
    } catch (error) {
      result.failed += 1;
      options.logger?.warn(
        { directory: entry.name, error: String(error) },
        'Temp cleanup could not remove a job directory',
      );
    }
  }

  return result;
}
