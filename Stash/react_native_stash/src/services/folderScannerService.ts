/**
 * FolderScannerService - discovers media files in configured folders and
 * reports their metadata (name, timestamps). File contents are never read
 * here: the host hashes the bytes it downloads. Mirrors
 * Stash.Maui/Services/FolderScannerService.cs.
 *
 * The scan deliberately does NOT collect file sizes. At one point every entry
 * needed a `getInfoAsync` stat just to learn its byte count; on Android SAF
 * that call opens an input stream per entry, which dominated the scan time for
 * large directories. Nothing in the pipeline needs the size (identity, dedupe,
 * batching and the upload request no longer carry it), so the scan no longer
 * asks for it.
 *
 * Scanning uses the legacy async `expo-file-system/legacy` API
 * (`readDirectoryAsync` + `getInfoAsync`): the synchronous `Directory.list()`
 * from the new expo-file-system API blocked the JS thread for the whole
 * enumeration (see `folder.scan` in stash-profile.log), while the legacy async
 * enumeration runs on the native side. `readDirectoryAsync` returns names/URIs
 * only, so `file://` entries are still stat'ed once to tell files from
 * directories and to read `modificationTime`; those stats run through a
 * bounded pool so enumeration stays non-blocking without an N-serial tail.
 *
 * Android SAF: `Directory.pickDirectoryAsync()` returns a `content://` tree
 * URI and `StorageAccessFramework.readDirectoryAsync` then returns full child
 * SAF URIs. A `content://` stat reports `isDirectory: false` for every entry
 * and no `modificationTime`, so SAF entries are not stat'ed at all: the only
 * thing that stat produced was the size this scan no longer needs. Plain
 * `file://` paths (manual entry / iOS) get child *names* from
 * `readDirectoryAsync`, so child URIs are built as `dirUri + '/' + name`.
 * Legacy `FileInfo` has no `creationTime`, so `createdAt` is derived from
 * `modificationTime`. Web rejects folder scans.
 *
 * Diagnostics: every phase of a scan (listing, stats, pattern matching, result
 * building, cooperative yields, subfolder recursion) is timed and reported at
 * INFO after each step. Slow directories are logged as they finish and every
 * scan ends with a section-total summary sorted by cumulative time, so the
 * slowest section of a sync is visible without the native profiler. Verbose
 * per-step lines for *every* directory are gated behind
 * `EXPO_PUBLIC_STASH_SCAN_LOG=1` because a 10k-file tree would otherwise emit
 * one console call per directory and skew the very timings it reports.
 */
import { Platform } from 'react-native';
import { getInfoAsync, readDirectoryAsync, StorageAccessFramework } from 'expo-file-system/legacy';
import type { FolderConfig } from '../models/folderConfig';
import { getMimeTypeFromFileName } from '../models/mediaPatterns';
import { logError } from '../utils/errorLogger';
import { isStoragePermissionError } from '../utils/storagePermissions';
import { mapWithConcurrencyAsync, shouldYield, yieldToEventLoop } from '../utils/cooperative';
import { profileAsync } from '../utils/profiler';

export interface ScannedFile {
  /** Full file URI (file://… or content://…). */
  uri: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  /** Raw epoch milliseconds from the platform. */
  modifiedAtMs?: number | null;
}

const WEB_FOLDER_ERROR =
  'Folder scanning is not available in the browser. Use Upload → Pick Files instead.';

/** Parallel `getInfoAsync` stat calls per directory. */
const STAT_CONCURRENCY = 10;

const SAF_URI_PREFIX = 'content://';

/** Directories slower than this get their own INFO line as soon as they finish. */
const SLOW_DIRECTORY_LOG_MS = 100;

/** Slow-directory samples kept for the end-of-scan summary. */
const SLOW_DIRECTORY_SAMPLE_COUNT = 5;

/** One `expo-file-system/legacy` stat result, narrowed to the existing case. */
interface LegacyFileInfo {
  exists: true;
  uri: string;
  isDirectory: boolean;
  modificationTime: number;
  md5?: string;
}

/** The only stat fields a scan uses; the byte size is not requested. */
interface ChildInfo {
  isDirectory: boolean;
  /** Legacy epoch seconds; absent for SAF entries, which are never stat'ed. */
  modificationTime?: number | null;
}

