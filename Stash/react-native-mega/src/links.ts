/**
 * Public MEGA links (no account required).
 *
 * File links carry the file key in the URL fragment. Folder links carry the
 * folder key, which decrypts every child key in the folder listing.
 */
import { MegaApi, type MegaApiOptions } from './api.js';
import { Aes128 } from './crypto/aes.js';
import { decryptAttributes, type MegaAttributes } from './crypto/attributes.js';
import { downloadFromUrl } from './download.js';
import { MegaError } from './errors.js';
import { base64ToBytes, bytesToBase64Url, concatBytes } from './util/bytes.js';
import type { ByteSink, TransferOptions } from './types.js';

export interface ParsedMegaLink {
  handle: string;
  key: Uint8Array;
  directory: boolean;
  loadedFile?: string;
}

function decodeKey(value: string): Uint8Array {
  const key = base64ToBytes(value);
  if (key.length !== 16 && key.length !== 32) {
    throw new MegaError('ARGS', 'MEGA link key must be 16 or 32 bytes');
  }
  return key;
}

/** Parses both the modern (/file/, /folder/) and legacy (/#! , /#F!) link formats. */
export function parseFileLink(url: string): ParsedMegaLink {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MegaError('ARGS', 'Invalid MEGA URL');
  }

  if (parsed.hostname !== 'mega.nz' && parsed.hostname !== 'mega.co.nz') {
    throw new MegaError('ARGS', 'Invalid MEGA URL: wrong hostname');
  }
  if (!parsed.hash) throw new MegaError('ARGS', 'Invalid MEGA URL: missing key');

  const hash = parsed.hash.slice(1);

  if (parsed.pathname.includes('/file/') || parsed.pathname.includes('/folder/')) {
    const isFolder = parsed.pathname.includes('/folder/');
    const handle = parsed.pathname.slice(parsed.pathname.lastIndexOf('/') + 1);
    const [keyText, loadedFile] = hash.split('/file/');
    if (!handle || !keyText) throw new MegaError('ARGS', 'Invalid MEGA URL: too few arguments');
    return { handle, key: decodeKey(keyText), directory: isFolder, loadedFile };
  }

  const parts = parsed.hash.split('!');
  const isFolder = parts[0] === '#F';
  if (parts[0] !== '#' && parts[0] !== '#F') {
    throw new MegaError('ARGS', 'Invalid MEGA URL format');
  }
  if (parts.length < 3) throw new MegaError('ARGS', 'Invalid MEGA URL: too few arguments');

  return {
    handle: parts[1],
    key: decodeKey(parts[2]),
    directory: isFolder,
    loadedFile: parts[3],
  };
}

interface PublicFileResponse {
  g?: string;
  s?: number;
  at?: string;
}

export class MegaPublicFile {
  readonly api: MegaApi;
  readonly handle: string;
  readonly key: Uint8Array;

  name = '';
  size = 0;
  timestamp = 0;
  attributes: MegaAttributes | null = null;
  private loaded = false;

  constructor(handle: string, key: Uint8Array, apiOptions: MegaApiOptions) {
    this.handle = handle;
    this.key = key;
    this.api = new MegaApi(apiOptions);
  }

  static fromURL(url: string, apiOptions: MegaApiOptions): MegaPublicFile {
    const parsed = parseFileLink(url);
    if (parsed.directory) {
      throw new MegaError('ARGS', 'This is a folder link; use MegaPublicFolder');
    }
    return new MegaPublicFile(parsed.handle, parsed.key, apiOptions);
  }

  async load(): Promise<this> {
    if (this.loaded) return this;
    if (this.key.length !== 32) {
      throw new MegaError('ARGS', 'A file link needs a 32-byte key');
    }

    const response = await this.api.request<PublicFileResponse>({
      a: 'g',
      g: 1,
      p: this.handle,
      ssl: 2,
    });

    this.size = response.s ?? 0;
    if (response.at) {
      this.attributes = decryptAttributes(base64ToBytes(response.at), this.key);
      this.name = this.attributes?.n ?? '';
    }
    this.loaded = true;
    return this;
  }

  async downloadTo(sink: ByteSink, options?: TransferOptions): Promise<void> {
    if (!this.loaded) await this.load();

    const response = await this.api.request<PublicFileResponse>(
      { a: 'g', g: 1, p: this.handle, ssl: 2 },
      options?.signal,
    );

    if (response.s === 0) {
      options?.onProgress?.({ bytesTransferred: 0, bytesTotal: 0 });
      await sink.close?.();
      return;
    }
    if (!response.g) {
      throw new MegaError('INTERNAL', 'MEGA did not return a download URL');
    }

    await downloadFromUrl({
      api: this.api,
      url: response.g,
      size: response.s ?? this.size,
      key: this.key,
      sink,
      options,
    });
  }

