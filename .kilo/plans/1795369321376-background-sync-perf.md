# Background Sync Performance Optimizations

## Goal

Reduce the wall-clock and JS-thread cost of the React Native background sync pass,
targeting the highest self-time / highest-call functions in `stash-profile.log`,
and reduce SQLite bridge round trips while keeping a single shared connection.

## Profile summary (one `background.pass`, 539s total)

| function | self | calls | root cause | lever |
|---|---|---|---|---|
| `folder.scan` | 320.6s | 1 | synchronous `Directory.list()` blocks JS thread + per-entry Date/ISO work | async legacy enumeration (Task 3) |
| `folder.hash` | 166.3s | 2000 | SHA-256 hashing is **serial** | bounded-concurrency hashing (Task 1) |
| `upload.file` | 64.8s | 50 | network + per-file DB lifecycle | network-bound; concurrency only (out of scope) |
| `upload.storage` | 63.9s | 50 | network PUT | network-bound; concurrency only (out of scope) |
| `background.publish` | 14.0s | 1 | per-row outbox INSERT/UPDATE/event + drain | prepared statements (Task 2/5) |
| `db.insertMany` | 10.9s | 80 | per-row `runAsync` (prepare+exec+finalize each) | prepared statements (Task 2) |
| `db.hashCacheWrite` | 7.3s | 8 | per-row `runAsync` | prepared statements (Task 2) |
| `render.Settings` | 4.3s | 347 | inline rows re-render on every state change (cumulative) | memoize remaining sections (Task 6) |

`folder.ingest` (1.8s), `background.existenceChecks` (1.2s), `lifecycle.applyResponse`
(0.5s), `db.open` (0.5s), `db.candidates` (48ms) are negligible — leave as-is.

## Connection sharing conclusion (do not "pool")

The RN app already shares a **single** `expo-sqlite` connection via the memoized
`getDatabase()` promise (`src/data/database.ts:305`) and serializes all writes
through `transactionQueue.ts`. This is the correct model for expo-sqlite — there
is no connection pool, and adding multiple connections would reintroduce the
"standalone write enrolled in a concurrent transaction" hazard the queue exists to
prevent. **Keep the single connection + serialized write queue.** The DB win comes
from collapsing round trips (prepared statements), not from more connections.

The host (`stash_host_node`) uses `better-sqlite3` (synchronous, single
connection) — pooling is not applicable, and its profile is not in this log.

---

## Task 1 — Parallelize hashing (`folder.hash`)

**File:** `src/services/folderIngestionService.ts`

`ingestFolderInnerAsync` hashes one file at a time inside `forEachChunkedAsync`
(`await this.scanner.computeFileHashAsync(...)`), so 2000 hashes serialize at
~83ms each. `File.digest('SHA-256')` is async native and safe to overlap.

Change:
- Add `const HASH_CONCURRENCY = 4;` (tunable, conservative).
- Within each chunk, hash the chunk concurrently with
  `mapWithConcurrencyAsync(chunk, HASH_CONCURRENCY, async (file) => ({ file, hash: await hashOrCache(file) }))`,
  where `hashOrCache` returns the cached hash on a cache hit or computes it
  otherwise (keep the existing cache-hit/`computeFileHashAsync` logic).
- Then run a **sequential** pass over the results to apply dedup
  (`knownHashes`), build `batch`/`cacheWrites`, and flush at `BATCH_SIZE`.
- Keep `flushBatchAsync`/`flushCacheWritesAsync` and the existing yield points
  unchanged.

This preserves dedup correctness: `knownHashes` is only mutated in the
sequential post-hash pass, so identical content still yields one row.

Expected: `folder.hash` total drops ~2-4x (166s -> ~40-80s at concurrency 4).

## Task 2 — Prepared statements for batch DB writes

**Files:** `src/data/transactionQueue.ts`, `src/data/fileRepository.ts`,
`src/data/hashCacheRepository.ts`, `src/data/outboxRepository.ts`

Add one helper (e.g. `runBatchAsync(db, sql, rows, makeParams)`) in
`transactionQueue.ts` that: `prepareAsync(sql)` once, loops
`statement.executeAsync(params)`, sums `changes`, and `finalizeAsync()` in a
`finally`. It must **not** call `runSerializedAsync` (it runs inside an existing
transaction task).

Convert these per-row `db.runAsync` loops to the helper (all still wrapped in
`runTransactionAsync`):
- `FileRepository.addManyInnerAsync` (`db.insertMany`, 80 calls)
- `HashCacheRepository.putManyInnerAsync` (`db.hashCacheWrite`, 8 calls)
- `FileRepository.setOwnershipManyInnerAsync`
- `FileRepository.deleteManyAsync`
- `OutboxRepository.enqueueManyAsync` (INSERT + the correlated `UPDATE files`
  + `insertFileEventWithDbAsync`; prepare the INSERT and UPDATE once each)

Rationale: `runAsync` = prepare + execute + finalize (3 bridge calls per row);
a prepared loop = 1 prepare + N execute + 1 finalize. ~3x fewer round trips on
the hottest DB paths.

Expected: `db.insertMany` + `db.hashCacheWrite` (~18s combined) drop to roughly
a third.

## Task 3 — Rewrite folder scan using legacy async enumeration (`folder.scan`)

**File:** `src/services/folderScannerService.ts`

Replace the synchronous `Directory.list()` recursive walk with the legacy async
API (`expo-file-system/legacy`), which does not block the JS thread:

- Import `{ readDirectoryAsync, getInfoAsync }` and `StorageAccessFramework`
  from `expo-file-system/legacy`.
