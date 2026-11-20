/**
 * Persistent error log with stack traces.
 *
 * Errors are appended to `<documents>/logs/stash-errors.log` on iOS/Android so
 * they survive a reload and can be pulled off a device after a failure. The
 * browser has no writable file log, so web only mirrors to the console.
 *
 * Logging must never break the caller: every failure inside this module is
 * swallowed and reported through `console.error`.
 */
import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';

const LOG_DIRECTORY_NAME = 'logs';
const LOG_FILE_NAME = 'stash-errors.log';
/** Rotate once the log grows past this size, keeping the most recent half. */
const MAX_LOG_BYTES = 512 * 1024;
const KEEP_LOG_BYTES = 256 * 1024;

export type ErrorContext = Record<string, unknown>;

/** Serializes writes so concurrent failures cannot interleave in the file. */
let writeQueue: Promise<void> = Promise.resolve();
let announcedLocation = false;

export function errorLoggingAvailable(): boolean {
  return Platform.OS !== 'web';
}

/** Absolute URI of the log file, or null when file logging is unavailable. */
export function errorLogUri(): string | null {
  if (!errorLoggingAvailable()) {
    return null;
  }
  try {
    const directory = new Directory(Paths.document, LOG_DIRECTORY_NAME);
    return new File(directory, LOG_FILE_NAME).uri;
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** Uses the thrown error's stack; otherwise captures the logging call site. */
function stackOf(error: unknown): string {
  if (error instanceof Error && error.stack) {
    return error.stack;
  }
  return new Error('stack captured at log time').stack ?? '(no stack available)';
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatEntry(scope: string, error: unknown, context?: ErrorContext): string {
  const lines = [
    '='.repeat(72),
    `[${new Date().toISOString()}] ${scope}`,
    `platform: ${Platform.OS} ${String(Platform.Version)}`,
    `message: ${messageOf(error)}`,
  ];
  for (const [key, value] of Object.entries(context ?? {})) {
    if (value !== undefined) {
      lines.push(`${key}: ${formatValue(value)}`);
    }
  }
  lines.push('stack:', stackOf(error), '');
  return `${lines.join('\n')}\n`;
}

function prepareLogFile(): File {
  const directory = new Directory(Paths.document, LOG_DIRECTORY_NAME);
  if (!directory.exists) {
    directory.create({ intermediates: true, idempotent: true });
  }
  const file = new File(directory, LOG_FILE_NAME);
  if (!file.exists) {
    file.create();
  }
  return file;
}

/** Keeps the log bounded by dropping the oldest bytes when it grows too large. */
async function trimIfNeededAsync(file: File): Promise<void> {
  if (file.size <= MAX_LOG_BYTES) {
    return;
  }
  const text = await file.text();
  await file.write(text.slice(-KEEP_LOG_BYTES));
}

function trimIfNeededSync(file: File): void {
  if (file.size <= MAX_LOG_BYTES) {
    return;
  }
  const text = file.textSync();
  file.writeSync(text.slice(-KEEP_LOG_BYTES));
}

async function appendAsync(entry: string): Promise<void> {
  try {
    const file = prepareLogFile();
    await trimIfNeededAsync(file);
    await file.write(entry, { append: true });
  } catch (loggingError) {
    console.error('[errorLogger] Could not write the error log file.', loggingError);
  }
}

function appendSync(entry: string): void {
  try {
    const file = prepareLogFile();
    trimIfNeededSync(file);
    file.writeSync(entry, { append: true });
  } catch (loggingError) {
    console.error('[errorLogger] Could not write the error log file.', loggingError);
  }
}

/**
 * Appends one entry with message, context and stack trace.
 *
 * @param scope Where it happened, e.g. `fileAccess.readFileBytes.contentUri`.
 */
export function logError(scope: string, error: unknown, context?: ErrorContext): Promise<void> {
  const entry = formatEntry(scope, error, context);
  console.error(`[${scope}] ${messageOf(error)}`, error);

  if (!errorLoggingAvailable()) {
    return Promise.resolve();
  }

  writeQueue = writeQueue.then(() => appendAsync(entry));
  return writeQueue;
}

/** Synchronous variant for crash handlers, where promises may not settle. */
export function logErrorSync(scope: string, error: unknown, context?: ErrorContext): void {
  const entry = formatEntry(scope, error, context);
  console.error(`[${scope}] ${messageOf(error)}`, error);

  if (!errorLoggingAvailable()) {
    return;
  }
  appendSync(entry);
}

/** Reads the most recent part of the log, for display inside the app. */
export async function readErrorLogTailAsync(maxChars = 20000): Promise<string> {
  if (!errorLoggingAvailable()) {
    return '';
  }
  try {
    const directory = new Directory(Paths.document, LOG_DIRECTORY_NAME);
    const file = new File(directory, LOG_FILE_NAME);
    if (!file.exists) {
      return '';
    }
    const text = await file.text();
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch (error) {
    return `Could not read the error log: ${messageOf(error)}`;
  }
}

/** Deletes the log file; the next logged error recreates it. */
export async function clearErrorLogAsync(): Promise<void> {
  if (!errorLoggingAvailable()) {
    return;
  }
  try {
    const directory = new Directory(Paths.document, LOG_DIRECTORY_NAME);
    const file = new File(directory, LOG_FILE_NAME);
    if (file.exists) {
      file.delete();
    }
  } catch (error) {
    console.error('[errorLogger] Could not delete the error log file.', error);
  }
}

export function announceErrorLogLocation(): void {
  if (announcedLocation || !errorLoggingAvailable()) {
    return;
  }
  announcedLocation = true;
  const uri = errorLogUri();
  if (uri) {
    console.log(`[errorLogger] Writing errors with stack traces to ${uri}`);
  }
}

type GlobalErrorHandler = (error: Error, isFatal?: boolean) => void;

interface ErrorUtilsLike {
  getGlobalHandler?: () => GlobalErrorHandler;
  setGlobalHandler?: (handler: GlobalErrorHandler) => void;
  __stashErrorLoggerInstalled?: boolean;
}

/**
 * Routes uncaught JS errors (including the ones that only show up on a device)
 * through the file log, then hands them to the previous handler so React
 * Native still shows/logs the red box behaviour.
 */
export function installGlobalErrorLogger(): void {
  announceErrorLogLocation();

  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (!errorUtils?.setGlobalHandler || errorUtils.__stashErrorLoggerInstalled) {
    return;
  }

  const previous = errorUtils.getGlobalHandler?.();
  errorUtils.setGlobalHandler((error, isFatal) => {
    logErrorSync('global.uncaughtError', error, { fatal: Boolean(isFatal) });
    previous?.(error, isFatal);
  });
  errorUtils.__stashErrorLoggerInstalled = true;
}
