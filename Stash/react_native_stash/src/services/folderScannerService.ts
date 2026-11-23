/**
 * FolderScannerService - discovers media files in configured folders and
 * computes SHA-256 content hashes. Mirrors Stash.Maui/Services/FolderScannerService.cs.
 *
 * Scanning uses the legacy async `expo-file-system/legacy` API
 * (`readDirectoryAsync` + `getInfoAsync`): the synchronous `Directory.list()`
 * from the new expo-file-system API blocked the JS thread for the whole
 * enumeration (see `folder.scan` in stash-profile.log), while the legacy async
 * enumeration runs on the native side. The tradeoff is that
 * `readDirectoryAsync` returns names/URIs only, so size and timestamps need a
 * per-entry `getInfoAsync` stat; for very large directories those stats are
 * batched through a bounded pool so enumeration stays non-blocking without an
 * N-serial round-trip tail.
 *
 * Android SAF: `Directory.pickDirectoryAsync()` returns a `content://` tree
 * URI and `StorageAccessFramework.readDirectoryAsync` then returns full child
 * SAF URIs. Plain `file://` paths (manual entry / iOS) get child *names* from
 * `readDirectoryAsync`, so child URIs are built as `dirUri + '/' + name`.
 * Legacy `FileInfo` has no `creationTime`, so `createdAt` is derived from
 * `modificationTime`. Web keeps the browser-only hash path and rejects folder
 * scans.
 */
import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { copyAsync, getInfoAsync, readDirectoryAsync, StorageAccessFramework } from 'expo-file-system/legacy';
import { sha256 } from 'js-sha256';
import type { FolderConfig } from '../models/folderConfig';
import { getMimeTypeFromFileName } from '../models/mediaPatterns';
import { logError } from '../utils/errorLogger';
import { readFileBytesAsync } from '../utils/fileAccess';
import { isStoragePermissionError } from '../utils/storagePermissions';
import { mapWithConcurrencyAsync, shouldYield, yieldToEventLoop } from '../utils/cooperative';
import { profileAsync } from '../utils/profiler';

export interface ScannedFile {
  /** Full file URI (file://… or content://…). */
  uri: string;
  name: string;
  size: number;
  createdAt: string;
  modifiedAt: string;
  /** Raw epoch milliseconds from the platform, used for hash-cache keys. */
  modifiedAtMs?: number | null;
}

const WEB_FOLDER_ERROR =
  'Folder scanning is not available in the browser. Use Upload → Pick Files instead.';

/** Parallel `getInfoAsync` stat calls per directory. */
const STAT_CONCURRENCY = 8;

const SAF_URI_PREFIX = 'content://';

const patternCache = new Map<string, RegExp>();

/** One `expo-file-system/legacy` stat result, narrowed to the existing case. */
interface LegacyFileInfo {
  exists: true;
  uri: string;
  size: number;
  isDirectory: boolean;
  modificationTime: number;
  md5?: string;
}

/** Per-entry stat outcome; `error` distinguishes vanished entries from denials. */
interface ChildStat {
  entry: string;
  childUri: string;
  info: LegacyFileInfo | null;
  error: unknown;
}

interface WalkState {
  processed: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** Converts a glob pattern (*.jpg, img_*, …) to a case-insensitive regex. */
export function globToRegExp(pattern: string): RegExp {
  const parts = pattern.split('*').map(escapeRegExp);
  return new RegExp(`^${parts.join('.*')}$`, 'i');
}

function cachedGlobToRegExp(pattern: string): RegExp {
  const cached = patternCache.get(pattern);
  if (cached) {
    return cached;
  }
  const compiled = globToRegExp(pattern);
  patternCache.set(pattern, compiled);
  return compiled;
}

export function matchesPattern(value: string, pattern: string): boolean {
  return cachedGlobToRegExp(pattern).test(value);
}

export function matchesAnyPattern(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(value, pattern));
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
function modificationTimeMsOf(modificationTime: number): number | null {
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

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let index = 0; index < bytes.length; index += 1) {
    hex += bytes[index].toString(16).padStart(2, '0');
  }
  return hex;
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
        const results: ScannedFile[] = [];
        const state: WalkState = { processed: 0 };

