/**
 * Cooperative scheduling helpers for long scan, ingestion and upload loops.
 *
 * The scanner enumerates directories and hashes files, and the upload pass walks
 * every discovered row. Those loops touch the JS thread thousands of times, so
 * they must hand control back to React Native often enough that gestures,
 * animations and renders still run. Two rules keep the app responsive on a large
 * library (10k+ files):
 *
 * 1. Work is processed in chunks, and control is yielded between chunks - not
 *    only every N items, so a single chunk never grows into a long task.
 * 2. Anything that fans out (parallel transfers, parallel lookups) runs through a
 *    bounded worker pool instead of `Promise.all` over an unbounded array.
 */

/** Resolves on the next macrotask so pending UI work can run first. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** True every `interval` processed items (default 50). */
export function shouldYield(processed: number, interval = 50): boolean {
  if (!Number.isFinite(interval) || interval <= 0) {
    return processed > 0;
  }
  return processed > 0 && processed % interval === 0;
}

/** Splits `items` into consecutive chunks of at most `size` elements. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (items.length === 0) {
    return [];
  }
  const safeSize =
    Number.isFinite(size) && size > 0 ? Math.max(1, Math.floor(size)) : items.length;
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += safeSize) {
    chunks.push(items.slice(index, index + safeSize));
  }
  return chunks;
}

export interface ChunkedOptions {
  /** Items per chunk. Defaults to 200. */
  chunkSize?: number;
  /** Called after each chunk with the running processed/total counts. */
  onProgress?: (processed: number, total: number) => void;
}

/**
 * Runs `worker` once per chunk, yielding to the event loop between chunks so the
 * UI thread can paint and handle input. Errors propagate immediately.
 */
export async function forEachChunkedAsync<T>(
  items: readonly T[],
  worker: (chunk: readonly T[], chunkIndex: number) => Promise<void>,
  options: ChunkedOptions = {},
): Promise<void> {
  const total = items.length;
  if (total === 0) {
    return;
  }

  const chunks = chunk(items, options.chunkSize ?? 200);
  let processed = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    await worker(chunks[index], index);
    processed += chunks[index].length;
    options.onProgress?.(Math.min(processed, total), total);
    if (index < chunks.length - 1) {
      await yieldToEventLoop();
    }
  }
}

/**
 * Maps `items` with at most `limit` workers in flight, yielding between
 * scheduling rounds. Results keep the input order. Use this instead of
 * `Promise.all(items.map(...))` so a large batch cannot saturate the bridge.
 */
export async function mapWithConcurrencyAsync<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (completed: number, total: number) => void,
): Promise<R[]> {
  const total = items.length;
  if (total === 0) {
    return [];
  }

  const safeLimit =
    Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.floor(limit)) : 1;
  const workerCount = Math.min(safeLimit, total);
  const results = new Array<R>(total);
  let nextIndex = 0;
  let completed = 0;

  const runWorker = async (): Promise<void> => {
    for (;;) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= total) {
        return;
      }
      results[current] = await worker(items[current], current);
      completed += 1;
      onProgress?.(completed, total);
      // Let pending UI work run between assignments instead of hot-spinning.
      await yieldToEventLoop();
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}