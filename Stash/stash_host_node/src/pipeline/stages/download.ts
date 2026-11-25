import type { StageContext, StageOutcome } from './context';
import { ensureTempDir, tempSourcePath } from './common';
import { StageError } from '../retry';

export async function downloadStage(ctx: StageContext): Promise<StageOutcome> {
  const { job, deps, signal } = ctx;
  const storageKey = job.storage_key;
  if (!storageKey) {
    throw new StageError('Missing S3 storage key', { kind: 'terminal', code: 'missing_storage_key' });
  }

  // Upload requests no longer declare a size, so the staged object's own
  // metadata is the size source. One HEAD replaces the client value and drives
  // the disk guard, progress and the integrity check below. A missing object is
  // left to `getObjectStream` so it keeps raising the same not-found error, and
  // a HEAD without ContentLength simply skips the size-based checks.
  const head = await deps.storage.headObject(storageKey, signal);
  const expectedBytes = head?.contentLength ?? null;

  if (expectedBytes !== null && expectedBytes <= 0) {
    throw new StageError('Invalid object size', { kind: 'terminal', code: 'invalid_size' });
  }

  if (expectedBytes !== null) {
    const freeBytes = await deps.local.freeBytes();
    const requiredBytes = expectedBytes * 3 + deps.env.DISK_MIN_FREE_BYTES;
    if (freeBytes > 0 && freeBytes < requiredBytes) {
      throw new StageError('Insufficient disk space to stage the upload', {
        kind: 'resource',
        code: 'disk_full',
      });
    }
  }

  const tempDir = await ensureTempDir(deps.local, job);
  const sourcePath = tempSourcePath(tempDir, job);

  const object = await deps.storage.getObjectStream(storageKey, signal);
  const totalBytes = expectedBytes ?? object.contentLength;

  ctx.progress(0);
  const bytes = await deps.local.writeStreamToTemp(
    object.stream,
    sourcePath,
    (written) =>
      ctx.progress(totalBytes !== null && totalBytes > 0 ? Math.min(1, written / totalBytes) : 0),
    signal,
  );

  if (totalBytes !== null && bytes !== totalBytes) {
    throw new StageError('Streamed byte count did not match the staged object', {
      kind: 'terminal',
      code: 'size_mismatch',
    });
  }

  deps.jobs.updateFields(job.id, {
    temp_dir: tempDir,
    downloaded_size: bytes,
    stage: 'verify',
    progress: 30,
  });
  ctx.event('download_completed', { data: { bytes } });
  return 'continue';
}
