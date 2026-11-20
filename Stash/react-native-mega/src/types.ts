export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
  },
) => Promise<{
  ok?: boolean;
  status: number;
  statusText?: string;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** Returns `length` cryptographically secure random bytes. */
export type RandomSource = (length: number) => Uint8Array;

export interface Logger {
  debug?(message: string, ...args: unknown[]): void;
  warn?(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
}

/** An app-provided readable file (or any byte range provider). */
export interface ByteSource {
  readonly size: number;
  /**
   * Reads up to `length` bytes at `offset`. May return fewer bytes; callers
   * loop until the requested range is complete.
   */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Called when a transfer finishes or aborts (optional). */
  close?(): Promise<void> | void;
}

/** An app-provided destination. Chunks arrive in file order. */
export interface ByteSink {
  write(chunk: Uint8Array): Promise<void> | void;
  close?(): Promise<void> | void;
  abort?(error?: unknown): Promise<void> | void;
}

export interface TransferProgress {
  bytesTransferred: number;
  bytesTotal: number;
}

export interface TransferOptions {
  signal?: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
  /** Parallel ranged GETs; defaults to 2, capped by the file's chunk count. */
  connections?: number;
  /** Retries per chunk; defaults to 4. */
  retries?: number;
  /** Verify the meta-MAC when downloading the whole file. Defaults to true. */
  verify?: boolean;
}
