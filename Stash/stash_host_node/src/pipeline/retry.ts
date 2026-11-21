import type { Stage } from '../contracts/stages';
import { parseJsonObject } from '../db/json';
import type { JobRow } from '../db/jobs';
import { VideoError } from '../media/video';
import { MediaWorkerError } from '../media/workers';
import { S3Error } from '../storage/s3';
import { PathError } from '../storage/paths';

export type StageErrorKind = 'transient' | 'resource' | 'terminal';

export interface StageErrorOptions {
  kind: StageErrorKind;
  code?: string;
  cause?: unknown;
}

export class StageError extends Error {
  readonly kind: StageErrorKind;
  readonly code: string;

  constructor(message: string, options: StageErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'StageError';
    this.kind = options.kind;
    this.code = options.code ?? options.kind;
  }
}

const RESOURCE_CODES = new Set(['ENOSPC', 'EDQUOT', 'EMFILE', 'ENFILE', 'ENOMEM', 'EAGAIN']);
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
]);
const TERMINAL_FS_CODES = new Set(['EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'EINVAL', 'ELOOP']);
const TERMINAL_MESSAGE_PATTERN =
  /hash mismatch|hash_mismatch|size mismatch|size_mismatch|unsupported|corrupt|invalid (?:input|image|video|data)|not a (?:valid|supported)|empty output|no such codec|decoder/i;

function readCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function readName(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' ? error : 'Stage failed';
}

/**
 * Classifies a failure into retry behavior. Anything not clearly terminal is
 * treated as retryable so transient provider/worker failures can recover.
 */
export function classifyStageError(error: unknown, stage: Stage): StageError {
  if (error instanceof StageError) return error;

  if (error instanceof S3Error) {
    switch (error.code) {
      case 'S3_NOT_FOUND':
      case 'S3_ACCESS_DENIED':
        return new StageError(messageOf(error), { kind: 'terminal', code: error.code, cause: error });
      case 'S3_TRANSIENT':
      case 'S3_ABORTED':
        return new StageError(messageOf(error), { kind: 'transient', code: error.code, cause: error });
      default:
        return new StageError(messageOf(error), { kind: 'terminal', code: error.code, cause: error });
    }
  }

  if (error instanceof PathError) {
    return new StageError(messageOf(error), { kind: 'terminal', code: 'path_error', cause: error });
  }

  if (error instanceof VideoError) {
    switch (error.code) {
      case 'FFMPEG_NOT_FOUND':
      case 'FFPROBE_NOT_FOUND':
      case 'FFPROBE_FAILED':
      case 'FFMPEG_FAILED':
      case 'EMPTY_OUTPUT':
        return new StageError(messageOf(error), { kind: 'terminal', code: error.code, cause: error });
      case 'FFMPEG_TIMEOUT':
      case 'FFMPEG_ABORTED':
        return new StageError(messageOf(error), { kind: 'transient', code: error.code, cause: error });
      default:
        return new StageError(messageOf(error), { kind: 'terminal', code: error.code, cause: error });
    }
  }

  if (error instanceof MediaWorkerError) {
    switch (error.code) {
      case 'WORKER_TIMEOUT':
      case 'WORKER_ABORTED':
        return new StageError(messageOf(error), { kind: 'transient', code: error.code, cause: error });
      case 'WORKER_CRASHED':
      case 'WORKER_EXIT':
        return new StageError(messageOf(error), { kind: 'resource', code: error.code, cause: error });
      default:
        return new StageError(messageOf(error), { kind: 'terminal', code: error.code, cause: error });
    }
  }

  const code = readCode(error);
  const name = readName(error);
  const message = messageOf(error);

  if (name === 'AbortError' || code === 'ABORT_ERR') {
    return new StageError('Stage was aborted', { kind: 'transient', code: 'aborted', cause: error });
  }

  if (code && RESOURCE_CODES.has(code)) {
    return new StageError(message, { kind: 'resource', code, cause: error });
  }

  if (code === 'ENOENT') {
    // Temp sources can be re-downloaded; missing local permanent paths are
    // handled explicitly by the deduplicate/store stages.
    return new StageError(message, { kind: 'transient', code: 'source_missing', cause: error });
  }

  if (code && TERMINAL_FS_CODES.has(code)) {
    return new StageError(message, { kind: 'terminal', code, cause: error });
  }

  if (name === 'TimeoutError' || code === 'ETIMEDOUT' || /timed? ?out/i.test(message)) {
    return new StageError(message, { kind: 'transient', code: code ?? 'timeout', cause: error });
  }

  if (code && TRANSIENT_NETWORK_CODES.has(code)) {
    return new StageError(message, { kind: 'transient', code, cause: error });
  }

  if (TERMINAL_MESSAGE_PATTERN.test(message)) {
    return new StageError(message, { kind: 'terminal', code: 'unsupported_input', cause: error });
  }

  return new StageError(message, { kind: 'transient', code: code ?? `${stage}_failed`, cause: error });
}

/** Exponential backoff with full jitter (returns 0..ceiling). */
export function computeRetryDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const safeBase = Math.max(0, baseMs);
  const safeMax = Math.max(0, maxMs);
  const ceiling = Math.min(safeMax, safeBase * 2 ** (safeAttempt - 1));
  if (ceiling <= 0) return 0;
  return Math.min(ceiling, Math.floor(random() * (ceiling + 1)));
}

export function getStageAttempt(job: JobRow, stage: Stage | string): number {
  const attempts = parseJsonObject(job.stage_attempts_json);
  const value = attempts[stage];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export interface StageSignalHandle {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
}

interface CombinedSignal {
  signal: AbortSignal;
  cleanup: () => void;
}

function combineSignals(signals: AbortSignal[]): CombinedSignal {
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

interface TimeoutHandle {
  signal: AbortSignal;
  clear: () => void;
}

function createTimeoutSignal(timeoutMs: number): TimeoutHandle {
  const timeoutFn = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout;
  if (typeof timeoutFn === 'function') {
    return { signal: timeoutFn.call(AbortSignal, timeoutMs), clear: () => undefined };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('Stage timed out', 'TimeoutError'));
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * Builds an abort signal that fires on the external signal or when the stage
 * timeout elapses. `didTimeout()` distinguishes timeout aborts.
 */
export function createStageSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): StageSignalHandle {
  const timeout = createTimeoutSignal(Math.max(1, Math.floor(timeoutMs)));
  const combined = combineSignals(
    externalSignal ? [externalSignal, timeout.signal] : [timeout.signal],
  );

  return {
    signal: combined.signal,
    didTimeout: () => timeout.signal.aborted,
    cleanup: () => {
      combined.cleanup();
      timeout.clear();
    },
  };
}

export async function withStageTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<T> {
  const handle = createStageSignal(options.signal, options.timeoutMs);
  try {
    return await fn(handle.signal);
  } catch (error) {
    if (handle.didTimeout() && !options.signal?.aborted) {
      throw new StageError('Stage timed out', {
        kind: 'transient',
        code: 'stage_timeout',
        cause: error,
      });
    }
    throw error;
  } finally {
    handle.cleanup();
  }
}
