import { Worker } from 'node:worker_threads';

const DEFAULT_HASH_TIMEOUT_MS = 300_000;
const DEFAULT_MEDIA_TIMEOUT_MS = 600_000;
const DEFAULT_JPEG_QUALITY = 90;

export type MediaWorkerErrorCode =
  | 'WORKER_ABORTED'
  | 'WORKER_TIMEOUT'
  | 'WORKER_FAILED'
  | 'WORKER_CRASHED'
  | 'WORKER_EXIT';

export class MediaWorkerError extends Error {
  readonly code: MediaWorkerErrorCode;

  constructor(message: string, code: MediaWorkerErrorCode = 'WORKER_FAILED', cause?: unknown) {
    super(message, { cause });
    this.name = 'MediaWorkerError';
    this.code = code;
  }
}

export class MediaWorkerAbortError extends MediaWorkerError {
  constructor() {
    super('Media worker was aborted', 'WORKER_ABORTED');
    this.name = 'MediaWorkerAbortError';
  }
}

export class MediaWorkerTimeoutError extends MediaWorkerError {
  constructor(timeoutMs: number) {
    super(`Media worker timed out after ${timeoutMs} ms`, 'WORKER_TIMEOUT');
    this.name = 'MediaWorkerTimeoutError';
  }
}

interface WorkerMessage {
  type?: unknown;
  bytes?: unknown;
  total?: unknown;
  hash?: unknown;
  width?: unknown;
  height?: unknown;
  message?: unknown;
}

interface RunWorkerOptions<Result> {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (message: WorkerMessage) => void;
  parseResult: (message: WorkerMessage) => Result | null;
}

const isTypeScriptSource =
  import.meta.url.endsWith('.ts') || import.meta.url.endsWith('.tsx');

function workerUrl(name: 'hash' | 'media'): URL {
  return isTypeScriptSource
    ? new URL(`../workers/${name}.worker.ts`, import.meta.url)
    : new URL(`./workers/${name}.worker.js`, import.meta.url);
}

function workerExecArgv(): string[] | undefined {
  return isTypeScriptSource ? ['--import', 'tsx'] : undefined;
}

function configuredTimeout(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toSafeMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Media worker failed';
}

function runWorker<Result>(
  url: URL,
  payload: unknown,
  options: RunWorkerOptions<Result>,
): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new MediaWorkerAbortError());
      return;
    }

    const execArgv = workerExecArgv();
    const worker = new Worker(url, execArgv ? { execArgv } : {});
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      void worker.terminate().catch(() => undefined);
    };

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };

    const fail = (error: Error): void => settle(() => reject(error));

    const onAbort = (): void => fail(new MediaWorkerAbortError());

    options.signal?.addEventListener('abort', onAbort, { once: true });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(
        () => fail(new MediaWorkerTimeoutError(options.timeoutMs ?? 0)),
        options.timeoutMs,
      );
    }

    worker.on('message', (message: WorkerMessage) => {
      if (typeof message !== 'object' || message === null) return;

      if (message.type === 'progress') {
        options.onProgress?.(message);
        return;
      }

      if (message.type === 'result') {
        const result = options.parseResult(message);
        if (result === null) {
          fail(new MediaWorkerError('Media worker returned an invalid result'));
          return;
        }
        settle(() => resolve(result));
        return;
      }

      if (message.type === 'error') {
        fail(
          new MediaWorkerError(
            typeof message.message === 'string' ? message.message : 'Media worker failed',
          ),
        );
      }
    });

    worker.on('error', (error) => {
      fail(
        error instanceof MediaWorkerError
          ? error
          : new MediaWorkerError(toSafeMessage(error), 'WORKER_CRASHED', error),
      );
    });

    worker.on('exit', (code) => {
      if (settled) return;
      fail(new MediaWorkerError(`Media worker exited unexpectedly (${code})`, 'WORKER_EXIT'));
    });

    worker.postMessage(payload);
  });
}

export interface HashWorkerOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (bytes: number, total: number) => void;
}

/** Runs the streaming SHA-256 worker and returns lowercase hex. */
export function runHashWorker(filePath: string, options: HashWorkerOptions = {}): Promise<string> {
  return runWorker<string>(
    workerUrl('hash'),
    { type: 'hash', path: filePath },
    {
      signal: options.signal,
      timeoutMs:
        options.timeoutMs ?? configuredTimeout('HASH_WORKER_TIMEOUT_MS', DEFAULT_HASH_TIMEOUT_MS),
      onProgress: (message) => {
        const bytes = typeof message.bytes === 'number' ? message.bytes : 0;
        const total = typeof message.total === 'number' ? message.total : 0;
        options.onProgress?.(bytes, total);
      },
      parseResult: (message) => (typeof message.hash === 'string' ? message.hash : null),
    },
  );
}

export interface MediaConversionOptions {
  quality?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface MediaConversionResult {
  width: number | null;
  height: number | null;
}

function runMediaConversion(
  type: 'heic' | 'raw',
  input: string,
  output: string,
  options: MediaConversionOptions,
): Promise<MediaConversionResult> {
  return runWorker<MediaConversionResult>(
    workerUrl('media'),
    {
      type,
      input,
      output,
      quality: options.quality ?? DEFAULT_JPEG_QUALITY,
    },
    {
      signal: options.signal,
      timeoutMs:
        options.timeoutMs ??
        configuredTimeout('MEDIA_WORKER_TIMEOUT_MS', DEFAULT_MEDIA_TIMEOUT_MS),
      parseResult: (message) => ({
        width: typeof message.width === 'number' ? message.width : null,
        height: typeof message.height === 'number' ? message.height : null,
      }),
    },
  );
}

export function runHeicConversion(
  input: string,
  output: string,
  options: MediaConversionOptions = {},
): Promise<MediaConversionResult> {
  return runMediaConversion('heic', input, output, options);
}

export function runRawConversion(
  input: string,
  output: string,
  options: MediaConversionOptions = {},
): Promise<MediaConversionResult> {
  return runMediaConversion('raw', input, output, options);
}