/** Per-entry stat outcome; `error` distinguishes vanished entries from denials. */
interface ChildStat {
  entry: string;
  childUri: string;
  info: ChildInfo | null;
  error: unknown;
}

interface WalkState {
  processed: number;
}

/** Cumulative per-section scan time. Sections are exclusive, not inclusive. */
interface ScanTotals {
  /** `readDirectoryAsync` / SAF enumeration. */
  listMs: number;
  /** Bounded `getInfoAsync` stat pool. */
  statMs: number;
  /** Include/exclude glob evaluation. */
  matchMs: number;
  /** Building `ScannedFile` entries for accepted files. */
  buildMs: number;
  /** Cooperative `yieldToEventLoop()` waits. */
  yieldMs: number;
  /** Time spent inside child `walkAsync` calls. */
  subfolderMs: number;
  directories: number;
  entries: number;
  files: number;
  slowestDirectories: DirectoryTiming[];
}

interface DirectoryTiming {
  path: string;
  totalMs: number;
  listMs: number;
  statMs: number;
  matchMs: number;
  entries: number;
  files: number;
}

function createScanTotals(): ScanTotals {
  return {
    listMs: 0,
    statMs: 0,
    matchMs: 0,
    buildMs: 0,
    yieldMs: 0,
    subfolderMs: 0,
    directories: 0,
    entries: 0,
    files: 0,
    slowestDirectories: [],
  };
}

const perf = (globalThis as { performance?: { now(): number } }).performance;
const nowMs: () => number =
  perf && typeof perf.now === 'function' ? () => perf.now() : () => Date.now();

function formatMs(value: number): string {
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)}ms`;
}

/** `1`/`true`/`yes`/`on` enables per-step lines for every directory. */
function verboseScanLoggingEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    (process.env.EXPO_PUBLIC_STASH_SCAN_LOG ?? '').trim().toLowerCase(),
  );
}

const VERBOSE_SCAN_LOG = verboseScanLoggingEnabled();

/** INFO line for scan diagnostics; always on so a scan can be timed in the field. */
function logScanInfo(message: string): void {
  console.info(`[folderScan] ${message}`);
}

function logScanVerbose(message: string): void {
  if (VERBOSE_SCAN_LOG) {
    logScanInfo(message);
  }
}

function recordSlowDirectory(totals: ScanTotals, timing: DirectoryTiming): void {
  const list = totals.slowestDirectories;
  list.push(timing);
  list.sort((left, right) => right.totalMs - left.totalMs);
  if (list.length > SLOW_DIRECTORY_SAMPLE_COUNT) {
    list.length = SLOW_DIRECTORY_SAMPLE_COUNT;
  }
}

/** Emits the end-of-scan section summary ordered by cumulative time. */
function logScanSummary(
  folderPath: string,
  totals: ScanTotals,
  totalMs: number,
  files: number,
): void {
  logScanInfo(
    `summary folder=${folderPath} total=${formatMs(totalMs)} dirs=${totals.directories} entries=${
      totals.entries
    } files=${files}`,
  );

  const sections: { name: string; ms: number }[] = [
    { name: 'subfolders', ms: totals.subfolderMs },
    { name: 'list', ms: totals.listMs },
    { name: 'stat', ms: totals.statMs },
    { name: 'match', ms: totals.matchMs },
    { name: 'build', ms: totals.buildMs },
    { name: 'yield', ms: totals.yieldMs },
  ].sort((left, right) => right.ms - left.ms);

  for (const section of sections) {
    const share = totalMs > 0 ? ((section.ms / totalMs) * 100).toFixed(1) : '0.0';
    logScanInfo(`section ${section.name} ${formatMs(section.ms)} (${share}%)`);
  }

  for (const directory of totals.slowestDirectories) {
    logScanInfo(
      `slowest dir=${directory.path} total=${formatMs(directory.totalMs)} list=${formatMs(
        directory.listMs,
      )} stat=${formatMs(directory.statMs)} match=${formatMs(directory.matchMs)} entries=${
        directory.entries
      } files=${directory.files}`,
    );
  }
}

/**
 * Case-insensitive glob match for `*` wildcards, anchored at both ends.
 * Replaces the regex-based matcher so the scan hot path never compiles or runs
 * a regex: `*` matches any run of characters (including none), everything else
 * is literal. Uses single-star backtracking, which is linear per star.
 */
export function globMatch(value: string, pattern: string): boolean {
  const text = value.toLowerCase();
  const glob = pattern.toLowerCase();

  let textIndex = 0;
  let globIndex = 0;
  let starIndex = -1;
  let starTextIndex = 0;

  while (textIndex < text.length) {
    if (globIndex < glob.length && glob.charCodeAt(globIndex) === text.charCodeAt(textIndex)) {
      textIndex += 1;
      globIndex += 1;
      continue;
    }
    if (globIndex < glob.length && glob[globIndex] === '*') {
      starIndex = globIndex;
      starTextIndex = textIndex;
      globIndex += 1;
      continue;
    }
    if (starIndex >= 0) {
      // Backtrack: let the last star swallow one more character.
      globIndex = starIndex + 1;
      starTextIndex += 1;
      textIndex = starTextIndex;
      continue;
    }
    return false;
  }

  while (globIndex < glob.length && glob[globIndex] === '*') {
    globIndex += 1;
  }
  return globIndex === glob.length;
}

export function matchesPattern(value: string, pattern: string): boolean {
  return globMatch(value, pattern);
}

export function matchesAnyPattern(value: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (globMatch(value, pattern)) {
      return true;
    }
  }
  return false;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestampToIso(value: number | null | undefined): string {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return new Date().toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function isSafUri(uri: string): boolean {
  return uri.startsWith(SAF_URI_PREFIX);
}

/** Legacy `FileInfo.modificationTime` is epoch seconds, normalized to milliseconds. */
function modificationTimeMsOf(modificationTime: number | null | undefined): number | null {
  return typeof modificationTime === 'number' && Number.isFinite(modificationTime)
    ? modificationTime * 1000
    : null;
}

/** Extra sentence for storage denials so a scan failure hints at the fix. */
function permissionHintOf(error: unknown): string {
  return isStoragePermissionError(error)
    ? ' Android denied storage access: grant the storage permission from Settings > Diagnostics > Storage permission, then try again.'
    : '';
}

/**
 * Builds a child URI from a directory URI and one `readDirectoryAsync` result:
 * `content://` SAF listings return full child URIs that are used as-is, while
 * `file://` listings return child names.
 */
