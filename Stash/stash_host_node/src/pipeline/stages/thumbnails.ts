import path from 'node:path';

import type { StageContext, StageOutcome } from './context';
import { ensureTempDir, resolveClassification, tempSourcePath, workingSourcePath } from './common';
import { generateThumbnails } from '../../media/thumbnails';
import { sanitizeErrorMessage } from '../response';

export async function thumbnailsStage(ctx: StageContext): Promise<StageOutcome> {
  const { job, deps, signal } = ctx;
  const tempDir = await ensureTempDir(deps.local, job);
  const sourcePath = tempSourcePath(tempDir, job);
  const classification = await resolveClassification(job, sourcePath);

  if (!classification.canThumbnail) {
    deps.jobs.updateFields(job.id, { stage: 'store', progress: 80 });
    ctx.event('thumbnails_skipped', { data: { kind: classification.kind } });
    return 'continue';
  }

  const source =
    job.deduplicated === 1 && job.permanent_path
      ? deps.local.absolute(job.permanent_path)
      : await workingSourcePath(tempDir, classification, sourcePath);

  const outDir = path.join(tempDir, 'thumbs');
  const result = await generateThumbnails(
    source,
    outDir,
    { kind: classification.kind, quality: deps.env.THUMBNAIL_QUALITY },
    (completed, total) => ctx.progress(total > 0 ? Math.min(1, completed / total) : 0),
    signal,
  );

  if (result.failures.length > 0) {
    ctx.event('thumbnails_partial', {
      level: 'warn',
      message: 'One or more thumbnail sizes could not be generated',
      data: {
        failedSizes: result.failures.map((failure) => failure.size),
        errors: result.failures.map((failure) => sanitizeErrorMessage(failure.error)),
      },
    });
  }

  deps.jobs.updateFields(job.id, { stage: 'store', progress: 80 });
  return 'continue';
}
