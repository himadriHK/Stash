/**
 * Identifiers for Expo background tasks.
 *
 * Kept in a side-effect-free module so the task definition and the scheduler can
 * reference the same name without importing each other (and without creating an
 * import cycle with the service singletons).
 */
export const STASH_BACKGROUND_SYNC_TASK = 'STASH_BACKGROUND_SYNC';