function childUriOf(directoryUri: string, entry: string): string {
  if (isSafUri(directoryUri)) {
    return entry;
  }
  const trimmed = directoryUri.endsWith('/') ? directoryUri.slice(0, -1) : directoryUri;
  return `${trimmed}/${entry}`;
}

/**
 * Best-effort display name for a `content://` document URI. Document IDs are
 * percent-encoded inside the URI and commonly look like
 * `primary:DCIM/IMG_1.jpg`, so the readable leaf is after the last `/` of the
 * decoded document id (and after its storage-root prefix when one is present).
 */
function safDisplayName(uri: string): string {
  let fragment = uri;
  const hashIndex = fragment.indexOf('#');
  if (hashIndex >= 0) {
    fragment = fragment.slice(0, hashIndex);
  }
  const queryIndex = fragment.indexOf('?');
  if (queryIndex >= 0) {
    fragment = fragment.slice(0, queryIndex);
  }
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {}
  const documentMarker = decoded.lastIndexOf('/document/');
  const documentId =
    documentMarker >= 0
      ? decoded.slice(documentMarker + '/document/'.length)
      : decoded.slice(decoded.lastIndexOf('/') + 1);
  const leaf = documentId.slice(documentId.lastIndexOf('/') + 1);
  const colonIndex = leaf.indexOf(':');
  return colonIndex >= 0 ? leaf.slice(colonIndex + 1) : leaf;
}

/**
 * Reads one directory level with the legacy async API, which never blocks the
 * JS thread. `content://` SAF tree URIs resolve through StorageAccessFramework
 * and yield full child URIs; `file://` paths yield child names.
 */
async function listDirectoryEntriesAsync(directoryUri: string): Promise<string[]> {
  if (isSafUri(directoryUri)) {
    return StorageAccessFramework.readDirectoryAsync(directoryUri);
  }
  return readDirectoryAsync(directoryUri);
}

