/**
 * Logged-in MEGA account: login, the Drive tree, quota, mutations and transfers.
 */
import { MegaApi } from './api.js';
import { Aes128 } from './crypto/aes.js';
import { decryptAttributes, encryptAttributes, type MegaAttributes } from './crypto/attributes.js';
import {
  fileCipherKey,
  prepareKeyV1,
  prepareKeyV2,
  stringHash,
  type HashcashProgress,
  type Sha256Digest,
} from './crypto/keys.js';
import { decodePrivateKey, rsaDecryptMpi, type MegaRsaPrivateKey } from './crypto/rsa.js';
import { downloadFromUrl } from './download.js';
import { MegaError, messageOf } from './errors.js';
import { MegaNode, NODE_FILE, NODE_INBOX, NODE_ROOT, NODE_TRASH } from './node.js';
import { uploadToFolder, type RawNode } from './upload.js';
import { defaultRandom } from './util/async.js';
import {
  base64ToBytes,
  bytesToBase64,
  bytesToBase64Url,
  equalBytes,
  utf8ToBytes,
} from './util/bytes.js';
import type {
  ByteSink,
  ByteSource,
  FetchLike,
  Logger,
  RandomSource,
  TransferOptions,
} from './types.js';

export interface MegaStorageOptions {
  email?: string;
  password?: string;
  secondFactorCode?: string | number;
  fetch?: FetchLike;
  random?: RandomSource;
  logger?: Logger;
  gateway?: string;
  hashcashDigest?: Sha256Digest;
  hashcashSolver?: (challenge: string) => Promise<string>;
  /** Parallel hashcash searches; only helps with an asynchronous digest. */
  hashcashConcurrency?: number;
  /** Reports hashcash progress (a typical challenge takes seconds). */
  hashcashProgress?: (progress: HashcashProgress) => void;
  /** Fetch the whole tree during login. Defaults to true. */
  autoload?: boolean;
}

export interface MegaSession {
  /** Base64 master key. */
  key: string;
  sid: string;
  name?: string;
  user?: string;
}

export interface MegaQuota {
  type?: string;
  spaceUsed: number;
  spaceTotal: number;
  downloadBandwidthUsed: number;
  downloadBandwidthTotal: number;
  sharedBandwidthUsed?: number;
  sharedBandwidthLimit?: number;
}

interface ShareEntry {
  h: string;
  ha?: string;
  k?: string;
}

interface FetchResponsePayload {
  f?: RawNode[];
  ok?: ShareEntry[];
}

function resolveFetch(fetchOption?: FetchLike): FetchLike {
  if (fetchOption) return fetchOption;
  const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
  if (!globalFetch) {
    throw new MegaError('UNSUPPORTED', 'No fetch implementation found; pass `fetch` to the SDK');
  }
  return globalFetch.bind(globalThis) as FetchLike;
}

export class MegaStorage {
  readonly api: MegaApi;
  readonly random: RandomSource;
  readonly logger?: Logger;

  masterKey!: Uint8Array;
  aes!: Aes128;
  rsaKey: MegaRsaPrivateKey | null = null;
  sid = '';
  name?: string;
  user?: string;

  nodes = new Map<string, MegaNode>();
  shareKeys: Record<string, Uint8Array> = {};
  root: MegaNode | null = null;
  trash: MegaNode | null = null;
  inbox: MegaNode | null = null;

  private constructor(options: MegaStorageOptions) {
    this.logger = options.logger;
    this.random = options.random ?? defaultRandom;
    this.api = new MegaApi({
      fetch: resolveFetch(options.fetch),
      gateway: options.gateway,
      logger: options.logger,
      hashcashDigest: options.hashcashDigest,
      hashcashSolver: options.hashcashSolver,
      hashcashConcurrency: options.hashcashConcurrency,
      hashcashProgress: options.hashcashProgress,
    });
  }

  static async login(options: MegaStorageOptions): Promise<MegaStorage> {
    if (!options.email || !options.password) {
      throw new MegaError('ARGS', 'MEGA login requires an email and password');
    }
    const storage = new MegaStorage(options);
    await storage.performLogin(options);
    return storage;
  }