        await this.walkAsync(
          folderPath,
          '',
          includePatterns,
          excludePatterns,
          includeSubfolders,
          results,
          state,
        );
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
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await listDirectoryEntriesAsync(directoryUri);
    } catch (error) {
      await logError('folderScanner.walk', error, {
        directoryUri,
        relativePath,
      });
      throw new Error(
        `Folder cannot be read: ${directoryUri} (${messageOf(error)})${permissionHintOf(error)}`,
      );
    }

    await yieldToEventLoop();

    // `readDirectoryAsync` returns names/URIs only, so every child needs one
    // `getInfoAsync` stat. The stats fan out through a bounded pool so CI
    // directories with thousands of entries stay non-blocking.
    const stats = await mapWithConcurrencyAsync(
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
          await yieldToEventLoop();
        }
        continue;
      }

      const name = isSafUri(directoryUri) ? safDisplayName(stat.childUri) : stat.entry;
      const relative = relativePath ? `${relativePath}/${name}` : name;

      if (stat.info.isDirectory) {
        if (includeSubfolders) {
          await this.walkAsync(
            stat.childUri,
            relative,
            includePatterns,
            excludePatterns,
            includeSubfolders,
            results,
            state,
          );
        }
      } else {
        const included =
          includePatterns.length === 0 ||
          matchesAnyPattern(name, includePatterns) ||
          matchesAnyPattern(relative, includePatterns);
        const excluded =
          excludePatterns.length > 0 &&
          (matchesAnyPattern(name, excludePatterns) ||
            matchesAnyPattern(relative, excludePatterns));

        if (included && !excluded) {
          const modifiedAtMs = modificationTimeMsOf(stat.info.modificationTime);
          const modifiedAt = timestampToIso(modifiedAtMs);
          results.push({
            uri: stat.childUri,
            name,
            size: stat.info.size,
            createdAt: modifiedAt,
            modifiedAt,
            modifiedAtMs,
          });
        }
      }

      if (shouldYield(state.processed)) {
        await yieldToEventLoop();
      }
    }
  }

  /**
   * Computes a lowercase hexadecimal SHA-256 hash of the file contents.
   *
   * Native hashing runs in the Expo module (`File.digest`) on the platform IO
   * dispatcher. Web uses `crypto.subtle` when available and falls back to
   * `js-sha256` over the browser-read bytes.
   */
  async computeFileHashAsync(uri: string, knownSize?: number): Promise<string> {
    void knownSize;

    return profileAsync(
      'folder.hash',
      async () => {
        if (Platform.OS === 'web') {
          return this.computeWebHashAsync(uri);
        }

        const file = new File(uri);
        if (!file.exists && !uri.startsWith('content://')) {
          throw new Error(`File cannot be read: ${uri}`);
        }

        try {
          const hash = await file.digest('SHA-256');
          return hash.toLowerCase();
        } catch (error) {
          if (uri.startsWith('content://')) {
            return this.digestContentUriViaCacheAsync(uri, error);
          }
          await logError('folderScanner.hash.digest', error, { uri });
          throw error;
        }
      },
      { sentry: false },
    );
  }

  private async computeWebHashAsync(uri: string): Promise<string> {
    const bytes = await readFileBytesAsync(uri);
    const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;

    if (subtle) {
      try {
        const digest = await subtle.digest('SHA-256', bytes as unknown as BufferSource);
        return bytesToHex(new Uint8Array(digest));
      } catch (error) {
        await logError('folderScanner.hash.webSubtle', error, { uri });
      }
    }

    const hash = sha256.create();
    hash.update(bytes);
    return hash.hex();
  }

  private async digestContentUriViaCacheAsync(
    uri: string,
    originalError: unknown,
  ): Promise<string> {
    await logError('folderScanner.hash.contentUriDigest', originalError, { uri });
    const tempUri = `${Paths.cache.uri}hash_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 9)}`;

    try {
      await copyAsync({ from: uri, to: tempUri });
      const cached = new File(tempUri);
      if (!cached.exists) {
        throw new Error(`Copied file not found: ${tempUri}`);
      }
      const hash = await cached.digest('SHA-256');
      return hash.toLowerCase();
    } catch (fallbackError) {
      await logError('folderScanner.hash.contentUriFallback', fallbackError, { uri, tempUri });
      throw new Error(
        `Unable to hash content:// URI: ${uri}. Native digest failed (${messageOf(
          originalError,
        )}) and the cache-copy fallback failed (${messageOf(fallbackError)}).`,
      );
    } finally {
      try {
        const temporary = new File(tempUri);
        if (temporary.exists) {
          temporary.delete();
        }
      } catch {}
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