export class FolderScannerService {
  /**
   * Scans a persisted folder configuration. An empty include list means "all
   * files"; exclude patterns are applied after include patterns.
   */
  async scanFolderAsync(folder: FolderConfig): Promise<ScannedFile[]> {
    return this.scanFolderAsyncWithPatterns(
      folder.folderPath,
      folder.includePatterns ?? [],
      folder.excludePatterns ?? [],
      folder.includeSubfolders !== false,
    );
  }

  /** Scans with explicit include/exclude patterns. */
  async scanFolderAsyncWithPatterns(
    folderPath: string,
    includePatterns: string[],
    excludePatterns: string[],
    includeSubfolders: boolean,
  ): Promise<ScannedFile[]> {
    if (Platform.OS === 'web') {
      throw new Error(WEB_FOLDER_ERROR);
    }

    return profileAsync(
      'folder.scan',
      async () => {
        const startedAt = nowMs();
        const results: ScannedFile[] = [];
        const state: WalkState = { processed: 0 };
        const totals = createScanTotals();

        logScanInfo(
          `start folder=${folderPath} include=${includePatterns.length} exclude=${
            excludePatterns.length
          } subfolders=${includeSubfolders}`,
        );

        try {
          await this.walkAsync(
            folderPath,
            '',
            includePatterns,
            excludePatterns,
            includeSubfolders,
            results,
            state,
            totals,
          );
        } finally {
          // Logged on failure too: a partial scan still shows where it stalled.
          logScanSummary(folderPath, totals, nowMs() - startedAt, results.length);
        }
        return results;
      },
      { attrs: { includePatterns: includePatterns.length, includeSubfolders } },
    );
  }