  static async fromSession(
    session: MegaSession,
    options: Omit<MegaStorageOptions, 'email' | 'password'> = {},
  ): Promise<MegaStorage> {
    const storage = new MegaStorage(options);
    storage.masterKey = base64ToBytes(session.key);
    if (storage.masterKey.length !== 16) {
      throw new MegaError('ARGS', 'Invalid MEGA session key');
    }
    storage.aes = new Aes128(storage.masterKey);
    storage.sid = session.sid;
    storage.name = session.name;
    storage.user = session.user;
    storage.api.sid = session.sid;
    // Resuming is usually done to skip the expensive password login, so callers
    // that only need an authenticated client can skip the tree fetch too.
    if (options.autoload !== false) {
      await storage.reload();
    }
    return storage;
  }

  toJSON(): MegaSession {
    return {
      key: bytesToBase64(this.masterKey),
      sid: this.sid,
      name: this.name,
      user: this.user,
    };
  }

  private async performLogin(options: MegaStorageOptions): Promise<void> {
    const email = options.email!.trim().toLowerCase();
    const password = utf8ToBytes(options.password!);

    let version: { v?: number; s?: string };
    try {
      version = await this.api.request({ a: 'us0', user: email });
    } catch (error) {
      throw new MegaError('NETWORK', `Could not reach MEGA: ${messageOf(error)}`, {
        retryable: true,
        cause: error,
      });
    }

    let loginRequest: Record<string, unknown>;
    let aesKey: Uint8Array;

    if (version.v === 2) {
      if (!version.s) throw new MegaError('INTERNAL', 'MEGA did not return a v2 login salt');
      const derived = prepareKeyV2(password, base64ToBytes(version.s), 100000);
      aesKey = derived.subarray(0, 16);
      loginRequest = {
        a: 'us',
        user: email,
        uh: bytesToBase64Url(derived.subarray(16, 32)),
      };
    } else if (version.v === 1) {
      const prepared = prepareKeyV1(password);
      aesKey = prepared;
      loginRequest = {
        a: 'us',
        user: email,
        uh: bytesToBase64Url(stringHash(prepared, utf8ToBytes(email))),
      };
    } else {
      throw new MegaError('UNSUPPORTED', `Unsupported MEGA account version: ${version.v}`);
    }

    if (options.secondFactorCode !== undefined) {
      loginRequest.mfa = String(options.secondFactorCode);
    }

    const user = await this.api.request<{ k?: string; csid?: string; privk?: string }>(loginRequest);
    if (!user.k || !user.csid || !user.privk) {
      throw new MegaError('INTERNAL', 'MEGA returned an incomplete login response');
    }

    const userAes = new Aes128(aesKey);
    this.masterKey = userAes.ecbDecrypt(base64ToBytes(user.k));
    this.aes = new Aes128(this.masterKey);

    const privateKeyBlob = this.aes.ecbDecrypt(base64ToBytes(user.privk));
    this.rsaKey = decodePrivateKey(privateKeyBlob);

    const sidPlain = rsaDecryptMpi(base64ToBytes(user.csid), this.rsaKey);
    this.sid = bytesToBase64Url(sidPlain.subarray(0, 43));
    this.api.sid = this.sid;

    const info = await this.api.request<{ name?: string; u?: string }>({ a: 'ug' });
    this.name = info.name;
    this.user = info.u;

    if (options.autoload !== false) {
      await this.reload();
    }
  }

  /** Re-reads the entire node tree. */
  async reload(): Promise<void> {
    const payload = await this.api.request<FetchResponsePayload>({ a: 'f', c: 1 });

    this.nodes = new Map();
    this.shareKeys = {};
    this.root = null;
    this.trash = null;
    this.inbox = null;

    for (const share of payload.ok ?? []) {
      if (!share.h || !share.ha || !share.k) continue;
      const expected = this.aes.ecbEncrypt(utf8ToBytes(share.h + share.h));
      if (equalBytes(expected, base64ToBytes(share.ha))) {
        this.shareKeys[share.h] = this.aes.ecbDecrypt(base64ToBytes(share.k));
      } else {
        this.logger?.warn?.('mega: ignoring a share whose authenticity check failed');
      }
    }

    for (const raw of payload.f ?? []) {
      this.importNode(raw);
    }

    for (const node of this.nodes.values()) {
      if (!node.parentId) continue;
      const parent = this.nodes.get(node.parentId);
      if (parent && parent !== node) {
        parent.children.push(node);
        node.parent = parent;
      }
    }
  }