  async downloadBuffer(options?: TransferOptions): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    await this.downloadTo(
      {
        write(chunk) {
          chunks.push(chunk);
        },
      },
      options,
    );
    return concatBytes(...chunks);
  }

  link(): string {
    return `https://mega.nz/file/${this.handle}#${bytesToBase64Url(this.key)}`;
  }
}

interface PublicFolderNode {
  h: string;
  p?: string;
  t: number;
  s?: number;
  ts?: number;
  k?: string;
  a?: string;
}

export interface PublicFolderEntry {
  id: string;
  parentId?: string;
  directory: boolean;
  name: string;
  size: number;
  timestamp: number;
  key: Uint8Array | null;
  children: PublicFolderEntry[];
  parent: PublicFolderEntry | null;
}

export class MegaPublicFolder {
  readonly api: MegaApi;
  readonly handle: string;
  readonly key: Uint8Array;

  readonly entries: PublicFolderEntry[] = [];
  root: PublicFolderEntry | null = null;
  name = '';
  private loaded = false;

  constructor(handle: string, key: Uint8Array, apiOptions: MegaApiOptions) {
    this.handle = handle;
    this.key = key;
    this.api = new MegaApi(apiOptions);
  }

  static fromURL(url: string, apiOptions: MegaApiOptions): MegaPublicFolder {
    const parsed = parseFileLink(url);
    if (!parsed.directory) {
      throw new MegaError('ARGS', 'This is a file link; use MegaPublicFile');
    }
    return new MegaPublicFolder(parsed.handle, parsed.key, apiOptions);
  }

  async load(): Promise<this> {
    if (this.loaded) return this;
    if (this.key.length !== 16) {
      throw new MegaError('ARGS', 'A folder link needs a 16-byte key');
    }

    const response = await this.api.request<{ f?: PublicFolderNode[] }>({
      a: 'f',
      c: 1,
      ca: 1,
      r: 1,
      _querystring: { n: this.handle },
    });

    const nodes = response.f ?? [];
    const byId = new Map<string, PublicFolderEntry>();
    const folderAes = new Aes128(this.key);

    for (const raw of nodes) {
      const entry: PublicFolderEntry = {
        id: raw.h,
        parentId: raw.p,
        directory: raw.t !== 0,
        name: '',
        size: raw.s ?? 0,
        timestamp: raw.ts ?? 0,
        key: null,
        children: [],
        parent: null,
      };

      if (raw.h === this.handle) {
        entry.key = this.key;
        if (raw.a) {
          entry.name = decryptAttributes(base64ToBytes(raw.a), this.key)?.n ?? '';
        }
      } else if (raw.k) {
        for (const alternative of raw.k.split('/')) {
          const separator = alternative.indexOf(':');
          const keyText = separator >= 0 ? alternative.slice(separator + 1) : alternative;
          const encrypted = base64ToBytes(keyText);
          if (encrypted.length !== 16 && encrypted.length !== 32) continue;

          const candidate = folderAes.ecbDecrypt(encrypted);
          if (raw.a) {
            const attributes = decryptAttributes(base64ToBytes(raw.a), candidate);
            if (attributes) {
              entry.name = attributes.n ?? '';
              entry.key = candidate;
              break;
            }
          } else {
            entry.key = candidate;
            break;
          }
        }
      }

      byId.set(raw.h, entry);
      this.entries.push(entry);
    }

    for (const entry of this.entries) {
      if (!entry.parentId) continue;
      const parent = byId.get(entry.parentId);
      if (parent && parent !== entry) {
        parent.children.push(entry);
        entry.parent = parent;
      }
    }

    this.root = byId.get(this.handle) ?? null;
    this.name = this.root?.name ?? 'Shared folder';
    this.loaded = true;
    return this;
  }

  find(name: string): PublicFolderEntry | null {
    const visit = (entry: PublicFolderEntry): PublicFolderEntry | null => {
      for (const child of entry.children) {
        if (child.name === name) return child;
        if (child.directory) {
          const found = visit(child);
          if (found) return found;
        }
      }
      return null;
    };
    return this.root ? visit(this.root) : null;
  }

  async downloadTo(
    entry: PublicFolderEntry,
    sink: ByteSink,
    options?: TransferOptions,
  ): Promise<void> {
    if (entry.directory) throw new MegaError('ARGS', 'Cannot download a folder entry as a file');
    if (!entry.key || entry.key.length !== 32) {
      throw new MegaError('ARGS', `No file key available for ${entry.name}`);
    }

    const response = await this.api.request<{ g?: string; s?: number }>(
      {
        a: 'g',
        g: 1,
        ssl: 2,
        n: entry.id,
        _querystring: { n: this.handle },
      },
      options?.signal,
    );

    if (response.s === 0) {
      await sink.close?.();
      return;
    }
    if (!response.g) throw new MegaError('INTERNAL', 'MEGA did not return a download URL');

    await downloadFromUrl({
      api: this.api,
      url: response.g,
      size: response.s ?? entry.size,
      key: entry.key,
      sink,
      options,
    });
  }
}
