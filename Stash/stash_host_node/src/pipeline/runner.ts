import type { Logger } from 'pino';

import type { JobStatus, Stage } from '../contracts/stages';
import { STAGE_PROGRESS } from '../contracts/stages';
import type { FinalizeJobOptions, JobRow } from '../db/jobs';
import { classifyMedia } from '../media/classify';
import { runHashWorker } from '../media/workers';
import type { PipelineDeps } from './types';
import { sanitizeErrorMessage } from './response';
import {
  classifyStageError,
  computeRetryDelayMs,
  createStageSignal,
  getStageAttempt,
  StageError,
  type StageSignalHandle,
} from './retry';
import type { StageContext, StageEventOptions, StageExecutor, StageOutcome } from './stages/context';
import { downloadStage } from './stages/download';
import { verifyStage } from './stages/verify';
import { deduplicateStage } from './stages/deduplicate';
import { convertStage } from './stages/convert';
import { thumbnailsStage } from './stages/thumbnails';
import { storeStage } from './stages/store';
import { respondStage } from './stages/respond';
import { deleteTempStage } from './stages/deleteTemp';

export type { PipelineDeps, StoragePort, HashFile } from './types';

const FINALIZATION_STAGES = new Set<Stage>(['respond', 'delete_temp', 'done']);
const TERMINAL_STATUSES = new Set<JobStatus>(['completed', 'failed', 'cancelled']);
const PROGRESS_WRITE_INTERVAL_MS = 250;

const EXECUTORS: Record<Exclude<Stage, 'queued' | 'done'>, StageExecutor> = {
  download: downloadStage,
  verify: verifyStage,
  deduplicate: deduplicateStage,
  convert: convertStage,
  thumbnails: thumbnailsStage,
  store: storeStage,
  respond: respondStage,
  delete_temp: deleteTempStage,
};

class LeaseLostError extends Error {
  constructor() {
    super('Lease was lost');
    this.name = 'LeaseLostError';
  }
}

class CancelRequestedError extends Error {
  constructor() {
    super('Cancellation requested');
    this.name = 'CancelRequestedError';
  }
}

interface RunState {
  leaseLost: boolean;
  activeStage: AbortController | null;
}

export class PipelineRunner {
  private readonly deps: PipelineDeps;
  private readonly clock: () => Date;
  private readonly logger?: Logger;

  constructor(deps: PipelineDeps) {
    this.deps = {
      ...deps,
      hashFile:
        deps.hashFile ??
        ((target, onProgress, signal) =>
          runHashWorker(target, {
            signal,
            timeoutMs: deps.env.HASH_WORKER_TIMEOUT_MS,
            onProgress,
          })),
    };
    this.clock = deps.now ?? (() => new Date());
    this.logger = deps.logger;
  }

