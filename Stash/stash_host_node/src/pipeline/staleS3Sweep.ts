import type { Logger } from 'pino';

import type { StoragePort } from './types';

export interface StagingSweepOptions {
  storage: Pick<StoragePort, 'listObjects' | 'deleteObject'>;
  /** Bucket key prefix that holds upload staging objects (prefix + /temp/uploads). */
  stagingPrefix: string;
  retentionHours: number;
  /** Storage keys of queued/running jobs; these are never swept. */
  activeKeys: ReadonlySet<string>;
  maxObjects?: number;
  now?: () => Date;
  logger?: Logger;
}

export interface StagingSweepResult {
  scanned: number;
  deleted: number;
  retained: number;
  failed: number;
}

export const DEFAULT_STAGING_SWEEP_MAX_OBJECTS = 2_000;

/**
 * Removes staging objects that no job will ever delete: uploads whose request
 * never produced a job (rejected/DLQ'd or never published by the client) and
 * objects whose `delete_temp` step ended in a non-retryable failure.
 *
 * Objects are only removed once they are older than the retention window and
 * are not referenced by a queued or running job, so an in-flight download is
 * never swept. Failures are collected rather than thrown: the sweep is a
 * best-effort backstop and reruns on the next interval.
 */
export async function sweepStaleStagingObjects(
  options: StagingSweepOptions,
): Promise<StagingSweepResult> {
  const result: StagingSweepResult = { scanned: 0, deleted: 0, retained: 0, failed: 0 };
  const now = (options.now ?? (() => new Date()))();
  const cutoff = now.getTime() - Math.max(1, options.retentionHours) * 3_600_000;

  const objects = await options.storage.listObjects(options.stagingPrefix, {
    maxObjects: options.maxObjects ?? DEFAULT_STAGING_SWEEP_MAX_OBJECTS,
  });

  for (const object of objects) {
    result.scanned += 1;

    if (options.activeKeys.has(object.key)) {
      result.retained += 1;
      continue;
    }

    if (object.lastModified === null || object.lastModified.getTime() >= cutoff) {
      result.retained += 1;
      continue;
    }

    try {
      await options.storage.deleteObject(object.key);
      result.deleted += 1;
    } catch (error) {
      result.failed += 1;
      options.logger?.warn(
        { storageKey: object.key, error: error instanceof Error ? error.message : String(error) },
        'S3 staging sweep could not delete an object',
      );
    }
  }

  if (result.deleted > 0 || result.failed > 0) {
    options.logger?.info(
      { ...result, stagingPrefix: options.stagingPrefix },
      'S3 staging sweep removed orphaned uploads',
    );
  }

  return result;
}
