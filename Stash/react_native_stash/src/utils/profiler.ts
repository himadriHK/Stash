/**
 * Local-first, zero-dependency function profiler.
 *
 * The Stash app spends its time in a handful of hot paths (folder scanning,
 * SHA-256 hashing, SQLite ingestion, uploads, Kafka response handling and React
 * renders). This module records how long each instrumented function takes,
 * aggregates the samples in memory, and renders a function-level report
 * (calls, self time, total time, average, max) so bottlenecks are visible
 * without any external service.
 *
 * Design goals:
 * - No behavior change. Wrapping a function only measures it; results and
 *   thrown errors are passed through untouched.
 * - Near-zero cost when disabled. Disabled by default in release builds
 *   (`__DEV__` gates it) and overridable with `EXPO_PUBLIC_STASH_PROFILE`.
 * - Optional Sentry bridge. When a Sentry DSN is configured, `src/services/
 *   sentry.ts` registers a span hook so every profiled span also becomes a
 *   Sentry span, producing flame graphs in the Sentry dashboard later.
 *
 * Self time is best-effort: inclusive totals are exact, while the split between
 * a function and its children is computed from a nesting stack and can be
 * approximate when instrumented spans run concurrently (for example parallel
 * uploads). Use inclusive time and max latency as the primary signals.
 */
import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';

export type ProfileAttrs = Record<string, unknown>;

/** A started span the caller finishes when the measured work ends. */
export interface ProfileSpan {
  finish: (attrs?: ProfileAttrs) => void;
}

export interface ProfileStat {
  name: string;
  calls: number;
  totalMs: number;
  selfMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
}

export interface ProfileReportOptions {
  /** Rows per table (default 25). */
  top?: number;
  /** Include the slowest-recent-spans list (default true). */
  includeRecentSlow?: boolean;
}

export interface ProfileOptions {
  /** Arbitrary attributes attached to the span (also forwarded to Sentry). */
  attrs?: ProfileAttrs;
  /**
   * Record as a flat span that does not join the nesting stack. Use for spans
   * that run concurrently so they do not corrupt parent/child attribution.
   */
  detached?: boolean;
  /** Forward to Sentry when the bridge is installed (default true). */
  sentry?: boolean;
}

/** Installed by `src/services/sentry.ts` to mirror spans into Sentry. */
export type SpanHook = (name: string, attrs: ProfileAttrs | undefined) => ProfileSpan | null;

interface Aggregate {
  calls: number;
  totalMs: number;
  selfMs: number;
  minMs: number;
  maxMs: number;
  lastMs: number;
  lastAttrs?: ProfileAttrs;
}

interface ActiveSpan {
  name: string;
  start: number;
  childMs: number;
  attrs?: ProfileAttrs;
  detached: boolean;
  hookSpan: ProfileSpan | null;
}

const PROFILE_LOG_DIRECTORY = 'logs';
const PROFILE_LOG_FILE = 'stash-profile.log';
const MAX_PROFILE_LOG_BYTES = 512 * 1024;
const KEEP_PROFILE_LOG_BYTES = 256 * 1024;

/** Spans at or above one 60fps frame are surfaced as "slow". */
const SLOW_SPAN_MS = 16;
const MAX_RECENT_SLOW = 100;

interface PerfLike {
  now(): number;
}

const perf = (globalThis as { performance?: PerfLike }).performance;
const clock: () => number =
  perf && typeof perf.now === 'function' ? () => perf.now() : () => Date.now();

function readFlag(raw: string | undefined): boolean | null {
  if (raw === undefined) {
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (value === '') {
    return null;
  }
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') {
    return true;
  }
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') {
    return false;
  }
  return null;
}

function defaultEnabled(): boolean {
  return typeof __DEV__ !== 'undefined' ? __DEV__ : false;
}

let enabled: boolean = readFlag(process.env.EXPO_PUBLIC_STASH_PROFILE) ?? defaultEnabled();
let spanHook: SpanHook | null = null;
const aggregates = new Map<string, Aggregate>();
const stack: ActiveSpan[] = [];
const recentSlow: { name: string; ms: number; at: number }[] = [];
let totalSpans = 0;

export function isProfilerEnabled(): boolean {
  return enabled;
}

export function setProfilerEnabled(next: boolean): void {
  enabled = next;
}

/** Installs the optional Sentry bridge (see `src/services/sentry.ts`). */
export function setProfilingSpanHook(hook: SpanHook | null): void {
  spanHook = hook;
}

