/**
 * Platform-aware local file access.
 *
 * `expo-file-system` has no web implementation: in a browser its module is an
 * empty shim, so calling `getInfoAsync` / `readAsStringAsync` (or constructing
 * a `File`) throws or returns nothing. Every local read therefore branches on
 * `Platform.OS === 'web'`:
 *
 *  - iOS/Android: `expo-file-system` (new API + legacy fallbacks).
 *  - Web: standard browser APIs (`fetch` + `Blob` + `FileReader`), because the
 *    document picker hands the app `blob:`/`data:` URLs, not file paths.
 *
 * Every native failure is written to the persistent error log with a stack
 * trace (see `utils/errorLogger`), because these errors only reproduce on a
 * device.
 */
import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import { base64ToBytes } from './base64';
import { logError } from './errorLogger';
import { isStoragePermissionError } from './storagePermissions';

export interface LocalFileInfo {
  exists: boolean;
  isDirectory: boolean;
  size?: number;
  modificationTime?: number;
}

/** Scheme of a URI, used as log context (`content`, `file`, `blob`, …). */
function uriScheme(uri: string): string {
  const separator = uri.indexOf(':');
  return separator > 0 ? uri.slice(0, separator) : 'unknown';
}

export function isWebPlatform(): boolean {
  return Platform.OS === 'web';
}

/** Web-only: resolves a `blob:`/`data:` URL to a Blob. */
async function webBlobAsync(uri: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(uri);
  } catch {
    // Revoked/moved object URLs fail the request instead of returning a status.
    throw new Error('Cannot read the selected file. Re-pick it and try again.');
  }
  if (!response.ok) {
    throw new Error(`Cannot read the selected file (HTTP ${response.status}).`);
  }
  return response.blob();
}

/** Web-only: reads a Blob with FileReader (no expo-file-system on web). */
function webBlobBytesAsync(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read the selected file.'));
    reader.onload = () => {
      const { result } = reader;
      if (result instanceof ArrayBuffer) {
        resolve(new Uint8Array(result));
      } else {
        reject(new Error('Failed to read the selected file.'));
      }
    };
    reader.readAsArrayBuffer(blob);
  });
}

/** Extra sentence for permission denials so the UI can tell the user what to fix. */
function permissionHint(error: unknown): string {
  return isStoragePermissionError(error)
    ? ' Android denied storage access: grant the storage permission from Settings > Diagnostics > Storage permission, then try again.'
    : '';
}

/** Reads the whole file into memory. Throws when the file cannot be read. */
export async function readFileBytesAsync(uri: string): Promise<Uint8Array> {
  if (Platform.OS === 'web') {
    return webBlobBytesAsync(await webBlobAsync(uri));
  }

  // Handle content:// URIs (Android SAF) - the new API doesn't support them.
  // Use the legacy API to copy to the cache directory first.
  if (uri.startsWith('content://')) {
    const tempUri = Paths.cache + `temp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    try {
      const legacyModule = await import('expo-file-system/legacy');
      await legacyModule.copyAsync({ from: uri, to: tempUri });
      // Now read from the copied file using the new API.
      const file = new File(tempUri);
      if (!file.exists) {
        throw new Error(`Copied file not found: ${tempUri}`);
      }
      return await file.bytes();
    } catch (error) {
      await logError('fileAccess.readFileBytes.contentUri', error, {
        uri,
        scheme: uriScheme(uri),
        tempUri,
      });
      throw new Error(`Unable to read content:// URI: ${uri}. Error: ${error}${permissionHint(error)}`);
    }
  }

  // For file:// URIs, try the new API first.
  try {
    const file = new File(uri);
    if (!file.exists) {
      throw new Error(`Local file not found: ${uri}`);
    }
    return await file.bytes();
  } catch (newApiError) {
    // Fallback to the legacy API for compatibility (for file:// URIs).
    await logError('fileAccess.readFileBytes.fallbackToLegacy', newApiError, {
      uri,
      scheme: uriScheme(uri),
    });
    try {
      const legacyModule = await import('expo-file-system/legacy');
      const base64 = await legacyModule.readAsStringAsync(uri, { encoding: 'base64' });
      return base64ToBytes(base64);
    } catch (legacyError) {
      await logError('fileAccess.readFileBytes.legacyFallback', legacyError, {
        uri,
        scheme: uriScheme(uri),
        newApiError: newApiError instanceof Error ? newApiError.message : String(newApiError),
      });
      throw new Error(
        `Unable to read file: ${uri} (new API failed: ${
          newApiError instanceof Error ? newApiError.message : String(newApiError)
        }, legacy API failed: ${legacyError instanceof Error ? legacyError.message : String(legacyError)})${permissionHint(
          legacyError,
        )}`,
      );
    }
  }
}

