/**
 * In-memory runtime health snapshots for the diagnostics screen.
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