function recordAggregate(
  name: string,
  inclusiveMs: number,
  selfMs: number,
  attrs?: ProfileAttrs,
): void {
  let aggregate = aggregates.get(name);
  if (!aggregate) {
    aggregate = { calls: 0, totalMs: 0, selfMs: 0, minMs: Infinity, maxMs: 0, lastMs: 0 };
    aggregates.set(name, aggregate);
  }
  aggregate.calls += 1;
  aggregate.totalMs += inclusiveMs;
  aggregate.selfMs += Math.max(0, selfMs);
  aggregate.minMs = Math.min(aggregate.minMs, inclusiveMs);
  aggregate.maxMs = Math.max(aggregate.maxMs, inclusiveMs);
  aggregate.lastMs = inclusiveMs;
  if (attrs) {
    aggregate.lastAttrs = attrs;
  }
  totalSpans += 1;

  if (inclusiveMs >= SLOW_SPAN_MS) {
    recentSlow.push({ name, ms: inclusiveMs, at: Date.now() });
    if (recentSlow.length > MAX_RECENT_SLOW) {
      recentSlow.shift();
    }
  }
}

function beginSpan(
  name: string,
  attrs: ProfileAttrs | undefined,
  detached: boolean,
  forward: boolean,
): ActiveSpan {
  let hookSpan: ProfileSpan | null = null;
  if (forward && spanHook) {
    try {
      hookSpan = spanHook(name, attrs);
    } catch {
      hookSpan = null;
    }
  }
  const span: ActiveSpan = { name, start: clock(), childMs: 0, attrs, detached, hookSpan };
  if (!detached) {
    stack.push(span);
  }
  return span;
}

function endSpan(span: ActiveSpan, attrs?: ProfileAttrs): void {
  const duration = Math.max(0, clock() - span.start);

  if (!span.detached) {
    const index = stack.lastIndexOf(span);
    if (index >= 0) {
      stack.splice(index, 1);
      const parent = index > 0 ? stack[index - 1] : undefined;
      if (parent) {
        parent.childMs += duration;
      }
    }
  }

  const self = span.detached ? duration : Math.max(0, duration - span.childMs);
  recordAggregate(span.name, duration, self, attrs ?? span.attrs);

  if (span.hookSpan) {
    try {
      span.hookSpan.finish(attrs ?? span.attrs);
    } catch {
      // A failing Sentry span must never affect the measured code.
    }
  }
}

/** Times an async function. Rejections pass through unchanged. */
export function profileAsync<T>(
  name: string,
  fn: () => Promise<T>,
  options?: ProfileOptions,
): Promise<T> {
  if (!enabled) {
    return fn();
  }
  const span = beginSpan(name, options?.attrs, options?.detached === true, options?.sentry !== false);
  return Promise.resolve()
    .then(fn)
    .finally(() => endSpan(span, options?.attrs));
}

/** Times a synchronous function. Thrown errors pass through unchanged. */
export function profileSync<T>(
  name: string,
  fn: () => T,
  options?: ProfileOptions,
): T {
  if (!enabled) {
    return fn();
  }
  const span = beginSpan(name, options?.attrs, options?.detached === true, options?.sentry !== false);
  try {
    return fn();
  } finally {
    endSpan(span, options?.attrs);
  }
}

/** Starts a span the caller finishes manually (for methods with many exits). */
export function startProfileSpan(name: string, options?: ProfileOptions): ProfileSpan {
  if (!enabled) {
    return { finish: () => undefined };
  }
  const span = beginSpan(name, options?.attrs, options?.detached === true, options?.sentry !== false);
  return { finish: (attrs?: ProfileAttrs) => endSpan(span, attrs) };
}

/** Records a leaf timing (for example a React render) with no children. */
export function recordEvent(name: string, durationMs: number, attrs?: ProfileAttrs): void {
  if (!enabled) {
    return;
  }
  const duration = Math.max(0, durationMs);
  recordAggregate(name, duration, duration, attrs);
}

export function resetProfile(): void {
  aggregates.clear();
  stack.length = 0;
  recentSlow.length = 0;
  totalSpans = 0;
}

export function getProfileStats(): ProfileStat[] {
  const stats: ProfileStat[] = [];
  for (const [name, aggregate] of aggregates) {
    stats.push({
      name,
      calls: aggregate.calls,
      totalMs: aggregate.totalMs,
      selfMs: aggregate.selfMs,
      avgMs: aggregate.calls > 0 ? aggregate.totalMs / aggregate.calls : 0,
      minMs: Number.isFinite(aggregate.minMs) ? aggregate.minMs : 0,
      maxMs: aggregate.maxMs,
    });
  }
  return stats;
}

export function getProfileSpanCount(): number {
  return totalSpans;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return '—';
  }
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  if (ms >= 100) {
    return ms.toFixed(0);
  }
  if (ms >= 10) {
    return ms.toFixed(1);
  }
  return ms.toFixed(2);
}

function renderTable(stats: ProfileStat[]): string {
  const header =
    '    ' +
    padRight('function', 36) +
    padLeft('calls', 8) +
    padLeft('self', 10) +
    padLeft('total', 10) +
    padLeft('avg', 9) +
    padLeft('max', 9);
  const rows = stats.map(
    (stat) =>
      '    ' +
      padRight(stat.name, 36) +
      padLeft(String(stat.calls), 8) +
      padLeft(fmtMs(stat.selfMs), 10) +
      padLeft(fmtMs(stat.totalMs), 10) +
      padLeft(fmtMs(stat.avgMs), 9) +
      padLeft(fmtMs(stat.maxMs), 9),
  );
  return [header, ...rows].join('\n');
}

