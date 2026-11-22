/**
 * In-memory runtime health snapshots for the diagnostics screen and the sync
 * progress banner.
 *
 * This module is intentionally dependency-free apart from the two type-only
 * imports below: it holds no singletons and never touches the database, so
 * services can record outcomes without introducing import cycles. The state is
 * process-local and resets whenever the JS runtime reloads.
 */
import type { BackgroundUploadResult } from './backgroundUploadService';
import type { OutboxFlushResult } from './outboxPublisher';

export interface BackgroundPassSnapshot {
  at: string;
  result: BackgroundUploadResult;
}

export interface OutboxFlushSnapshot {
  at: string;
  result: OutboxFlushResult;
}

let backgroundPass: BackgroundPassSnapshot | null = null;
let outboxFlush: OutboxFlushSnapshot | null = null;
let lastConsumerRecordAt: string | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

export function recordBackgroundPass(result: BackgroundUploadResult): void {
  backgroundPass = { at: nowIso(), result };
}

export function getBackgroundPassSnapshot(): BackgroundPassSnapshot | null {
  return backgroundPass;
}

export function recordOutboxFlush(result: OutboxFlushResult): void {
  outboxFlush = { at: nowIso(), result };
}

export function getOutboxFlushSnapshot(): OutboxFlushSnapshot | null {
  return outboxFlush;
}

export function recordConsumerRecord(): void {
  lastConsumerRecordAt = nowIso();
}

export function getLastConsumerRecordAt(): string | null {
  return lastConsumerRecordAt;
}

/** Coarse phases of a scan/upload pass, used for the progress banner. */
export type SyncPhase = 'idle' | 'scanning' | 'hashing' | 'uploading' | 'publishing';

export interface SyncProgressSnapshot {
  active: boolean;
  phase: SyncPhase;
  /** Items handled in the current phase. */
  processed: number;
  /** Items in the current phase, or 0 when the total is not known yet. */
  total: number;
  startedAt: string | null;
  updatedAt: string | null;
}

const IDLE_PROGRESS: SyncProgressSnapshot = {
  active: false,
  phase: 'idle',
  processed: 0,
  total: 0,
  startedAt: null,
  updatedAt: null,
};

type SyncProgressListener = (snapshot: SyncProgressSnapshot) => void;

let syncProgress: SyncProgressSnapshot = IDLE_PROGRESS;
const syncProgressListeners = new Set<SyncProgressListener>();

/** Human-readable label for the current phase. */
export function syncPhaseLabel(phase: SyncPhase): string {
  switch (phase) {
    case 'scanning':
      return 'Scanning files';
    case 'hashing':
      return 'Hashing files';
    case 'uploading':
      return 'Uploading';
    case 'publishing':
      return 'Queuing uploads';
    default:
      return 'Syncing';
  }
}

/** Formats the snapshot for the banner, e.g. "Scanning files 320/10000". */
export function formatSyncProgress(snapshot: SyncProgressSnapshot | null): string | null {
  if (!snapshot || !snapshot.active) {
    return null;
  }
  const label = syncPhaseLabel(snapshot.phase);
  return snapshot.total > 0
    ? `${label} ${snapshot.processed}/${snapshot.total}`
    : label;
}

/**
 * Progress notifications are throttled: the upload loop reports once per file,
 * and re-rendering the banner 10k times would be its own performance problem.
 */
const NOTIFY_INTERVAL_MS = 250;
let lastNotifyAt = 0;

function emitSyncProgress(): void {
  for (const listener of syncProgressListeners) {
    try {
      listener(syncProgress);
    } catch {
      // A failing subscriber must not break the sync pipeline.
    }
  }
}

function publishSyncProgress(next: SyncProgressSnapshot, immediate: boolean): void {
  syncProgress = next;
  if (immediate) {
    lastNotifyAt = Date.now();
    emitSyncProgress();
    return;
  }
  const now = Date.now();
  if (now - lastNotifyAt >= NOTIFY_INTERVAL_MS) {
    lastNotifyAt = now;
    emitSyncProgress();
  }
}

/** Marks a new pass as running. */
export function beginSyncProgress(phase: SyncPhase, total = 0): void {
  const now = nowIso();
  publishSyncProgress(
    {
      active: true,
      phase,
      processed: 0,
      total: Math.max(0, Math.floor(total)),
      startedAt: now,
      updatedAt: now,
    },
    true,
  );
}

/** Updates the current phase counters; ignored when no pass is running. */
export function updateSyncProgress(phase: SyncPhase, processed: number, total: number): void {
  if (!syncProgress.active) {
    return;
  }
  publishSyncProgress(
    {
      ...syncProgress,
      phase,
      processed: Math.max(0, Math.floor(processed)),
      total: Math.max(0, Math.floor(total)),
      updatedAt: nowIso(),
    },
    false,
  );
}

/** Ends the pass and resets the banner. */
export function endSyncProgress(): void {
  if (!syncProgress.active) {
    return;
  }
  publishSyncProgress(IDLE_PROGRESS, true);
}

export function getSyncProgressSnapshot(): SyncProgressSnapshot {
  return syncProgress;
}

/** Subscribes to progress changes; returns the unsubscribe function. */
export function subscribeSyncProgress(listener: SyncProgressListener): () => void {
  syncProgressListeners.add(listener);
  listener(syncProgress);
  return () => {
    syncProgressListeners.delete(listener);
  };
}