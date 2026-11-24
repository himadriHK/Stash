import type { StageContext, StageOutcome } from './context';
import { ensureTempDir, resolveClassification, targetMimeType, tempSourcePath } from './common';

export async function deduplicateStage(ctx: StageContext): Promise<StageOutcome> {
  const { job, deps } = ctx;
  const tempDir = await ensureTempDir(deps.local, job);
  const sourcePath = tempSourcePath(tempDir, job);
  const classification = await resolveClassification(job, sourcePath);
  const permanentPath = deps.local.permanentLogical(
    job.user_id ?? '',
    (job.content_hash ?? '').toLowerCase(),
    classification.targetExtension,
  );

  if (await deps.local.exists(permanentPath)) {
    deps.jobs.updateFields(job.id, {
      permanent_path: permanentPath,
      converted_format: targetMimeType(classification, job),
      deduplicated: 1,
      stage: 'thumbnails',
      progress: 70,
    });
    ctx.event('dedup_hit', { data: { permanentPath, kind: classification.kind } });
    return 'continue';
  }

  deps.jobs.updateFields(job.id, { stage: 'convert', progress: 45 });
  ctx.event('dedup_miss', {
    data: { kind: classification.kind, targetExtension: classification.targetExtension },
  });
  return 'continue';
}
