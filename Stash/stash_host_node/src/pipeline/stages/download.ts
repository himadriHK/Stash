import type { StageContext, StageOutcome } from './context';
import { ensureTempDir, tempSourcePath } from './common';
import { StageError } from '../retry';

export async function downloadStage(ctx: StageContext): Promise<StageOutcome> {
  const { job, deps, signal } = ctx;
  const storageKey = job.storage_key;
  if (!storageKey) {
    throw new StageError('Missing S3 storage key', { kind: 'terminal', code: 'missing_storage_key' });
  }

  const fileSize = job.file_size ?? 0;
  if (fileSize <= 0) {
    throw new StageError('Invalid file size', { kind: 'terminal', code: 'invalid_size' });
  }

  const freeBytes = await deps.local.freeBytes();
  const requiredBytes = fileSize * 3 + deps.env.DISK_MIN_FREE_BYTES;
  if (freeBytes > 0 && freeBytes < requiredBytes) {
    throw new StageError('Insufficient disk space to stage the upload', {
      kind: 'resource',
      code: 'disk_full',
    });
  }

  const tempDir = await ensureTempDir(deps.local, job);
  const sourcePath = tempSourcePath(tempDir, job);

  const object = await deps.storage.getObjectStream(storageKey, signal);
  if (object.contentLength !== null && object.contentLength !== fileSize) {
    throw new StageError('Uploaded object size did not match the request', {
      kind: 'terminal',
      code: 'size_mismatch',
    });
  }

  ctx.progress(0);
  const bytes = await deps.local.writeStreamToTemp(
    object.stream,
    sourcePath,
    (written) => ctx.progress(fileSize > 0 ? Math.min(1, written / fileSize) : 0),
    signal,
  );

  if (bytes !== fileSize) {
    throw new StageError('Streamed byte count did not match the request', {
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
