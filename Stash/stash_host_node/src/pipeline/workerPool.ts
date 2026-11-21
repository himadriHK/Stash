import type { Logger } from 'pino';

import type { AppEnv } from '../config/env';
import type { JobRepository } from '../db/jobs';
import type { OutboxRepository } from '../db/outbox';
import type { LocalLibrary } from '../storage/local';
import { sanitizeErrorMessage } from './response';
import type { PipelineRunner } from './runner';
import { cleanupStaleTempDirs, type TempCleanupResult } from './tempCleanup';

export interface WorkerPoolDeps {
  env: AppEnv;
  jobs: JobRepository;
  outbox: OutboxRepository;
  runner: PipelineRunner;
  local: LocalLibrary;
  logger?: Logger;
  now?: () => Date;
}

export interface WorkerPoolStatus {
  closed: boolean;
  workers: number;
  running: number;
  queued: number;
  lastError: string | null;
}

const IDLE_SLEEP_MS = 1_000;
const IDLE_JITTER_MS = 500;

export class WorkerPool {
  private readonly abort = new AbortController();
  private readonly loops: Promise<void>[] = [];
  private readonly clock: () => Date;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private started = false;
  private closed = false;
  private running = 0;
  private lastError: string | null = null;

  constructor(private readonly deps: WorkerPoolDeps) {
    this.clock = deps.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (!this.deps.env.WORKER_ENABLED) {
      this.deps.logger?.info('Worker pool is disabled by configuration');
      return;
    }

    try {
      this.deps.jobs.recoverExpiredLeases(this.clock());
      this.deps.outbox.markAllSendingAsPending(this.clock());
    } catch (error) {
      this.lastError = sanitizeErrorMessage(error);
      this.deps.logger?.warn({ error: this.lastError }, 'Worker pool startup recovery failed');
    }

    await this.runTempCleanup();

    for (let index = 0; index < this.deps.env.WORKER_CONCURRENCY; index += 1) {
      const workerId = `worker-${index + 1}`;
      this.loops.push(this.loop(workerId));
    }

    const intervalMs = Math.max(1_000, this.deps.env.RECOVERY_INTERVAL_SECONDS * 1_000);
    this.recoveryTimer = setInterval(() => {
      if (this.closed) return;
      try {
        this.deps.jobs.recoverExpiredLeases(this.clock());
      } catch (error) {
        this.lastError = sanitizeErrorMessage(error);
        this.deps.logger?.warn({ error: this.lastError }, 'Lease recovery failed');
      }
      void this.runTempCleanup();
    }, intervalMs);
    if (typeof this.recoveryTimer.unref === 'function') this.recoveryTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort(new Error('Worker pool stopped'));
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    await Promise.allSettled(this.loops);
  }

  getStatus(): WorkerPoolStatus {
    return {
      closed: this.closed,
      workers: this.loops.length,
      running: this.running,
      queued: this.deps.jobs.countQueued(),
      lastError: this.lastError,
    };
  }

  countQueued(): number {
    return this.deps.jobs.countQueued();
  }

  private async loop(workerId: string): Promise<void> {
    while (!this.closed) {
      let job;
      try {
        job = this.deps.jobs.claimNextJob(workerId, this.deps.env.LEASE_SECONDS, this.clock());
      } catch (error) {
        this.lastError = sanitizeErrorMessage(error);
        this.deps.logger?.warn({ workerId, error: this.lastError }, 'Job claim failed');
        await sleep(IDLE_SLEEP_MS, this.abort.signal);
        continue;
      }

      if (!job) {
        await sleep(IDLE_SLEEP_MS + Math.floor(Math.random() * IDLE_JITTER_MS), this.abort.signal);
        continue;
      }

      this.running += 1;
      try {
        await this.deps.runner.runJob(job, workerId, this.abort.signal);
      } catch (error) {
        this.lastError = sanitizeErrorMessage(error);
        this.deps.logger?.error(
          { workerId, jobId: job.id, error: this.lastError },
          'Pipeline job failed unexpectedly',
        );
      } finally {
        this.running = Math.max(0, this.running - 1);
      }
    }
  }

  private async runTempCleanup(): Promise<TempCleanupResult | null> {
    try {
      return await cleanupStaleTempDirs({
        local: this.deps.local,
        retentionHours: this.deps.env.TEMP_RETENTION_HOURS,
        isActiveJob: (jobId) => {
          const job = this.deps.jobs.getById(jobId);
          return job !== null && (job.status === 'queued' || job.status === 'running');
        },
        logger: this.deps.logger,
        now: this.clock,
      });
    } catch (error) {
      this.lastError = sanitizeErrorMessage(error);
      this.deps.logger?.warn({ error: this.lastError }, 'Temp cleanup failed');
      return null;
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    const done = (): void => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };

    timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