  async runJob(job: JobRow, workerId: string, externalSignal?: AbortSignal): Promise<void> {
    let current = this.deps.jobs.getById(job.id) ?? job;
    const state: RunState = { leaseLost: false, activeStage: null };
    const stopHeartbeat = this.startHeartbeat(current.id, workerId, state);
    const onExternalAbort = (): void => {
      state.activeStage?.abort(new LeaseLostError());
    };
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      for (;;) {
        if (externalSignal?.aborted) {
          this.releaseForShutdown(current, workerId);
          return;
        }
        if (state.leaseLost) return;

        current = this.deps.jobs.getById(current.id) ?? current;
        if (TERMINAL_STATUSES.has(current.status)) {
          await this.cleanupTemp(current.id);
          return;
        }
        if (current.stage === 'done') {
          await this.finalizeDone(current);
          return;
        }

        if (current.cancel_requested && !FINALIZATION_STAGES.has(current.stage)) {
          const staged = this.deps.jobs.markForFinalization(
            current.id,
            { failedStage: 'cancelled', errorCode: 'cancelled', errorMessage: 'Cancelled' },
            this.clock(),
          );
          if (!staged) return;
          current = staged;
          continue;
        }

        if (current.stage === 'queued') {
          const advanced = this.deps.jobs.updateFields(current.id, { stage: 'download', progress: 10 });
          if (!advanced) return;
          current = advanced;
        }

        const stage = current.stage;
        const executor = EXECUTORS[stage as Exclude<Stage, 'queued' | 'done'>];
        if (!executor) {
          this.logger?.error({ jobId: current.id, stage }, 'No executor for stage');
          return;
        }

        const controller = new AbortController();
        state.activeStage = controller;
        const linked = linkSignals(
          externalSignal ? [externalSignal, controller.signal] : [controller.signal],
        );
        let handle: StageSignalHandle | null = null;

        try {
          handle = createStageSignal(linked.signal, this.timeoutFor(current));
          const context = this.createStageContext(current, handle.signal);
          const outcome: StageOutcome = await executor(context);
          state.activeStage = null;

          if (outcome === 'return') return;

          const next = this.deps.jobs.getById(current.id);
          if (!next) return;
          current = next;
        } catch (error) {
          state.activeStage = null;
          const failure = this.deps.jobs.getById(current.id) ?? current;

          if (externalSignal?.aborted) {
            this.releaseForShutdown(failure, workerId);
            return;
          }
          if (state.leaseLost) return;

          const abortReason = controller.signal.aborted ? controller.signal.reason : null;
          if (abortReason instanceof CancelRequestedError || failure.cancel_requested) {
            if (!FINALIZATION_STAGES.has(failure.stage)) {
              const staged = this.deps.jobs.markForFinalization(
                failure.id,
                { failedStage: 'cancelled', errorCode: 'cancelled', errorMessage: 'Cancelled' },
                this.clock(),
              );
              if (!staged) return;
              current = staged;
              continue;
            }
          }

          const timedOut =
            handle?.didTimeout() === true &&
            !(abortReason instanceof CancelRequestedError) &&
            !externalSignal?.aborted &&
            !state.leaseLost;
          const stageError = timedOut
            ? new StageError('Stage timed out', {
                kind: 'transient',
                code: 'stage_timeout',
                cause: error,
              })
            : classifyStageError(error, failure.stage);

          const action = await this.handleFailure(failure, workerId, stageError);
          if (action === 'retry' || action === 'return') return;

          const next = this.deps.jobs.getById(failure.id);
          if (!next) return;
          current = next;
        } finally {
          handle?.cleanup();
          linked.cleanup();
          if (state.activeStage === controller) state.activeStage = null;
        }
      }
    } finally {
      externalSignal?.removeEventListener('abort', onExternalAbort);
      stopHeartbeat();
    }
  }

  private startHeartbeat(jobId: string, workerId: string, state: RunState): () => void {
    const intervalMs = Math.max(1_000, this.deps.env.HEARTBEAT_SECONDS * 1_000);
    let stopped = false;

    const timer = setInterval(() => {
      if (stopped) return;
      try {
        const current = this.deps.jobs.getById(jobId);
        if (!current) {
          state.leaseLost = true;
          state.activeStage?.abort(new LeaseLostError());
          return;
        }

        const finalizing =
          current.failed_stage !== null &&
          (current.stage === 'respond' || current.stage === 'delete_temp' || current.stage === 'done');
        if (finalizing) return;

        if (current.status !== 'running' || current.lease_owner !== workerId) {
          state.leaseLost = true;
          state.activeStage?.abort(new LeaseLostError());
          return;
        }

        if (current.cancel_requested && state.activeStage) {
          state.activeStage.abort(new CancelRequestedError());
        }

        const ok = this.deps.jobs.heartbeat(jobId, workerId, this.deps.env.LEASE_SECONDS, this.clock());
        if (!ok) {
          state.leaseLost = true;
          state.activeStage?.abort(new LeaseLostError());
        }
      } catch (error) {
        this.logger?.warn(
          { jobId, error: sanitizeErrorMessage(error) },
          'Worker heartbeat failed',
        );
      }
    }, intervalMs);

    if (typeof timer.unref === 'function') timer.unref();

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  private createStageContext(job: JobRow, signal: AbortSignal): StageContext {
    return {
      deps: this.deps,
      job,
      signal,
      now: this.clock,
      progress: this.createProgress(job),
      event: (event, options) => this.appendEvent(job, event, options),
      logger: this.logger,
    };
  }

  private createProgress(job: JobRow): (fraction: number) => void {
    const range = STAGE_PROGRESS[job.stage] ?? { start: job.progress, end: job.progress };
    let lastWrite = 0;
    let value = job.progress;

    return (fraction: number) => {
      const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
      const target = Math.round(range.start + (range.end - range.start) * clamped);
      if (target <= value) return;

      const timestamp = Date.now();
      if (timestamp - lastWrite < PROGRESS_WRITE_INTERVAL_MS) return;
      lastWrite = timestamp;
      value = Math.max(value, target);

      try {
        this.deps.jobs.updateFields(job.id, { progress: value });
      } catch (error) {
        this.logger?.debug(
          { jobId: job.id, error: sanitizeErrorMessage(error) },
          'Progress update failed',
        );
      }
    };
  }

  private appendEvent(job: JobRow, event: string, options: StageEventOptions = {}): void {
    try {
      this.deps.jobs.appendEvent({
        jobId: job.id,
        event,
        level: options.level ?? 'info',
        stage: options.stage ?? job.stage,
        message: options.message ?? null,
        data: options.data,
        at: this.clock().toISOString(),
      });
    } catch (error) {
      this.logger?.debug(
        { jobId: job.id, event, error: sanitizeErrorMessage(error) },
        'Job event append failed',
      );
    }
  }

  private async handleFailure(
    job: JobRow,
    workerId: string,
    error: StageError,
  ): Promise<'retry' | 'continue' | 'return'> {
    const stage = job.stage;
    const safeMessage = sanitizeErrorMessage(error.message);
    const maxAttempts = Math.max(1, job.max_attempts);
    const attempt = getStageAttempt(job, stage) + 1;
    const retryable = error.kind !== 'terminal';

    if (stage === 'respond') {
      if (retryable && attempt < maxAttempts) {
        this.releaseForRetry(job, workerId, stage, attempt, error, safeMessage);
        return 'retry';
      }
      // No response can be published. Finalize failed but keep S3 staging for
      // the lifecycle backstop.
      this.deps.jobs.updateFields(job.id, { failed_stage: job.failed_stage ?? 'respond' });
      this.deps.jobs.finalize(
        job.id,
        { status: 'failed', errorCode: error.code, errorMessage: safeMessage },
        this.clock(),
      );
      await this.cleanupTemp(job.id);
      return 'return';
    }

    if (stage === 'delete_temp') {
      if (retryable && attempt < maxAttempts) {
        this.releaseForRetry(job, workerId, stage, attempt, error, safeMessage);
        return 'retry';
      }
      this.deps.jobs.appendEvent({
        jobId: job.id,
        event: 'temp_delete_failed',
        level: 'warn',
        stage,
        message: safeMessage,
        data: { errorCode: error.code },
        at: this.clock().toISOString(),
      });
      this.deps.jobs.updateFields(job.id, { stage: 'done', progress: 100, next_attempt_at: null });
      await this.cleanupTemp(job.id);
      return 'continue';
    }

    if (retryable && attempt < maxAttempts) {
      this.releaseForRetry(job, workerId, stage, attempt, error, safeMessage);
      return 'retry';
    }

    const staged = this.deps.jobs.markForFinalization(
      job.id,
      { failedStage: stage, errorCode: error.code, errorMessage: safeMessage },
      this.clock(),
    );
    return staged ? 'continue' : 'return';
  }

  private releaseForRetry(
    job: JobRow,
    workerId: string,
    stage: Stage,
    attempt: number,
    error: StageError,
    safeMessage: string,
  ): void {
    const finalizing = job.failed_stage !== null;
    const delay = computeRetryDelayMs(
      attempt,
      this.deps.env.RETRY_BASE_MS,
      this.deps.env.RETRY_MAX_MS,
    );
    const nextAttemptAt = new Date(this.clock().getTime() + delay).toISOString();

    this.deps.jobs.releaseForRetry(job.id, workerId, {
      stage,
      errorCode: finalizing ? (job.error_code ?? error.code) : error.code,
      errorMessage: finalizing ? (job.error_message ?? safeMessage) : safeMessage,
      nextAttemptAt,
      incrementStageAttempt: true,
    });

    this.logger?.warn(
      {
        jobId: job.id,
        stage,
        attempt,
        kind: error.kind,
        code: error.code,
        nextAttemptAt,
      },
      'Stage failed; retry scheduled',
    );
  }

  private releaseForShutdown(job: JobRow, workerId: string): void {
    const current = this.deps.jobs.getById(job.id) ?? job;
    if (current.status !== 'running') return;
    try {
      this.deps.jobs.releaseForRetry(current.id, workerId, {
        stage: current.stage,
        nextAttemptAt: this.clock().toISOString(),
        incrementStageAttempt: false,
        errorCode: current.error_code ?? 'shutdown',
        errorMessage: current.error_message ?? 'Worker shutting down',
      });
      this.logger?.info({ jobId: current.id }, 'Released job due to shutdown');
    } catch (error) {
      this.logger?.warn(
        { jobId: current.id, error: sanitizeErrorMessage(error) },
        'Failed to release job during shutdown',
      );
    }
  }

  private async finalizeDone(job: JobRow): Promise<void> {
    const current = this.deps.jobs.getById(job.id) ?? job;
    if (!TERMINAL_STATUSES.has(current.status)) {
      const cancelled = current.failed_stage === 'cancelled';
      const failed = current.failed_stage !== null;
      const status: FinalizeJobOptions['status'] = failed
        ? cancelled
          ? 'cancelled'
          : 'failed'
        : 'completed';
      const options: FinalizeJobOptions =
        status === 'completed'
          ? { status }
          : {
              status,
              errorCode: current.error_code ?? (status === 'cancelled' ? 'cancelled' : 'processing_failed'),
              errorMessage:
                current.error_message ?? (status === 'cancelled' ? 'Cancelled' : 'Processing failed'),
            };
      this.deps.jobs.finalize(current.id, options, this.clock());
    }

    await this.cleanupTemp(current.id);
  }

  private async cleanupTemp(jobId: string): Promise<void> {
    try {
      await this.deps.local.cleanupTempDir(jobId);
    } catch (error) {
      const message = sanitizeErrorMessage(error);
      this.deps.jobs.appendEvent({
        jobId,
        event: 'temp_cleanup_failed',
        level: 'warn',
        message,
        at: this.clock().toISOString(),
      });
      this.logger?.warn({ jobId, error: message }, 'Temp cleanup failed');
    }
  }

  private timeoutFor(job: JobRow): number {
    const env = this.deps.env;
    switch (job.stage) {
      case 'download':
        return env.STAGE_TIMEOUT_DOWNLOAD_MS;
      case 'verify':
      case 'deduplicate':
        return env.STAGE_TIMEOUT_VERIFY_MS;
      case 'convert': {
        const classification = classifyMedia(job.file_name ?? '', job.mime_type);
        return classification.kind === 'video'
          ? env.STAGE_TIMEOUT_CONVERT_VIDEO_MS
          : env.STAGE_TIMEOUT_CONVERT_IMAGE_MS;
      }
      case 'thumbnails':
        return env.STAGE_TIMEOUT_THUMBNAILS_MS;
      case 'store':
        return env.STAGE_TIMEOUT_STORE_MS;
      case 'respond':
        return env.STAGE_TIMEOUT_RESPOND_MS;
      case 'delete_temp':
        return env.STAGE_TIMEOUT_DELETE_MS;
      default:
        return env.STAGE_TIMEOUT_STORE_MS;
    }
  }
}

interface LinkedSignal {
  signal: AbortSignal;
  cleanup: () => void;
}

function linkSignals(signals: AbortSignal[]): LinkedSignal {
  const anyFn = (AbortSignal as unknown as { any?: (values: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') {
    return { signal: anyFn.call(AbortSignal, signals), cleanup: () => undefined };
  }

  const controller = new AbortController();
  const removers: Array<() => void> = [];
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    removers.push(() => signal.removeEventListener('abort', onAbort));
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const remove of removers) remove();
    },
  };
}