  /** Adds a raw API node to the in-memory tree. */
  importNode(raw: RawNode): MegaNode {
    const node = new MegaNode(this, raw);

    const key = this.resolveNodeKey(raw);
    if (key) {
      node.key = key;
      if (raw.a) {
        node.attributes = decryptAttributes(base64ToBytes(raw.a), key) ?? null;
      }
    }

    node.name =
      node.attributes?.n ??
      (raw.t === NODE_ROOT ? 'Cloud Drive' : raw.t === NODE_TRASH ? 'Rubbish Bin' : raw.t === NODE_INBOX ? 'Inbox' : '');

    this.nodes.set(node.id, node);
    if (node.type === NODE_ROOT) this.root = node;
    if (node.type === NODE_TRASH) this.trash = node;
    if (node.type === NODE_INBOX) this.inbox = node;
    return node;
  }

  private resolveNodeKey(raw: RawNode): Uint8Array | null {
    if (!raw.k) return null;

    const alternatives = raw.k.split('/');
    for (const alternative of alternatives) {
      const separator = alternative.indexOf(':');
      const handle = separator >= 0 ? alternative.slice(0, separator) : '';
      const keyText = separator >= 0 ? alternative.slice(separator + 1) : alternative;
      let keyBytes = base64ToBytes(keyText);
      if (keyBytes.length === 0) continue;

      let aes: Aes128 | null = null;
      if (handle === this.user) {
        aes = this.aes;
      } else if (this.shareKeys[handle]) {
        aes = new Aes128(this.shareKeys[handle]);
      }

      if (aes) {
        if (keyBytes.length !== 16 && keyBytes.length !== 32) continue;
        keyBytes = aes.ecbDecrypt(keyBytes);
      } else if (this.rsaKey && keyBytes.length > 32) {
        try {
          const decrypted = rsaDecryptMpi(keyBytes, this.rsaKey);
          keyBytes = decrypted.subarray(0, raw.t === NODE_FILE ? 32 : 16);
        } catch {
          continue;
        }
      } else {
        continue;
      }

      if (keyBytes.length !== 16 && keyBytes.length !== 32) continue;
      if (!raw.a) return keyBytes;

      const attributes = decryptAttributes(base64ToBytes(raw.a), keyBytes);
      if (attributes) return keyBytes;
    }

    return null;
  }

  find(query: string | ((node: MegaNode) => boolean), deep = true): MegaNode | null {
    if (!this.root) throw new MegaError('UNSUPPORTED', 'The Drive tree is not loaded');
    return this.root.find(query, deep);
  }

  filter(query: string | ((node: MegaNode) => boolean), deep = true): MegaNode[] {
    if (!this.root) throw new MegaError('UNSUPPORTED', 'The Drive tree is not loaded');
    return this.root.filter(query, deep);
  }

  async getQuota(): Promise<MegaQuota> {
    const response = await this.api.request<{
      utype?: string;
      cstrg?: number;
      mstrg?: number;
      caxfer?: number;
      mxfer?: number;
      csxfer?: number;
      srvratio?: number;
    }>({ a: 'uq', strg: 1, xfer: 1, pro: 1 });

    return {
      type: response.utype,
      spaceUsed: response.cstrg ?? 0,
      spaceTotal: response.mstrg ?? 0,
      downloadBandwidthUsed: response.caxfer ?? 0,
      downloadBandwidthTotal: response.mxfer ?? Math.pow(1024, 5) * 10,
      sharedBandwidthUsed: response.csxfer,
      sharedBandwidthLimit: response.srvratio,
    };
  }

  async downloadNode(node: MegaNode, sink: ByteSink, options?: TransferOptions): Promise<void> {
    if (!node.key || node.key.length !== 32) {
      throw new MegaError('ARGS', `No file key available for ${node.name || node.id}`);
    }

    const response = await this.api.request<{ g?: string; s?: number }>(
      { a: 'g', g: 1, n: node.id, ssl: 2 },
      options?.signal,
    );

    if (response.s === 0) {
      options?.onProgress?.({ bytesTransferred: 0, bytesTotal: 0 });
      await sink.close?.();
      return;
    }

    if (!response.g || !/^https?:\/\//.test(response.g)) {
      throw new MegaError('INTERNAL', 'MEGA did not return a download URL (rate limited?)');
    }

    await downloadFromUrl({
      api: this.api,
      url: response.g,
      size: response.s ?? node.size,
      key: node.key,
      sink,
      options,
    });
  }

