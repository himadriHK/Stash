/**
 * MegaHttpService - MEGA (mega.io) client built on the local
 * `react-native-mega` SDK.
 *
 * The app is the only writer of the temporary upload: it logs into the
 * configured MEGA account, uploads `/temp/uploads/{deviceId}/{fileName}` under
 * the physical root-level name the host expects (MegaPathMapper port), and can
 * check/download those objects again. The host picks the file up from the same
 * account, so both sides must agree on the name mapping.
 *
 * Transfers are chunked through app-supplied adapters, so a file is never fully
 * buffered in memory on native.
 */
import type { MegaNode, MegaStorage } from 'react-native-mega';
import { logError } from '../utils/errorLogger';
import { toMegaPhysicalName } from '../utils/megaPathMapper';
import { connectMegaStorage } from './megaClient';
import { createDownloadSink, openUploadSource } from './megaFileAdapters';

export interface MegaUploadSource {
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MegaHttpService {
  private session: Promise<MegaStorage> | null = null;

  /** Resolves the shared MEGA session, logging in on first use. */
  private async ensureStorage(): Promise<MegaStorage> {
    if (!this.session) {
      this.session = this.connect();
    }
    try {
      return await this.session;
    } catch (error) {
      // Allow a later call to retry the login (bad network, wrong password…).
      this.session = null;
      throw error;
    }
  }

  /**
   * Starts the MEGA session ahead of the first upload, so authentication
   * overlaps with app startup instead of delaying a transfer. Failures are
   * logged and ignored: the next real call retries the session.
   */
  async warmUpAsync(): Promise<void> {
    try {
      await this.ensureStorage();
    } catch (error) {
      await logError('mega.session.warmup', error);
    }
  }

  private async connect(): Promise<MegaStorage> {
    try {
      return await connectMegaStorage();
    } catch (error) {
      throw new Error(`MEGA login failed: ${messageOf(error)}`);
    }
  }

  /**
   * Uploads a local file to the given logical remote path and returns that
   * path, which is what the host stores and later resolves.
   */
  async uploadFileAsync(source: MegaUploadSource, remotePath: string): Promise<string> {
    const storage = await this.ensureStorage();
    const physicalName = toMegaPhysicalName(remotePath);
    const root = storage.root;
    if (!root) {
      throw new Error('MEGA Drive tree is not loaded.');
    }

    const bytes = await openUploadSource(source.uri, source.size ?? 0);
    try {
      if (bytes.size <= 0) {
        throw new Error(`Refusing to upload an empty file: ${source.name || remotePath}`);
      }

      // A retried upload must replace the previous attempt; duplicate names
      // would leave the host reading a stale file.
      await this.replaceExistingAsync(storage, physicalName);

      try {
        await root.upload(physicalName, bytes);
      } catch (error) {
        await logError('mega.upload.upload', error, {
          remotePath,
          physicalName,
          size: bytes.size,
        });
        throw new Error(`MEGA upload failed: ${messageOf(error)}`);
      }

      return remotePath;
    } finally {
      try {
        await bytes.close?.();
      } catch {
        // The transfer already finished or failed; nothing useful to recover.
      }
    }
  }

  /** True when the physical name for the logical path exists in the account. */
  async existsAsync(fileName: string): Promise<boolean> {
    const storage = await this.ensureStorage();
    const physicalName = toMegaPhysicalName(fileName);
    return this.findFile(storage, physicalName) !== null;
  }

  /** Downloads the logical path to a local destination URI. */
  async downloadAsync(remotePath: string, destinationUri: string): Promise<string> {
    const storage = await this.ensureStorage();
    const physicalName = toMegaPhysicalName(remotePath);
    const file = this.findFile(storage, physicalName);
    if (!file) {
      throw new Error(`MEGA file not found: ${physicalName}`);
    }

    const sink = createDownloadSink(destinationUri);
    try {
      await file.downloadTo(sink);
      return sink.uri;
    } catch (error) {
      await logError('mega.download.fetch', error, { remotePath, physicalName, destinationUri });
      throw new Error(`MEGA download failed: ${messageOf(error)}`);
    }
  }

  /** Removes the previous temp file with the same physical name, if any. */
  private async replaceExistingAsync(storage: MegaStorage, physicalName: string): Promise<void> {
    const previous = this.findFile(storage, physicalName);
    if (!previous) {
      return;
    }
    try {
      await previous.delete(true);
    } catch (error) {
      console.warn('Could not replace the previous MEGA temp file', physicalName, error);
    }
  }

  private findFile(storage: MegaStorage, physicalName: string): MegaNode | null {
    try {
      return storage.find(physicalName);
    } catch (error) {
      throw new Error(`MEGA lookup failed: ${messageOf(error)}`);
    }
  }
}

export const megaHttpService = new MegaHttpService();
