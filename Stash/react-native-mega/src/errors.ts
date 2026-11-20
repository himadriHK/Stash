export type MegaErrorCode =
  | 'ARGS'
  | 'INTERNAL'
  | 'BUSY'
  | 'RATE_LIMIT'
  | 'NOT_FOUND'
  | 'ACCESS'
  | 'EXISTS'
  | 'SESSION_EXPIRED'
  | 'OVER_QUOTA'
  | '2FA_REQUIRED'
  | 'MAC_MISMATCH'
  | 'HTTP'
  | 'BANDWIDTH_LIMIT'
  | 'NETWORK'
  | 'ABORTED'
  | 'UNSUPPORTED';

const API_ERRORS: Record<number, { code: MegaErrorCode; message: string; retryable: boolean }> = {
  1: { code: 'INTERNAL', message: 'MEGA internal error', retryable: true },
  2: { code: 'ARGS', message: 'Invalid arguments passed to MEGA', retryable: false },
  3: { code: 'BUSY', message: 'MEGA is temporarily busy', retryable: true },
  4: { code: 'RATE_LIMIT', message: 'MEGA command rate limit reached', retryable: true },
  5: { code: 'INTERNAL', message: 'Upload failed; restart it', retryable: true },
  6: { code: 'RATE_LIMIT', message: 'Too many connections to the upload server', retryable: true },
  7: { code: 'ARGS', message: 'Upload chunk is out of range or not chunk aligned', retryable: false },
  8: { code: 'BUSY', message: 'Upload URL expired; request a fresh one', retryable: true },
  9: { code: 'NOT_FOUND', message: 'Object not found (wrong password?)', retryable: false },
  11: { code: 'ACCESS', message: 'Access violation', retryable: false },
  12: { code: 'EXISTS', message: 'Object already exists', retryable: false },
  15: { code: 'SESSION_EXPIRED', message: 'Session expired; log in again', retryable: false },
  17: { code: 'OVER_QUOTA', message: 'Account storage quota exceeded', retryable: false },
  19: { code: 'RATE_LIMIT', message: 'Too many connections', retryable: true },
  24: { code: 'OVER_QUOTA', message: 'Transfer quota exceeded', retryable: false },
  26: { code: '2FA_REQUIRED', message: 'Two-factor authentication required', retryable: false },
  400: { code: 'ACCESS', message: 'Blocked by MEGA', retryable: false },
  401: { code: 'ACCESS', message: 'Sharer over quota', retryable: false },
};

export class MegaError extends Error {
  readonly code: MegaErrorCode;
  readonly apiCode?: number;
  readonly retryable: boolean;

  constructor(
    code: MegaErrorCode,
    message: string,
    options: { apiCode?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'MegaError';
    this.code = code;
    this.apiCode = options.apiCode;
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

export function errorFromApiCode(value: number): MegaError {
  const mapped = API_ERRORS[-value];
  if (mapped) {
    return new MegaError(mapped.code, `${mapped.message} (${value})`, {
      apiCode: value,
      retryable: mapped.retryable,
    });
  }
  return new MegaError('INTERNAL', `MEGA returned error ${value}`, {
    apiCode: value,
    retryable: value === -3,
  });
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { name?: string }).name === 'AbortError' ||
      (error as { code?: string }).code === 'ABORTED')
  );
}

export function abortError(): MegaError {
  return new MegaError('ABORTED', 'The operation was cancelled', { retryable: false });
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
