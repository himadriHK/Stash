/**
 * Cooperative scheduling helpers for long scan and ingestion loops.
 *
 * The scanner enumerates directories and hashes files in the JS runtime. Yielding
 * periodically lets React Native process UI and touch events so a large folder
 * does not monopolize the JS thread.
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