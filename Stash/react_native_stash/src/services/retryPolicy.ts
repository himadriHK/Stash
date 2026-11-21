
const DEFAULT_BASE_MS = 30_000;
const DEFAULT_MAX_MS = 60 * 60 * 1000;
const MAX_JITTER_RATIO = 0.2;

export function nowIso(): string {
  return new Date().toISOString();
}

export function computeBackoffMs(
  attempt: number,
  baseMs: number = DEFAULT_BASE_MS,
  maxMs: number = DEFAULT_MAX_MS,
): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const safeBase = Number.isFinite(baseMs) ? Math.max(1, Math.floor(baseMs)) : DEFAULT_BASE_MS;
  const safeMax = Number.isFinite(maxMs) ? Math.max(safeBase, Math.floor(maxMs)) : DEFAULT_MAX_MS;
  const exponential = safeBase * Math.pow(2, safeAttempt - 1);
  const capped = Math.min(exponential, safeMax);
  const jitter = capped * MAX_JITTER_RATIO * Math.random();
  return Math.min(safeMax, Math.round(capped + jitter));
}

export function computeNextAttemptAt(attempt: number, now: Date = new Date()): string {
  return new Date(now.getTime() + computeBackoffMs(attempt)).toISOString();
}

export function isRetryableHttpStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

export function isTerminalHttpStatus(status: number): boolean {
  return (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 413 ||
    status === 422
  );
}

function readErrorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const candidate = error as { status?: unknown; statusCode?: unknown };
  if (typeof candidate.status === 'number') {
    return candidate.status;
  }
  if (typeof candidate.statusCode === 'number') {
    return candidate.statusCode;
  }
  return null;
}

/**
 * Auth failures are recoverable through a token refresh, so delivery code
 * keeps these messages pending instead of spending retry budget or
 * dead-lettering them.
 */
export function isAuthError(error: unknown): boolean {
  if (error === null || error === undefined) {
    return false;
  }

  const status = readErrorStatus(error);
  if (status === 401 || status === 403) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  const text = message.toLowerCase();
  if (/\b401\b|\b403\b/.test(text)) {
    return true;
  }
  return /missing (?:access )?token|expired (?:access )?token|access token|unauthori[sz]ed|forbidden|not authenticated|re-?authenticate|authentication required|sign in again/.test(
    text,
  );
}

export function isRetryableError(error: unknown): boolean {
  if (error === null || error === undefined) {
    return false;
  }

  const status = readErrorStatus(error);
  if (status !== null) {
    if (isRetryableHttpStatus(status)) {
      return true;
    }
    if (isTerminalHttpStatus(status)) {
      return false;
    }
    if (status >= 400 && status < 500) {
      return false;
    }
  }

  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return true;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  const text = message.toLowerCase();
  if (/network|fetch failed|failed to fetch|econn|etimedout|timeout|timed out|aborted|socket|offline/.test(text)) {
    return true;
  }
  if (/validation|invalid|config|configuration|not configured|unauthori[sz]ed|forbidden|authentication|\bauth\b|token/.test(text)) {
    return false;
  }
  return false;
}
