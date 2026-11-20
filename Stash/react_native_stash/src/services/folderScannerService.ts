/**
 * FolderScannerService - discovers media files in configured folders and
 * computes SHA-256 content hashes. Mirrors Stash.Maui/Services/FolderScannerService.cs.
 */
import { Platform } from 'react-native';
import { sha256 } from 'js-sha256';
import * as FileSystem from 'expo-file-system/legacy';
import type { FolderConfig } from '../models/folderConfig';
import { getMimeTypeFromFileName } from '../models/mediaPatterns';
import { logError } from '../utils/errorLogger';
import { readFileBytesAsync, statLocalPathAsync } from '../utils/fileAccess';
import { unixSecondsToIso } from '../utils/format';

export interface ScannedFile {
  /** Full file URI (file://… or content://…). */
  uri: string;
  name: string;
  size: number;
  createdAt: string;
  modifiedAt: string;
}

const HASH_CHUNK_BYTES = 512 * 1024;

function escapeRegExp(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** Converts a glob pattern (*.jpg, img_*, …) to a case-insensitive regex. */
export function globToRegExp(pattern: string): RegExp {
  const parts = pattern.split('*').map(escapeRegExp);
  return new RegExp(`^${parts.join('.*')}$`, 'i');
}

export function matchesPattern(value: string, pattern: string): boolean {
  return globToRegExp(pattern).test(value);
}

export function matchesAnyPattern(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(value, pattern));
}

function joinUri(base: string, child: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}/${child}`;
}

interface EntryInfo {
  exists: boolean;
  isDirectory: boolean;
  size?: number;
  modificationTime?: number;
}

function statAsync(uri: string): Promise<EntryInfo | null> {
  // Native stats with expo-file-system; the browser path is handled inside the
  // helper (no filesystem metadata is exposed to web).
  return statLocalPathAsync(uri);
}

export class FolderScannerService {
  /**
   * Scans a persisted folder configuration. An empty include list means "all
   * files"; exclude patterns are applied after include patterns.
   */
  async scanFolderAsync(folder: FolderConfig): Promise<ScannedFile[]> {
    const results: ScannedFile[] = [];
    await this.walkAsync(
      folder.folderPath,
      '',
      folder.includePatterns ?? [],
      folder.excludePatterns ?? [],
      folder.includeSubfolders !== false,
      results,
    );
    return results;
  }

  /** Scans with explicit include/exclude patterns. */
  async scanFolderAsyncWithPatterns(
    folderPath: string,
    includePatterns: string[],
    excludePatterns: string[],
    includeSubfolders: boolean,
  ): Promise<ScannedFile[]> {
    const results: ScannedFile[] = [];
    await this.walkAsync(folderPath, '', includePatterns, excludePatterns, includeSubfolders, results);
    return results;
  }

  private async walkAsync(
    directoryUri: string,
    relativePath: string,
    includePatterns: string[],
    excludePatterns: string[],
    includeSubfolders: boolean,
    results: ScannedFile[],
  ): Promise<void> {
    if (Platform.OS === 'web') {
      // Browsers cannot enumerate a folder path; pick individual files instead.
      throw new Error(
        'Folder scanning is not available in the browser. Use Upload → Pick Files instead.',
      );
    }

    let entries: string[];
    try {
      entries = await FileSystem.readDirectoryAsync(directoryUri);
    } catch (error) {
      await logError('folderScanner.walk', error, { directoryUri, relativePath });
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Folder cannot be read: ${directoryUri} (${message})`);
    }

    for (const entry of entries) {
      const childUri = joinUri(directoryUri, entry);
      const relative = relativePath ? `${relativePath}/${entry}` : entry;
      const info = await statAsync(childUri);
      if (!info) {
        continue;
      }

      if (info.isDirectory) {
        if (includeSubfolders) {
          await this.walkAsync(childUri, relative, includePatterns, excludePatterns, true, results);
        }
        continue;
      }

      const included =
        includePatterns.length === 0 ||
        matchesAnyPattern(entry, includePatterns) ||
        matchesAnyPattern(relative, includePatterns);
      if (!included) {
        continue;
      }

      const excluded =
        excludePatterns.length > 0 &&
        (matchesAnyPattern(entry, excludePatterns) || matchesAnyPattern(relative, excludePatterns));
      if (excluded) {
        continue;
      }

      const modified = unixSecondsToIso(info.modificationTime);
      results.push({
        uri: childUri,
        name: entry,
        size: info.size ?? 0,
        createdAt: modified,
        modifiedAt: modified,
      });
    }
  }

  /**
   * Computes a lowercase hexadecimal SHA-256 hash of the file contents using
   * chunked reads so large media files never load fully into memory.
   */
  async computeFileHashAsync(uri: string, knownSize?: number): Promise<string> {
    if (Platform.OS === 'web') {
      // Web-picked files are blob:/data: URLs; expo-file-system cannot read them,
      // so the browser APIs in the helper do (fetch + FileReader).
      const bytes = await readFileBytesAsync(uri);
      const hash = sha256.create();
      hash.update(bytes);
      return hash.hex();
    }

    const { File, FileMode } = await import('expo-file-system');
    const file = new File(uri);
    const size = knownSize && knownSize > 0 ? knownSize : await this.sizeOfAsync(uri);
    const hash = sha256.create();

    if (size > 0) {
      let handle: any;
      try {
        handle = file.open(FileMode.ReadOnly);
        let offset = 0;
        const CHUNK_SIZE = HASH_CHUNK_BYTES;
        while (offset < size) {
          const chunkSize = Math.min(CHUNK_SIZE, size - offset);
          const data = await handle.readBytes(chunkSize);
          hash.update(data);
          offset += data.length;
        }
        return hash.hex();
      } catch (error) {
        // Chunked reads fail on some providers; fall back to a whole-file read.
        await logError('folderScanner.hash.chunkedRead', error, {
          uri,
          size,
          offset: handle ? undefined : 0,
        });
        // Fall through to whole-file read if chunked reading fails
      } finally {
        if (handle) {
          handle.close();
        }
      }
    }

    try {
      const whole = await readFileBytesAsync(uri);
      hash.update(whole);
      return hash.hex();
    } catch (error) {
      await logError('folderScanner.hash.readFile', error, { uri, size });
      throw error;
    }
  }

  private async sizeOfAsync(uri: string): Promise<number> {
    const info = await statAsync(uri);
    return info?.size ?? 0;
  }

  /** Returns false for missing paths, files, and folders that cannot be read. */
  async isFolderAccessibleAsync(folderPath: string): Promise<boolean> {
    const info = await statAsync(folderPath);
    return info !== null && info.isDirectory;
  }
}

/** MIME detection from the file extension (parity with the MAUI scanner). */
export function mimeTypeForFile(fileName: string): string {
  return getMimeTypeFromFileName(fileName);
}

export const folderScannerService = new FolderScannerService();
