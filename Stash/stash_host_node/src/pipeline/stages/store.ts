import path from 'node:path';

import type { StageContext, StageOutcome } from './context';
import {
  ensureTempDir,
  fileExists,
  resolveClassification,
  targetMimeType,
  tempSourcePath,
  workingSourcePath,
} from './common';
import { THUMBNAIL_SIZES } from '../../media/thumbnails';

export async function storeStage(ctx: StageContext): Promise<StageOutcome> {
  const { job, deps } = ctx;
  const tempDir = await ensureTempDir(deps.local, job);
  const sourcePath = tempSourcePath(tempDir, job);
  const classification = await resolveClassification(job, sourcePath);
  const permanentPath = deps.local.permanentLogical(
    job.user_id ?? '',
    job.file_id ?? '',
    classification.targetExtension,
  );

  const permanentExists = await deps.local.exists(permanentPath);
  if (!job.deduplicated || !permanentExists) {
    const working = await workingSourcePath(tempDir, classification, sourcePath);
    await deps.local.atomicCopyFile(working, permanentPath);
  }

  const thumbnails: Record<string, string> = {};
  for (const size of THUMBNAIL_SIZES) {
    const tempThumb = path.join(tempDir, 'thumbs', `thumb-${size}.jpg`);
    if (!(await fileExists(tempThumb))) continue;
    const logical = deps.local.thumbnailLogical(job.user_id ?? '', job.file_id ?? '', size);
    await deps.local.atomicCopyFile(tempThumb, logical);
    thumbnails[String(size)] = logical;
  }

  deps.jobs.updateFields(job.id, {
    permanent_path: permanentPath,
    thumbnails_json: JSON.stringify(thumbnails),
    converted_format: targetMimeType(classification, job),
    stage: 'respond',
    progress: 92,
  });
  ctx.event('store_completed', {
    data: { permanentPath, thumbnailSizes: Object.keys(thumbnails) },
  });
  return 'continue';
}
