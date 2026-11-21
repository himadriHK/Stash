import type { StageContext, StageOutcome } from './context';
import { buildResponseV1, sanitizeErrorMessage } from '../response';
import { StageError } from '../retry';

export async function respondStage(ctx: StageContext): Promise<StageOutcome> {
  const { job, deps } = ctx;
  const now = ctx.now();
  const failed = job.failed_stage !== null;
  const built = buildResponseV1({
    job,
    status: failed ? 'FAILED' : 'COMPLETED',
    error: failed ? (job.error_message ?? 'Processing failed') : null,
    now,
  });

  deps.outbox.enqueue({
    jobId: job.id,
    kind: 'response',
    topic: deps.env.KAFKA_RESPONSE_TOPIC,
    key: built.key,
    payload: built.payload,
    headers: built.headers,
    nextAttemptAt: now.toISOString(),
    createdAt: now.toISOString(),
  });

  const result = await deps.outboxDispatcher.flushJob(job.id, 'response');

  if (result === 'sent') {
    deps.jobs.updateFields(job.id, { stage: 'delete_temp', progress: 97 });
    ctx.event('response_sent', { data: { status: built.response.status } });
    return 'continue';
  }

  if (result === 'pending') {
    throw new StageError('Response publish is still pending', {
      kind: 'transient',
      code: 'response_pending',
    });
  }

  // dead or missing: no response can be delivered, so finalize without
  // deleting the S3 object (lifecycle rule is the backstop).
  deps.jobs.updateFields(job.id, { failed_stage: job.failed_stage ?? 'respond' });
  ctx.event('response_publish_failed', {
    level: 'error',
    message: 'The response could not be published',
    data: { result },
  });
  deps.jobs.finalize(
    job.id,
    {
      status: 'failed',
      errorCode: 'response_publish_failed',
      errorMessage: 'The response could not be published',
    },
    now,
  );

  try {
    await deps.local.cleanupTempDir(job.id);
  } catch (error) {
    ctx.event('temp_cleanup_failed', {
      level: 'warn',
      message: sanitizeErrorMessage(error),
    });
  }

  return 'return';
}