/** Builds the human-readable function-level profile. */
export function getProfileReportText(options: ProfileReportOptions = {}): string {
  if (!enabled) {
    return 'Stash performance profile: disabled (set EXPO_PUBLIC_STASH_PROFILE=1 to enable).';
  }
  const top = Math.max(1, Math.floor(options.top ?? 25));
  const stats = getProfileStats();
  if (stats.length === 0) {
    return 'Stash performance profile: no samples recorded yet.';
  }

  const bySelf = [...stats].sort((a, b) => b.selfMs - a.selfMs || b.totalMs - a.totalMs);
  const byTotal = [...stats].sort((a, b) => b.totalMs - a.totalMs || b.maxMs - a.maxMs);

  const lines: string[] = [];
  lines.push('Stash performance profile (cumulative since last reset)');
  lines.push(
    `  generated: ${new Date().toISOString()}  spans: ${totalSpans}  distinct functions: ${stats.length}`,
  );
  lines.push('');
  lines.push('  TOP FUNCTIONS BY SELF TIME (best-effort exclusive; highest = likely bottleneck)');
  lines.push(renderTable(bySelf.slice(0, top)));
  lines.push('');
  lines.push('  TOP FUNCTIONS BY TOTAL (INCLUSIVE) TIME');
  lines.push(renderTable(byTotal.slice(0, top)));

  if (options.includeRecentSlow !== false && recentSlow.length > 0) {
    const slowest = [...recentSlow].sort((a, b) => b.ms - a.ms).slice(0, 15);
    lines.push('');
    lines.push(`  SLOWEST RECENT SPANS (>= ${SLOW_SPAN_MS}ms)`);
    for (const span of slowest) {
      lines.push(`    ${padLeft(fmtMs(span.ms), 8)}ms  ${span.name}`);
    }
  }

  return lines.join('\n');
}

/** Prints the profile to the Metro/device console. */
export function printProfileSummary(options?: ProfileReportOptions): void {
  if (!enabled) {
    return;
  }
  console.info(getProfileReportText(options));
}

function profileLoggingAvailable(): boolean {
  return Platform.OS !== 'web';
}

/** Absolute URI of the profile log file, or null when unavailable. */
export function profileLogUri(): string | null {
  if (!profileLoggingAvailable()) {
    return null;
  }
  try {
    const directory = new Directory(Paths.document, PROFILE_LOG_DIRECTORY);
    return new File(directory, PROFILE_LOG_FILE).uri;
  } catch {
    return null;
  }
}

function prepareProfileFile(): File {
  const directory = new Directory(Paths.document, PROFILE_LOG_DIRECTORY);
  if (!directory.exists) {
    directory.create({ intermediates: true, idempotent: true });
  }
  const file = new File(directory, PROFILE_LOG_FILE);
  if (!file.exists) {
    file.create();
  }
  return file;
}

async function trimProfileFileIfNeeded(file: File): Promise<void> {
  if (file.size <= MAX_PROFILE_LOG_BYTES) {
    return;
  }
  const text = await file.text();
  await file.write(text.slice(-KEEP_PROFILE_LOG_BYTES));
}

let profileWriteQueue: Promise<void> = Promise.resolve();

/** Appends the current profile to `logs/stash-profile.log` (serialized). */
export function appendProfileReportToFile(reason?: string): Promise<void> {
  if (!profileLoggingAvailable()) {
    return Promise.resolve();
  }
  const header = reason ? `\n===== profile: ${reason} =====` : '\n===== profile =====';
  const body = `${header}\n${getProfileReportText()}\n`;

  profileWriteQueue = profileWriteQueue.then(async () => {
    try {
      const file = prepareProfileFile();
      await trimProfileFileIfNeeded(file);
      await file.write(body, { append: true });
    } catch (error) {
      console.error('[profiler] Could not write the profile log.', error);
    }
  });
  return profileWriteQueue;
}

/** Reads the most recent part of the profile log, for display in-app. */
export async function readProfileLogTailAsync(maxChars = 20000): Promise<string> {
  if (!profileLoggingAvailable()) {
    return '';
  }
  try {
    const directory = new Directory(Paths.document, PROFILE_LOG_DIRECTORY);
    const file = new File(directory, PROFILE_LOG_FILE);
    if (!file.exists) {
      return '';
    }
    const text = await file.text();
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch (error) {
    return `Could not read the profile log: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Deletes the profile log; the next flush recreates it. */
export async function clearProfileLogAsync(): Promise<void> {
  if (!profileLoggingAvailable()) {
    return;
  }
  try {
    const directory = new Directory(Paths.document, PROFILE_LOG_DIRECTORY);
    const file = new File(directory, PROFILE_LOG_FILE);
    if (file.exists) {
      file.delete();
    }
  } catch (error) {
    console.error('[profiler] Could not delete the profile log.', error);
  }
}