- Branch on the folder URI scheme:
  - `content://` (Android SAF, from `Directory.pickDirectoryAsync()`):
    `StorageAccessFramework.readDirectoryAsync(dirUri)` returns **full SAF URIs**.
  - `file://` (manual paths / iOS): `readDirectoryAsync(dirUri)` returns
    **names**; build `child = dirUri + '/' + name`.
- For each entry, call `getInfoAsync(childUri)` to obtain
  `{ size, isDirectory, modificationTime }`. `modificationTime` is epoch
  **seconds** -> store `modifiedAtMs = modificationTime * 1000`.
- Legacy `FileInfo` has **no** `creationTime`: set `createdAt` from
  `modificationTime` (or `modifiedAt`).
- Keep include/exclude glob matching, `includeSubfolders` recursion, and the
  existing `shouldYield` cooperative yields.
- Keep `isFolderAccessibleAsync` working for both schemes.

**Permissions (explicitly requested):**
- Add a pre-scan gate in `backgroundUploadService.runPassAsync` before
  `background.scanFolders`: on Android, call `getStorageAccessAsync()`; when
  `state` is not `granted`/`unsupported`, call `logStorageAccessBlocker()`,
  log a warning, and skip scanning (a background task cannot prompt).
- SAF `content://` folders need no runtime permission; `file://` folders need
  `READ_MEDIA_*` / `READ_EXTERNAL_STORAGE`, already modeled in
  `src/utils/storagePermissions.ts`.
- Classify enumeration/stat failures with the existing `isStoragePermissionError`
  so denials surface the correct hint instead of a generic read error.

Tradeoff to document in code: `readDirectoryAsync` returns names only, so
metadata requires a per-entry `getInfoAsync`. For very large directories, batch
the stat calls with `mapWithConcurrencyAsync` (bounded, e.g. 8) to keep
enumeration non-blocking without an N-serial round-trip tail.

## Task 4 — Background-task confirmation (no code change required)

The scan **already runs inside the Expo background task**:
`stashBackgroundTasks.ts` -> `backgroundUploadService.runOnceAsync()` ->
`background.scanFolders` -> `folderIngestion.ingestFolderAsync` ->
`folderScannerService.scanFolderAsync`. The whole pass (scan + upload + publish)
shares the single `STASH_BACKGROUND_SYNC_TASK` worker, which is the correct
design; no separate task registration is needed. The legacy async file calls
are plain async I/O and are background-safe (no UI dependency).

## Task 5 — Outbox batch (overlaps Task 2)

`background.publish` (14s) is `enqueueManyAsync` + `drainAsync`. Prepared
statements (Task 2) cut the enqueue cost. The `drainAsync`/`flushAsync` produce
loop is sequential (one Kafka produce at a time); leave sequential for now —
parallelizing produces risks response-matching/ordering assumptions. Optional
follow-up only.

## Task 6 — Finish SettingsScreen memoization (`render.Settings`)

**File:** `src/screens/SettingsScreen.tsx`

The memoized sections are in place, but the inline "Appearance", "Account",
"Configuration", and "About" rows still re-render on every state change.
Extract them into `React.memo` sections (mirroring `BackupStatusSection`). Two
gotchas: `identityApiBaseUrl()` / `kafkaProxyUrl()` return new strings each
render (defeating `React.memo` on those rows) — hoist to `useMemo`; and static
`appConfig.*` values are already stable.

This is cumulative (347 renders over app lifetime), not per-pass, so it is the
lowest-priority item.

## Out of scope

- `upload.file` / `upload.storage`: network I/O, already bounded at
  `MAX_CONCURRENT_UPLOADS = 10`. Only lever is the concurrency value, which is
  already reasonable.
- Host `stash_host_node` DB: not present in this profile.

## Risks

- **Parallel hashing**: bounded concurrency avoids native-saturation; dedup is
  preserved by the sequential post-pass. Watch for memory pressure at higher
  `HASH_CONCURRENCY`.
- **Legacy scan rewrite**: `content://` vs `file://` child-URI construction must
  be correct per scheme; loss of `creationTime` changes `files.created_at` for
  new rows (acceptable, documented). SAF grants must be tested on-device.
- **Prepared statements**: must `finalizeAsync()` in `finally`; must not be
  nested inside another queued task (it already runs inside `runTransactionAsync`).

## Validation

1. `npx tsc --noEmit` and `npx expo lint` in `Stash/react_native_stash`.
2. Device pass with `EXPO_PUBLIC_STASH_PROFILE=1`, then confirm:
   - `folder.hash` total drops (parallelism).
   - `db.insertMany` / `db.hashCacheWrite` self drop (~3x).
   - `folder.scan` no longer blocks the JS thread (UI stays interactive during
     scan).
   - No duplicate file rows / no missing rows (spot-check `files` count vs
     scanned count, and `file_events` ordering).
3. Android: verify a `file://` folder scan fails gracefully (permission gate)
   before permissions are granted and succeeds after; verify a `content://`
   (picker) folder scans without extra permission.

## Ordered task list

1. `transactionQueue.ts`: add `runBatchAsync` helper.
2. Convert `fileRepository`, `hashCacheRepository`, `outboxRepository` batch
   writes to prepared statements (Task 2/5).
3. Parallelize hashing in `folderIngestionService.ts` (Task 1).
4. Rewrite `folderScannerService.ts` to legacy async enumeration + permission
   gate in `backgroundUploadService.ts` (Task 3).
5. Memoize remaining SettingsScreen sections (Task 6).
6. Typecheck + lint + on-device profile validation.
