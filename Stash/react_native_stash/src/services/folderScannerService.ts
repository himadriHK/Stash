/**
 * FolderScannerService - discovers media files in configured folders and
 * computes SHA-256 content hashes. Mirrors Stash.Maui/Services/FolderScannerService.cs.
 *
 * Native scanning uses the Expo SDK 58 `Directory`/`File` API: the system folder
 * picker returns a SAF/document-picker reference, `Directory.list()` enumerates
 * it, and `File.digest('SHA-256')` hashes on the native IO dispatcher. Web keeps
 * the browser-only hash path and rejects folder scans.
 */
import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import { copyAsync } from 'expo-file-system/legacy';
import { sha256 } from 'js-sha256';
import type { FolderConfig } from '../models/folderConfig';
import { getMimeTypeFromFileName } from '../models/mediaPatterns';
import { logError } from '../utils/errorLogger';
import { readFileBytesAsync } from '../utils/fileAccess';
import { shouldYield, yieldToEventLoop } from '../utils/cooperative';

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

const patternCache = new Map<string, RegExp>();

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

function isDirectoryEntry(entry: Directory | File): entry is Directory {
  return (
    entry instanceof Directory ||
    typeof (entry as unknown as Directory).list === 'function'
  );
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let index = 0; index < bytes.length; index += 1) {
    hex += bytes[index].toString(16).padStart(2, '0');
  }
  return hex;
}

interface WalkState {
  processed: number;
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

    const results: ScannedFile[] = [];
    const state: WalkState = { processed: 0 };

    let root: Directory;
    try {
      root = new Directory(folderPath);
    } catch (error) {
      await logError('folderScanner.walk', error, {
        directoryUri: folderPath,
        relativePath: '',
      });
      throw new Error(`Folder cannot be read: ${folderPath} (${messageOf(error)})`);
    }

    await this.walkAsync(root, '', includePatterns, excludePatterns, includeSubfolders, results, state);
    return results;
  }

  private async walkAsync(
    directory: Directory,
    relativePath: string,
    includePatterns: string[],
    excludePatterns: string[],
    includeSubfolders: boolean,
    results: ScannedFile[],
    state: WalkState,
  ): Promise<void> {
    let entries: (Directory | File)[];
    try {
      entries = directory.list();
    } catch (error) {
      await logError('folderScanner.walk', error, {
        directoryUri: directory.uri,
        relativePath,
      });
      throw new Error(`Folder cannot be read: ${directory.uri} (${messageOf(error)})`);
    }

    await yieldToEventLoop();

    for (const entry of entries) {
      state.processed += 1;
      const name = entry.name;
      const relative = relativePath ? `${relativePath}/${name}` : name;

      if (isDirectoryEntry(entry)) {
        if (includeSubfolders) {
          await this.walkAsync(
            entry,
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
          results.push({
            uri: entry.uri,
            name,
            size: entry.size,
            createdAt: timestampToIso(entry.creationTime),
            modifiedAt: timestampToIso(entry.lastModified),
            modifiedAtMs: typeof entry.lastModified === 'number' ? entry.lastModified : null,
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
      const directory = new Directory(folderPath);
      if (directory.exists) {
        return true;
      }
      try {
        directory.list();
        return true;
      } catch {
        return false;
      }
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