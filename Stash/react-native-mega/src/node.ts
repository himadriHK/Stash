import type { MegaStorage } from './storage.js';
import type { MegaAttributes } from './crypto/attributes.js';
import type { ByteSink, ByteSource, TransferOptions } from './types.js';

export type MegaNodeType = 0 | 1 | 2 | 3 | 4;

export const NODE_FILE = 0;
export const NODE_FOLDER = 1;
export const NODE_ROOT = 2;
export const NODE_INBOX = 3;
export const NODE_TRASH = 4;

/** A file or folder in a logged-in account. */
export class MegaNode {
  readonly storage: MegaStorage;
  readonly id: string;
  parentId?: string;
  type: number;
  size: number;
  /** Seconds since the Unix epoch, as returned by MEGA. */
  timestamp: number;
  key: Uint8Array | null;
  attributes: MegaAttributes | null;
  name: string;
  children: MegaNode[] = [];
  parent: MegaNode | null = null;
  raw: Record<string, unknown>;

  constructor(
    storage: MegaStorage,
    raw: {
      h: string;
      p?: string;
      t: number;
      s?: number;
      ts?: number;
      k?: string;
      a?: string;
      [key: string]: unknown;
    },
  ) {
    this.storage = storage;
    this.id = raw.h;
    this.parentId = raw.p;
    this.type = raw.t;
    this.size = raw.s ?? 0;
    this.timestamp = raw.ts ?? 0;
    this.key = null;
    this.attributes = null;
    this.name = '';
    this.raw = raw;
  }

  get isFolder(): boolean {
    return this.type !== NODE_FILE;
  }

  get createdAt(): Date {
    return new Date(this.timestamp * 1000);
  }

  get path(): string {
    const names: string[] = [];
    let current: MegaNode | null = this;
    while (current) {
      if (current.name) names.unshift(current.name);
      current = current.parent;
    }
    return `/${names.join('/')}`;
  }

  find(query: string | ((node: MegaNode) => boolean), deep = true): MegaNode | null {
    const matcher =
      typeof query === 'string' ? (node: MegaNode) => node.name === query : query;

    for (const child of this.children) {
      if (matcher(child)) return child;
      if (deep && child.isFolder) {
        const found = child.find(matcher, true);
        if (found) return found;
      }
    }
    return null;
  }

  filter(query: string | ((node: MegaNode) => boolean), deep = true): MegaNode[] {
    const matcher =
      typeof query === 'string' ? (node: MegaNode) => node.name === query : query;
    const results: MegaNode[] = [];
    for (const child of this.children) {
      if (matcher(child)) results.push(child);
      if (deep && child.isFolder) results.push(...child.filter(matcher, true));
    }
    return results;
  }

  navigate(path: string | string[]): MegaNode | null {
    const parts = typeof path === 'string' ? path.split('/').filter(Boolean) : path;
    let current: MegaNode | null = this;
    for (const part of parts) {
      if (!current) return null;
      current = current.children.find((child) => child.name === part) ?? null;
    }
    return current;
  }

  async downloadTo(sink: ByteSink, options?: TransferOptions): Promise<void> {
    if (this.isFolder) throw new Error("Can't download a folder as a file");
    return this.storage.downloadNode(this, sink, options);
  }

  async downloadBuffer(options?: TransferOptions): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    await this.downloadTo(
      {
        write(chunk) {
          chunks.push(chunk);
          total += chunk.length;
        },
      },
      options,
    );
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  async upload(name: string, source: ByteSource, options?: TransferOptions): Promise<MegaNode> {
    if (!this.isFolder) throw new Error('Uploads need a folder target');
    return this.storage.uploadNode(this, name, source, options);
  }

  async mkdir(name: string): Promise<MegaNode> {
    if (!this.isFolder) throw new Error('mkdir needs a folder target');
    return this.storage.createFolder(this, name);
  }

  async rename(name: string): Promise<void> {
    return this.storage.renameNode(this, name);
  }

  async moveTo(folder: MegaNode): Promise<void> {
    return this.storage.moveNode(this, folder);
  }

  async delete(permanent?: boolean): Promise<void> {
    return this.storage.deleteNode(this, permanent);
  }

  async link(): Promise<string> {
    return this.storage.nodeLink(this);
  }
}
