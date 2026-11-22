/**
 * Serialized access to the shared SQLite connection.
 *
 * `expo-sqlite` exposes one connection per database, and
 * `SQLiteDatabase.withTransactionAsync` issues a plain `BEGIN` on it. That
 * creates two hazards when work runs concurrently (for example the upload
 * batch, which transfers `BatchSize` files through `Promise.all`):
 *
 * 1. A second `BEGIN` while a transaction is open fails with
 *    "cannot start a transaction within a transaction".
 * 2. A standalone write that runs while a transaction is open is silently
 *    enrolled in it, so a rollback of that transaction also undoes the write.
 *
 * Everything below runs through one promise queue, which makes each queued
 * task wait until the transaction or write ahead of it has finished. The
 * surrounding work (file reads, network transfers) still runs concurrently.
 *
 * Use `runTransactionAsync` for multi-statement atomic work, `runWriteAsync`
 * for a single writing statement, and `runSerializedAsync` when the write is
 * performed by a helper that takes the raw connection. Never call these from
 * inside a queued task: the nested call would wait on its own queue slot.
 */
import type { SQLiteBindParams, SQLiteRunResult } from 'expo-sqlite';

export interface TransactionCapableDatabase {
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

export interface WriteCapableDatabase {
  runAsync(source: string, params: SQLiteBindParams): Promise<SQLiteRunResult>;
}

let tail: Promise<void> = Promise.resolve();

/**
 * Runs `task` once every queued transaction and write ahead of it has finished,
 * and holds the queue until it settles.
 */
export async function runSerializedAsync<T>(task: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await task();
  } finally {
    // Release the queue even when the task throws; the error still propagates
    // to this caller and the next task runs against the rolled-back database.
    release();
  }
}

/** Runs `task` inside a transaction that cannot overlap another queued task. */
export async function runTransactionAsync(
  db: TransactionCapableDatabase,
  task: () => Promise<void>,
): Promise<void> {
  await runSerializedAsync(() => db.withTransactionAsync(task));
}

/**
 * Runs one writing statement on the queue, so it can neither join an open
 * transaction nor be rolled back with one.
 */
export async function runWriteAsync(
  db: WriteCapableDatabase,
  source: string,
  params?: SQLiteBindParams,
): Promise<SQLiteRunResult> {
  return runSerializedAsync(() => db.runAsync(source, params ?? []));
}
