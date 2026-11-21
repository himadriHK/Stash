import type { StageContext, StageOutcome } from './context';
import { S3Error } from '../../storage/s3';

export async function deleteTempStage(ctx: StageContext): Promise<StageOutcome> {
  const { job, deps } = ctx;

  if (job.failed_stage !== null && !deps.env.DELETE_TEMP_ON_FAILURE) {
    deps.jobs.updateFields(job.id, { stage: 'done', progress: 100 });
    ctx.event('delete_skipped', {
      data: { reason: 'delete_temp_on_failure_disabled' },
    });
    return 'continue';
  }

  const storageKey = job.storage_key;
  if (!storageKey) {
    deps.jobs.updateFields(job.id, { stage: 'done', progress: 100 });
    return 'continue';
  }

  const active = deps.jobs.countActiveByStorageKey(storageKey, job.id);
  if (active > 0) {
    deps.jobs.updateFields(job.id, { stage: 'done', progress: 100 });
    ctx.event('delete_deferred_shared_key', {
      data: { activeJobs: active },
    });
    return 'continue';
  }

  try {
    await deps.storage.deleteObject(storageKey, ctx.signal);
  } catch (error) {
    if (!(error instanceof S3Error && error.code === 'S3_NOT_FOUND')) {
      throw error;
    }
  }

  deps.jobs.updateFields(job.id, { stage: 'done', progress: 100 });
  ctx.event('temp_deleted', { data: { storageKey } });
  return 'continue';
}