  private async walkAsync(
    directoryUri: string,
    relativePath: string,
    includePatterns: string[],
    excludePatterns: string[],
    includeSubfolders: boolean,
    results: ScannedFile[],
    state: WalkState,
    totals: ScanTotals,
  ): Promise<void> {
    const directoryStartedAt = nowMs();
    const directoryLabel = relativePath || '.';
    totals.directories += 1;

    let entries: string[];
    let listMs = 0;
    const listStartedAt = nowMs();
    try {
      entries = await listDirectoryEntriesAsync(directoryUri);
      listMs = nowMs() - listStartedAt;
    } catch (error) {
      listMs = nowMs() - listStartedAt;
      totals.listMs += listMs;
      logScanInfo(
        `step list failed dir=${directoryLabel} ms=${formatMs(listMs)} error=${messageOf(error)}`,
      );
      await logError('folderScanner.walk', error, {
        directoryUri,
        relativePath,
      });
      throw new Error(
        `Folder cannot be read: ${directoryUri} (${messageOf(error)})${permissionHintOf(error)}`,
      );
    }

    totals.listMs += listMs;
    totals.entries += entries.length;
    logScanVerbose(
      `step list dir=${directoryLabel} entries=${entries.length} ms=${formatMs(listMs)}`,
    );

    const yieldStartedAt = nowMs();
    await yieldToEventLoop();
    totals.yieldMs += nowMs() - yieldStartedAt;

    // `content://` listings need no stat (see the class comment): every entry
    // is treated as a file, which is what the platform reports anyway. A
    // `file://` listing must be stat'ed to distinguish files from directories
    // and to read the modification time, so those stats fan out through a
    // bounded pool and stay non-blocking on huge directories.
    const statStartedAt = nowMs();
    const stats: ChildStat[] = isSafUri(directoryUri)
      ? entries.map((entry) => ({
          entry,
          childUri: childUriOf(directoryUri, entry),
          info: { isDirectory: false },
          error: null,
        }))
      : await mapWithConcurrencyAsync(
          entries,
          STAT_CONCURRENCY,
          async (entry): Promise<ChildStat> => {
            const childUri = childUriOf(directoryUri, entry);
            try {
              const info = await getInfoAsync(childUri);
              return { entry, childUri, info: info.exists ? info : null, error: null };
            } catch (error) {
              return { entry, childUri, info: null, error };
            }
          },
        );
    const statMs = nowMs() - statStartedAt;
    totals.statMs += statMs;
    logScanVerbose(`step stat dir=${directoryLabel} entries=${entries.length} ms=${formatMs(statMs)}`);

    let matchMs = 0;
    let buildMs = 0;
    let files = 0;
    let subfolderMs = 0;

    for (const stat of stats) {
      state.processed += 1;

      if (stat.info === null) {
        if (stat.error) {
          await logError('folderScanner.stat', stat.error, {
            directoryUri,
            relativePath,
            uri: stat.childUri,
          });
          // A denied stat means the folder cannot be scanned; other failures
          // (for example an entry that vanished between enumeration and stat)
          // are skipped so one deletion cannot abort a 10k-file scan.
          if (isStoragePermissionError(stat.error)) {
            throw new Error(
              `Folder cannot be read: ${directoryUri} (${messageOf(stat.error)})${permissionHintOf(
                stat.error,
              )}`,
            );
          }
        }
        if (shouldYield(state.processed)) {
          const yieldStartedAtInner = nowMs();
          await yieldToEventLoop();
          totals.yieldMs += nowMs() - yieldStartedAtInner;
        }
        continue;
      }

      const name = isSafUri(directoryUri) ? safDisplayName(stat.childUri) : stat.entry;
      const relative = relativePath ? `${relativePath}/${name}` : name;

      if (stat.info.isDirectory) {
        if (includeSubfolders) {
          const subfolderStartedAt = nowMs();
          await this.walkAsync(
            stat.childUri,
            relative,
            includePatterns,
            excludePatterns,
            includeSubfolders,
            results,
            state,
            totals,
          );
          subfolderMs += nowMs() - subfolderStartedAt;
        }
      } else {
        const matchStartedAt = nowMs();
        const included =
          includePatterns.length === 0 ||
          matchesAnyPattern(name, includePatterns) ||
          matchesAnyPattern(relative, includePatterns);
        const excluded =
          excludePatterns.length > 0 &&
          (matchesAnyPattern(name, excludePatterns) ||
            matchesAnyPattern(relative, excludePatterns));
        const accepted = included && !excluded;
        matchMs += nowMs() - matchStartedAt;

        if (accepted) {
          const buildStartedAt = nowMs();
          const modifiedAtMs = modificationTimeMsOf(stat.info.modificationTime);
          const modifiedAt = timestampToIso(modifiedAtMs);
          results.push({
            uri: stat.childUri,
            name,
            createdAt: modifiedAt,
            modifiedAt,
            modifiedAtMs,
          });
          buildMs += nowMs() - buildStartedAt;
          files += 1;
        }
      }

      if (shouldYield(state.processed)) {
        const yieldStartedAtInner = nowMs();
        await yieldToEventLoop();
        totals.yieldMs += nowMs() - yieldStartedAtInner;
      }
    }

    totals.matchMs += matchMs;
    totals.buildMs += buildMs;
    totals.subfolderMs += subfolderMs;
    totals.files += files;

    const directoryTotalMs = nowMs() - directoryStartedAt;
    recordSlowDirectory(totals, {
      path: directoryLabel,
      totalMs: directoryTotalMs,
      listMs,
      statMs,
      matchMs,
      entries: entries.length,
      files,
    });

    logScanVerbose(
      `step done dir=${directoryLabel} total=${formatMs(directoryTotalMs)} entries=${
        entries.length
      } files=${files} list=${formatMs(listMs)} stat=${formatMs(statMs)} match=${formatMs(
        matchMs,
      )} subfolders=${formatMs(subfolderMs)}`,
    );

    if (directoryTotalMs >= SLOW_DIRECTORY_LOG_MS) {
      logScanInfo(
        `slow dir=${directoryLabel} total=${formatMs(directoryTotalMs)} entries=${
          entries.length
        } files=${files} list=${formatMs(listMs)} stat=${formatMs(statMs)} match=${formatMs(
          matchMs,
        )} subfolders=${formatMs(subfolderMs)}`,
      );
    }
  }

  /** Returns false for missing paths, files, and folders that cannot be read. */
  async isFolderAccessibleAsync(folderPath: string): Promise<boolean> {
    if (Platform.OS === 'web') {
      return false;
    }

    try {
      // Enumerating is the same access the scan uses, so a missing grant for a
      // `content://` tree or a denied `file://` path fails here instead.
      await listDirectoryEntriesAsync(folderPath);
      return true;
    } catch (error) {
      await logError('folderScanner.isFolderAccessible', error, { folderPath });
      return false;
    }
  }
}

/** MIME detection from the file extension (parity with the MAUI scanner). */
export function mimeTypeForFile(fileName: string): string {
  return getMimeTypeFromFileName(fileName);
}

export const folderScannerService = new FolderScannerService();