export async function localFileExistsAsync(uri: string): Promise<boolean> {
  if (Platform.OS === 'web') {
    try {
      const response = await fetch(uri);
      return response.ok;
    } catch {
      return false;
    }
  }

  try {
    const file = new File(uri);
    return file.exists;
  } catch (newApiError) {
    // Fallback to legacy API for compatibility.
    try {
      const legacyModule = await import('expo-file-system/legacy');
      const info = await legacyModule.getInfoAsync(uri);
      return info.exists && !info.isDirectory;
    } catch (legacyError) {
      await logError('fileAccess.localFileExists', legacyError, {
        uri,
        scheme: uriScheme(uri),
        newApiError: newApiError instanceof Error ? newApiError.message : String(newApiError),
      });
      return false;
    }
  }
}

/** Size of the file in bytes, or `fallback` when it cannot be determined. */
export async function localFileSizeAsync(uri: string, fallback = 0): Promise<number> {
  if (Platform.OS === 'web') {
    try {
      return (await webBlobAsync(uri)).size;
    } catch {
      return fallback;
    }
  }

  try {
    const file = new File(uri);
    return file.info().size ?? 0;
  } catch (newApiError) {
    // Fallback to legacy API for compatibility.
    try {
      const legacyModule = await import('expo-file-system/legacy');
      const info = await legacyModule.getInfoAsync(uri);
      if (info.exists && 'size' in info) {
        return info.size;
      }
    } catch (legacyError) {
      await logError('fileAccess.localFileSize', legacyError, {
        uri,
        scheme: uriScheme(uri),
        newApiError: newApiError instanceof Error ? newApiError.message : String(newApiError),
      });
    }
  }
  return fallback;
}

/**
 * Stats a local path. Browsers expose no filesystem metadata or directory
 * listings, so web always reports "unknown" and callers handle it.
 */
export async function statLocalPathAsync(uri: string): Promise<LocalFileInfo | null> {
  if (Platform.OS === 'web') {
    return null;
  }

  try {
    const file = new File(uri);
    if (file.exists) {
      const info = file.info();
      return {
        exists: true,
        isDirectory: false,
        size: info.size,
        modificationTime: info.modificationTime,
      };
    }

    const directory = new Directory(uri);
    if (directory.exists) {
      const info = directory.info();
      return {
        exists: true,
        isDirectory: true,
        size: info.size,
        modificationTime: info.modificationTime,
      };
    }
    return null;
  } catch (newApiError) {
    // Fallback to legacy API for compatibility.
    try {
      const legacyModule = await import('expo-file-system/legacy');
      const info = await legacyModule.getInfoAsync(uri);
      if (!info.exists) {
        return null;
      }
      return {
        exists: true,
        isDirectory: info.isDirectory ?? false,
        size: 'size' in info ? info.size : undefined,
        modificationTime: 'modificationTime' in info ? info.modificationTime : undefined,
      };
    } catch (legacyError) {
      await logError('fileAccess.statLocalPath', legacyError, {
        uri,
        scheme: uriScheme(uri),
        newApiError: newApiError instanceof Error ? newApiError.message : String(newApiError),
      });
      return null;
    }
  }
}