  async uploadNode(
    folder: MegaNode,
    name: string,
    source: ByteSource,
    options?: TransferOptions,
  ): Promise<MegaNode> {
    if (!name) throw new MegaError('ARGS', 'A file name is required');

    const raw = await uploadToFolder({
      api: this.api,
      folderId: folder.id,
      name,
      source,
      masterKey: this.masterKey,
      random: this.random,
      options,
    });

    const node = this.importNode(raw);
    this.attach(node, folder);
    return node;
  }

  async createFolder(folder: MegaNode, name: string): Promise<MegaNode> {
    if (!name) throw new MegaError('ARGS', 'A folder name is required');

    const key = this.random(16);
    if (key.length !== 16) throw new MegaError('ARGS', 'The random source returned the wrong length');

    const attributes: MegaAttributes = { n: name };
    const encryptedAttributes = encryptAttributes(attributes, key);
    const storedKey = this.aes.ecbEncrypt(key);

    const response = await this.api.request<{ f?: RawNode[] }>({
      a: 'p',
      t: folder.id,
      n: [
        {
          h: 'xxxxxxxx',
          t: 1,
          a: bytesToBase64Url(encryptedAttributes),
          k: bytesToBase64Url(storedKey),
        },
      ],
    });

    const raw = response.f?.[0];
    if (!raw) throw new MegaError('INTERNAL', 'MEGA did not return the created folder');

    const node = this.importNode(raw);
    this.attach(node, folder);
    return node;
  }

  async renameNode(node: MegaNode, name: string): Promise<void> {
    if (!node.key) throw new MegaError('ARGS', 'This node has no key, so it cannot be renamed');

    const attributes: MegaAttributes = { ...(node.attributes ?? {}), n: name };
    const encrypted = encryptAttributes(attributes, node.key);
    await this.api.request({ a: 'a', n: node.id, at: bytesToBase64Url(encrypted) });

    node.attributes = attributes;
    node.name = name;
  }

  async moveNode(node: MegaNode, folder: MegaNode): Promise<void> {
    if (node.parent === folder) return;
    await this.api.request({ a: 'm', n: node.id, t: folder.id });

    if (node.parent) {
      const index = node.parent.children.indexOf(node);
      if (index >= 0) node.parent.children.splice(index, 1);
    }
    node.parent = folder;
    node.parentId = folder.id;
    folder.children.push(node);
  }

  async deleteNode(node: MegaNode, permanent?: boolean): Promise<void> {
    const toTrash = permanent === true ? false : permanent === false ? true : node.parent !== this.trash;
    if (toTrash && this.trash) {
      await this.moveNode(node, this.trash);
      return;
    }

    await this.api.request({ a: 'd', n: node.id });
    if (node.parent) {
      const index = node.parent.children.indexOf(node);
      if (index >= 0) node.parent.children.splice(index, 1);
    }
    this.nodes.delete(node.id);
  }

  async nodeLink(node: MegaNode): Promise<string> {
    if (node.isFolder) {
      throw new MegaError(
        'UNSUPPORTED',
        'Creating folder links needs MEGA share-key exchange, which is not implemented yet',
      );
    }
    if (!node.key) throw new MegaError('ARGS', 'This node has no key to include in a link');

    const linkId = await this.api.request<string>({ a: 'l', n: node.id });
    if (typeof linkId !== 'string') {
      throw new MegaError('INTERNAL', 'MEGA did not return a share id');
    }
    return `https://mega.nz/file/${linkId}#${bytesToBase64Url(node.key)}`;
  }

  private attach(node: MegaNode, folder: MegaNode): void {
    const existingParent = node.parentId ? this.nodes.get(node.parentId) : undefined;
    const parent = existingParent ?? folder;
    if (node.parent) {
      const index = node.parent.children.indexOf(node);
      if (index >= 0) node.parent.children.splice(index, 1);
    }
    node.parent = parent;
    node.parentId = parent.id;
    if (!parent.children.includes(node)) parent.children.push(node);
  }

  async close(): Promise<void> {
    try {
      await this.api.request({ a: 'sml' });
    } catch (error) {
      this.logger?.warn?.(`mega: logout request failed: ${messageOf(error)}`);
    }
    this.api.sid = undefined;
    this.sid = '';
  }
}

/** Reads the AES key from a node key (useful for diagnostics). */
export function nodeAesKey(node: MegaNode): Uint8Array | null {
  return node.key ? fileCipherKey(node.key) : null;
}
