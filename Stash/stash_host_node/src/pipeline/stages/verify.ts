import type { StageContext, StageOutcome } from './context';
import { ensureTempDir, fileExists, tempSourcePath } from './common';
import { StageError } from '../retry';

export async function verifyStage(ctx: StageContext): Promise<StageOutcome> {
  const { job, deps, signal } = ctx;
  const tempDir = await ensureTempDir(deps.local, job);
  const sourcePath = tempSourcePath(tempDir, job);

  if (!(await fileExists(sourcePath))) {
    throw new StageError('Source file is missing from temp storage', {
      kind: 'transient',
      code: 'source_missing',
    });
  }

  const hashFile =
    deps.hashFile ??
    (async (
      target: string,
      onProgress?: (bytes: number, total: number) => void,
      hashSignal?: AbortSignal,
    ): Promise<string> => {
      const { runHashWorker } = await import('../../media/workers');
      return runHashWorker(target, {
        signal: hashSignal,
        timeoutMs: deps.env.HASH_WORKER_TIMEOUT_MS,
        onProgress,
      });
    });

  ctx.progress(0);
  const actual = (
    await hashFile(
      sourcePath,
      (bytes, total) => ctx.progress(total > 0 ? Math.min(1, bytes / total) : 0),
      signal,
    )
  ).toLowerCase();

  // The request's fileId is a client identifier (a GUID the device salted with
  // its metadata hash), not a content hash, so the host cannot compare it with
  // anything. This computed digest is the canonical dedup key for the job: it
  // names the permanent object and the thumbnails, which is what makes two
  // devices uploading identical bytes collapse onto one stored file.
  deps.jobs.updateFields(job.id, {
    content_hash: actual,
    stage: 'deduplicate',
    progress: 40,
  });
  ctx.event('verify_completed', { data: { hash: actual } });
  return 'continue';
}
