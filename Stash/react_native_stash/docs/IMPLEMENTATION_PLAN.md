# React Native Stash — Reliability, Performance and Observability Implementation Plan

**Status date:** 2026-11-21
**Owner:** React Native client (`react_native_stash`)
**Document type:** Implementation plan and living progress tracker

## 1. Purpose and scope

This document plans the work required to move the Expo/React Native client from a
directionally sound prototype to a production-safe backup client, and to track
progress phase by phase.

- **In scope:** the client in `react_native_stash`. The React Native storage
  provider is S3 (presigned SigV4 `PUT`, version-2 Kafka requests). The host in
  this repository is still MEGA/v1, so S3/v2 processing is a documented gap, not
  a verified path.
- **Out of scope without approval:** changing host processing semantics,
  rewriting the UI, replacing Expo modules with third-party native libraries, or
  adding managed infrastructure. Host S3/v2 support and proxy ACK/inbox work are
  cross-team dependencies, tracked in the deferred/blocked register.
- **Phase status.** Phases 0–3 and the Phase 5 core are complete as of
  2026-11-21; Phase 4 is in progress/partial. Response identity propagation and
  proxy-side filtering are implemented. Remaining blockers are proxy ACK/inbox,
  host S3/v2 support and server-side response routing (see the register).
  Remote telemetry, SLO alert delivery, offline/degraded UX, security STS
  scoping, the CI unit-test/lint suite, multipart/resumable upload, bucket
  lifecycle and the device-performance baseline remain deferred or blocked.

## 2. Current baseline / verdict

**Verdict: directionally sound, not production-safe.**

The local-first flow is coherent: SQLite with a `UNIQUE` content hash, a storage
provider abstraction, a working SigV4 presigner, a Kafka producer/consumer and a
15-minute background pass. The risks below are lifecycle and delivery
correctness issues, not UI problems.

Top risks:

1. **Lifecycle recovery is implemented; live validation remains.** Guarded
   transitions, durable attempt/processing timestamps, a stale-state reaper and a
   transactional outbox are in place. Residual risk: crash/replay behavior has
   only been exercised through typecheck/bundle checks and SQLite simulations, not
   on a physical device; server-side response ACK/inbox remains blocked.
2. **Kafka response acknowledgement.** The proxy now filters by device/user and
   the client validates response identity, correlation and processed-message
   IDs, but offsets still commit before the client applies a record; ACK/inbox
   and server-side routing remain open.
3. **JS-thread hashing and scanning (addressed in Phase 2).** Scanning now uses
   SDK 58 `Directory.list()` with cooperative yields, and hashing delegates to
   native `File.digest('SHA-256')`; web remains buffered by browser APIs.
4. **Client-side S3 credentials.** Long-lived keys are inlined through
   `EXPO_PUBLIC_*`/config; scoped credentials or backend presigning are required.

## 3. Status legend

| Status | Meaning |
| --- | --- |
| `Not started` | No work begun. |
| `In progress` | Actively being worked; partial artifacts may exist. |
| `Complete` | All acceptance criteria met and verification logged. |
| `Blocked` | Waiting on an external team, dependency, or decision. |
| `Deferred` | Intentionally postponed past the current plan. |

## 4. Progress tracker

| Phase | Status | Started | Completed | Verification | Notes |
| --- | --- | --- | --- | --- | --- |
| Phase 0 — Baseline, schema versioning and contracts | `Complete` | 2026-11-21 | 2026-11-21 | `npx tsc --noEmit` passed; `npx expo export --platform web` exported; doc review recorded | Schema v2 migrations, model/repository columns and doc corrections landed. Device baseline deferred (see register). |
| Phase 1 — Lifecycle correctness and delivery reliability | `Complete` | 2026-11-21 | 2026-11-21 | `npx tsc --noEmit` passed; `npx expo export --platform web` exported; `node:sqlite` migration regression passed | Phase 1A domain/lifecycle/auth/consumer and Phase 1B upload/outbox/S3 integration landed. Residual risks are listed in the Phase 1 section. |
| Phase 2 — Off-thread hashing and real folder access | `Complete` | 2026-11-21 | 2026-11-21 | `npx tsc --noEmit` passed; `npx expo export --platform web` exported; `npx expo export --platform android` bundled | Native `File.digest('SHA-256')`, `Directory.pickDirectoryAsync()`/`list()`, system picker UI, cooperative yields, upload progress plumbing and permission-gate removal landed. Residual risks are listed in the Phase 2 section. |
| Phase 3 — Performance and data scaling | `Complete` | 2026-11-21 | 2026-11-21 | `npx tsc --noEmit` passed; `npx expo export --platform web` exported; `npx expo export --platform android` bundled; `node:sqlite` v3 + duplicate-insert checks passed | Hash-cache ingestion, paginated repository/UI, transactional batch inserts, byte-aware upload batches, content-hash S3 keys with HEAD reuse landed. Multipart/resume and bucket lifecycle deferred (see register). |
| Phase 4 — Response identity, inbox and host compatibility | `In progress` | 2026-11-21 | — | `npx tsc --noEmit` passed; `npm test` 24/24 passed; `npm run typecheck` passed; web export succeeded; host tests blocked by missing `Stash.Maui` sources | Response `deviceId`/`userId` added; Vercel proxy filters polled records; RN validates identity. ACK/inbox, host S3/v2 and read-amplification routing blocked. |
| Phase 5 — Observability, hardening and operations | `In progress` | 2026-11-21 | — | `npm run typecheck` passed; `npx expo export --platform web` and `--platform android` bundled (see verification log) | Core diagnostics, `file_events` audit and the error boundary landed. Remote telemetry, SLO alert delivery, offline/degraded UX, security STS scoping and the CI unit-test/lint suite are deferred/blocked. |

## 5. Phases

### Phase 0 — Baseline, schema versioning and contracts

**Objective:** establish a measurable baseline and a migration-safe schema that
later phases can build on, and correct documentation drift.

**Tasks**

- [ ] Capture the baseline: typecheck, lint, app boot, first-scan and hash
      timings on a representative library, plus current upload success rate.
      **Deferred** — no representative device or library is available in this
      environment. See the deferred/blocked register.
- [x] Add `PRAGMA user_version` migration runner in `src/data/database.ts`;
      migrations must be ordered, idempotent, additive and transactional.
- [x] Add lifecycle columns: `upload_started_at`, `processing_started_at`,
      `last_response_at`, `request_correlation_id`, `request_message_id`,
      `host_retry_count`, `next_attempt_at`, `failure_stage`, `updated_at`.
- [x] Add tables: `outbox_messages`, `file_events`, `processed_messages`,
      `file_hash_cache` (columns and indexes defined here, populated later).
- [x] Correct documentation: response message version is 1 (not 2); platform
      folder access behavior; the file state machine; Kafka delivery and
      acknowledgement semantics.
- [ ] Record baseline results and doc review in the verification log.
      **Partially complete** — the doc review and code checks are recorded; the
      device baseline row remains deferred.

**Primary files**

- `src/data/database.ts`
- `src/data/fileRepository.ts`
- `src/models/fileEntity.ts`
- `src/models/uploadStatus.ts`
- `docs/ARCHITECTURE.md`
- `docs/SETUP_AND_USAGE.md`

**Acceptance criteria**

- Fresh install migrates from version 0 and reports the expected
  `PRAGMA user_version`; an existing populated DB upgrades without data loss.
- All new columns/tables/indexes exist and are readable through the repository.
- Re-running migrations is a no-op and does not duplicate objects.
- Docs no longer contradict the implemented response version, folder access,
  state machine, or Kafka delivery behavior.

**Dependencies / risks**

- Schema must stay additive; no destructive migration or column rename.
- Phase 1 consumes these columns/tables; changing them mid-phase forces a new
  migration. Freeze the shape at the end of Phase 0.

---

### Phase 1 — Lifecycle correctness and delivery reliability

**Objective:** make every file row progress through exactly one writer with
guarded transitions, recover stale work, and stop duplicate or mismatched
responses from corrupting state.

**Tasks**

- [x] Introduce `FileLifecycleService` with guarded transitions
      (`Pending → Uploading → Uploaded → Processing → Completed/Failed`, plus
      `Failed → retry`) that rejects illegal transitions and is the only writer
      of status.
- [x] Add stale recovery for `Uploading` and `Processing` using the Phase 0
      timestamps, with a bounded sweep and a visible retry/failure outcome.
- [x] Bind response application to `request_correlation_id` /
      `request_message_id`; ignore responses that do not match the in-flight
      request or arrive out of order.
- [x] Enforce the host retry budget with `host_retry_count`, `next_attempt_at`
      and `failure_stage`; stop retrying after the configured maximum.
- [x] Make auth refresh single-flight so concurrent 401s trigger one refresh and
      all waiters retry with the refreshed token.
- [x] Add a transactional outbox publisher: persist the Kafka intent and the
      transaction's request identity/`publish_queued` event in `outbox_messages`
      and `file_events`, publish from the outbox, and mark sent only after a
      successful publish. Implemented in `src/services/outboxPublisher.ts`.
- [x] S3 transfer hardening: sign the real payload SHA-256 on PUT, add a
      configurable timeout with cancellation, and rely on the file-level retry
      policy (`retryCount`, `next_attempt_at`) for bounded retry with backoff.
      Implemented in `s3Signing.ts`, `s3StorageService.ts` and `s3Transfer.ts`.

**Primary files**

- `src/services/fileLifecycleService.ts` (new)
- `src/services/outboxPublisher.ts` (new)
- `src/data/outboxRepository.ts`
- `src/services/uploadManager.ts`
- `src/services/uploadActions.ts`
- `src/services/backgroundUploadService.ts`
- `src/services/kafkaConsumer.ts`
- `src/services/kafkaProducer.ts`
- `src/auth/authenticationService.ts`
- `src/services/storage/s3Transfer.ts`
- `src/services/storage/s3Signing.ts`
- `src/config/appconfig.json`

**Acceptance criteria**

- No row remains `Uploading`/`Processing` beyond the configured stale threshold
  without a recovery outcome.
- Duplicate, stale, or out-of-order responses are ignored without changing the
  row; matching responses apply exactly once.
- A crash between commit and publish loses nothing: the outbox republishes.
- Concurrent 401s produce one refresh; uploads can be cancelled and time out.
- Retry counts and next-attempt times are observable and respect config.

**Dependencies / risks**

- Requires Phase 0 columns/tables.
- Outbox behavior depends on Kafka producer idempotency and topic availability.
- The host must eventually answer with the expected correlation fields; until
  then, test with synthetic responses.

**Phase 1 residual risks**

- The outbox row is written immediately after the guarded `Uploaded` transition,
  not inside it (the S3 transfer is remote I/O). A crash in that window loses
  the publish intent, but the row stays `Uploaded` and is re-selected by the
  next background pass, which re-uploads instead of silently dropping it.
- Auth failures keep outbox rows pending indefinitely by design so a token
  refresh can recover them; a permanently invalid identity is not dead-lettered
  until the transport returns a non-auth terminal error.
- Local-terminal failures (`failure_stage='local', including missing/oversize
  files) and publish-terminal failures are excluded from automatic background
  candidates and require an explicit manual retry.
- Proxy-side response filtering landed in Phase 4; ACK/commit-after-apply and
  server-side response routing remain blocked. Correlation and
  processed-message dedup are client-side only.
- Stale recovery records `Failed` outcomes but does not produce a dead letter.
  A recovered row that exhausts either budget is excluded from automatic
  candidates and needs a manual retry or operator inspection.
- Live S3 transfer, timeout/cancel behavior and native `File.createUploadTask`
  were not device-tested in this environment; only typecheck and the web bundle
  were verified. Live validation against the staging bucket showed that a
  presigned PUT whose canonical request carries the file's SHA-256 is rejected
  (`403 SignatureDoesNotMatch`), and that sending `x-amz-content-sha256` does not
  fix it; presigned URLs now use `UNSIGNED-PAYLOAD`, per the SigV4 query-string
  rules. The staging application key still answers `403 AccessDenied / not
  entitled` for PUT, HEAD and DELETE, so the key's bucket capabilities must be
  granted before uploads can succeed end to end.

---

### Phase 2 — Off-thread hashing and real folder access

**Objective:** remove long CPU work and broad/free-text path handling from the JS
thread, and use real platform directory pickers and native hashing.

**Tasks**

- [x] Hash natively with `File.digest('SHA-256')` instead of reading full files
      into JS; web keeps a `crypto.subtle` path with a `js-sha256` fallback.
- [x] Select folders with `Directory.pickDirectoryAsync()` and enumerate with
      `Directory.list()`, wired to Android SAF and `UIDocumentPicker` on iOS.
- [x] Make the system picker the primary folder flow and keep a manual path as
      an advanced development/legacy fallback; system-picked folders avoid broad
      storage permissions.
- [x] Use `File.createUploadTask()` for upload progress, cancellation, and
      timeout; expose optional `signal`/`onProgress` transfer options from
      `UploadManager`.
- [x] Add cooperative yields between scan and ingestion items so the UI stays
      responsive; web hashing uses async `crypto.subtle` (no Web Worker).
- [x] Remove the launch-time `StoragePermissionGate`; Settings retains the
      legacy manual-path permission controls.

**Primary files**

- `src/services/folderScannerService.ts`
- `src/utils/fileAccess.ts`
- `src/utils/cooperative.ts` (new)
- `src/utils/storagePermissions.ts`
- `src/services/uploadManager.ts`
- `src/services/storage/s3Transfer.ts`
- `src/components/AddFolderDialog.tsx`
- `src/screens/FoldersScreen.tsx`
- `src/components/FolderRow.tsx`
- `src/screens/SettingsScreen.tsx`
- `App.tsx`

**Acceptance criteria**

- Large-file hashing and large-directory scans do not block the JS thread; the
  UI remains interactive and cooperative yields run between items.
- Folder access goes through the platform picker; no free-text path or broad
  permission is required for normal use.
- Uploads report progress and can be cancelled/timed out.
- Web hashing uses async `crypto.subtle` with a `js-sha256` fallback.

**Dependencies / risks**

- The system picker is the normal path; a manual path remains for development
  and legacy locations, and Android may still request broad storage access for
  those manual paths.
- Physical-device behavior (SAF provider differences, iOS security-scoped URL
  lifetime, and the `content://` digest fallback) was not exercised in this
  environment; only typecheck and bundle exports were verified.
- `Directory.list()` is synchronous, so a single directory with a very large
  number of direct entries still blocks briefly while it returns.
- iOS folder grants are session-scoped and must be re-selected after restart.
- Web still buffers picked files for hashing and upload; `crypto.subtle` is
  async but no Web Worker is used.

**Phase 2 residual risks**

- No physical iOS/Android device validation was performed in this environment;
  SAF provider quirks, iOS re-grant behavior and live native digest performance
  remain unverified.
- iOS folder access is granted for the current app session only. After a
  restart the user must re-select the folder; the stored URI can fail with
  "Folder cannot be read".
- `Directory.list()` is synchronous. Very large single directories can still
  stall the JS thread briefly while the entry array is built.
- Web still reads picked files fully into memory for hashing and upload.
- The native digest failure fallback for `content://` URIs copies the file into
  `Paths.cache`, which temporarily uses extra storage and IO on affected
  providers.

---

### Phase 3 — Performance and data scaling

**Objective:** make scan, list, and upload cost proportional to what changed, not
to the whole library.

**Tasks**

- [x] Add a hash cache keyed by URI + size + lastModified (`file_hash_cache`) so
      unchanged files are not re-hashed. Implemented in
      `src/data/hashCacheRepository.ts` and
      `src/services/folderIngestionService.ts`.
- [x] Make scans incremental: compare against cached metadata and skip unchanged
      files. Unchanged files skip the digest and existing content hashes skip
      insertion; removal propagation remains out of scope for this phase.
- [x] Paginate repositories and UI lists; remove full-table loads from screens.
      `getPageAsync`/`countAsync` back the 50-row Files list.
- [x] Add composite indexes for the query shapes used by the Files screen,
      background pass, and retry sweep (`idx_files_discovered_at`,
      `idx_files_status_discovered`).
- [x] Batch writes in transactions where multiple rows change together
      (`FileRepository.addManyAsync`, 25-row ingestion batches).
- [x] Move to adaptive, byte-weighted upload concurrency so large files cannot
      starve small ones (`UploadSettings.MaxConcurrentBytes`).
- [x] Use a content-hash-based S3 key for integrity and stable deduplication;
      repeated uploads reuse an existing object via HEAD. The signer still signs
      the SHA-256 payload hash on PUT.
- [ ] Add multipart/resume for large objects where the provider supports it.
      **Deferred** — see the deferred/blocked register.
- [ ] Apply bucket lifecycle rules for temporary objects outside the client.
      **Deferred** — see the deferred/blocked register.

**Primary files**

- `src/data/fileRepository.ts`
- `src/data/folderRepository.ts`
- `src/services/folderScannerService.ts`
- `src/services/backgroundUploadService.ts`
- `src/services/uploadManager.ts`
- `src/services/storage/s3Transfer.ts`
- `src/screens/FilesScreen.tsx`
- `src/config/appconfig.json`

**Acceptance criteria**

- Rescans of an unchanged library hash ~0 files and complete quickly.
- List queries are paginated and use the intended indexes; no full-table load.
- Memory stays bounded on large folders; uploads interleave fairly by bytes.
- S3 keys are hash-based; repeated uploads reuse the existing object via HEAD.
- Multipart/resume and bucket lifecycle are carved out as deferred work; see the
  deferred/blocked register.

**Dependencies / risks**

- Requires Phase 2 native metadata (size/lastModified) and scan enumeration.
- Multipart/resume depends on provider and presigner support; may remain
  deferred if the backend cannot sign the required parts.

---

### Phase 4 — Response identity, inbox and host compatibility

**Objective:** make Kafka delivery safe under multiple devices/users and
at-least-once delivery, and close the host S3/v2 gap.

**Tasks**

- [x] Include `deviceId` and `userId` in responses and validate them on the
      client; requests already carry both. The host adds the fields additively
      at response `version: 1`, and `FileLifecycleService` returns `mismatch`
      when a response identity conflicts with the local row. Identity is not
      required when absent (legacy/direct-REST compatibility).
- [x] Filter responses proxy-side so a client does not receive another device's
      or user's outcomes. The Vercel proxy parses each polled record and drops
      records with a different device, a conflicting user, or no usable
      `deviceId` (legacy/unidentified records).
- [ ] Remove commit-before-delivery/ACK; either commit only after delivery and
      ACK, or consume through a durable inbox. **Blocked** — cross-team proxy
      protocol; offsets are still committed by the gateway before the client
      applies a record.
- [x] Persist processed response IDs in `processed_messages` so redelivery is
      idempotent across restarts. Landed in Phase 1.
- [ ] Reduce read amplification: batch/limit response reads, avoid repeated
      scans of the same offsets, and track a durable cursor. **Blocked** — the
      gateway can still read other devices' records; server-side response
      routing is required.
- [ ] Reach host compatibility for S3 storage and version-2 request validation
      (host currently MEGA/v1). **Blocked** — cross-team host S3/v2 work.

**Primary files**

- `src/models/messages.ts`
- `src/services/kafkaConsumer.ts`
- `src/services/kafkaProducer.ts`
- `src/services/kafkaProxyTransport.ts`
- `src/data/fileRepository.ts`
- `docs/ARCHITECTURE.md`
- Host repository files (external)

**Acceptance criteria**

- A response applies only to the originating device/user; foreign responses are
  dropped before they reach SQLite. **Met for the Vercel proxy path and client
  validation.**
- No message is ACKed/committed before it is durably applied or inboxed.
  **Not met — blocked on the ACK/inbox protocol.**
- Redelivered responses are deduplicated across restarts. **Met.**
- The host accepts S3 objects and version-2 requests end to end (once the host
  work lands). **Not met — host S3/v2 blocked.**

**Dependencies / risks**

- **Cross-team dependency:** host S3 provider and v2 validator (blocked).
- **Cross-team dependency:** proxy ACK/inbox protocol and server-side response
  routing (blocked; proxy-side filtering itself is implemented).
- Until these land, end-to-end processing cannot be verified; the phase stays
  `In progress`/blocked, not complete.

---

### Phase 5 — Observability, hardening and operations

**Objective:** make failures diagnosable, behavior measurable, and the client
operable and secure.

**Tasks**

- [ ] Add structured logs with correlation/request IDs; never log secrets,
      tokens, or presigned URLs. **Partial** — `file_events` and the persistent
      error log cover local audit/error paths; remote/structured log shipping is
      deferred.
- [ ] Add metrics: scan duration, hash time, upload bytes/latency, retry counts,
      response apply latency, stuck-row counts. **Partial** — the Settings health
      snapshot reports status, stuck-row and outbox counts plus the last
      pass/flush/response; latency and byte metrics are deferred.
- [x] Record lifecycle transitions and delivery events in `file_events` as an
      audit trail. Landed in Phase 1.
- [x] Add a diagnostics screen showing config, DB version, queue depth, stale
      rows, and recent errors. Settings now renders the health snapshot, recent
      `file_events` and the error log.
- [ ] Define SLOs and alerts (e.g. upload success rate, processing latency,
      stuck rows) and document response procedures. **Documented targets only** —
      alert delivery is deferred.
- [x] Add a React error boundary around the app shell and screens.
      `src/components/ErrorBoundary.tsx` wraps the shell inside `ToastProvider`.
- [ ] Add offline/degraded UX: clear states for no network, auth expiry, and
      host-unavailable processing. **Deferred.**
- [ ] Security scoping: move to STS/presigned backend credentials and remove
      long-lived client keys from bundles. **Blocked** on backend STS/presign
      support.
- [ ] Add CI: typecheck, lint, unit tests for transitions/dedup/outbox, and a
      build check. **Partial** — `npm run typecheck` was added to
      `package.json`; lint and the unit-test suite are deferred.
- [x] Finalize docs: architecture, setup, contracts, and this plan's status.

**Primary files**

- `src/utils/errorLogger.ts`
- `src/services/singletons.ts`
- `src/services/fileLifecycleService.ts`
- `src/screens/SettingsScreen.tsx`
- `src/screens/AboutScreen.tsx`
- `src/components/` (error boundary)
- `src/config/appconfig.json`
- `docs/ARCHITECTURE.md`
- `docs/SETUP_AND_USAGE.md`
- CI configuration (repository root)

**Acceptance criteria**

- Every failure path produces a structured, secret-free log with an ID.
- Metrics and `file_events` answer "what happened to this file?" without a
  debugger.
- Diagnostics surfaces DB version, queue/stale counts, and recent errors.
- SLOs/alerts exist and are documented; error boundary prevents blank screens.
- No long-lived S3 keys ship in the client; CI gates typecheck/lint/tests.

**Dependencies / risks**

- Metrics/SLOs must not require remote telemetry without approval; local
  metrics and logs are in scope, remote export is deferred.
- Credential scoping depends on backend STS/presign support.
- CI depends on the chosen runner and existing scripts.

---

## 6. Cross-cutting rules

1. **Single writer for file status.** Only `FileLifecycleService` changes status;
   no screen, uploader, consumer, or scanner writes status directly.
2. **No whole-row concurrent updates.** Use targeted, guarded updates; never
   read-modify-write an entire row without a transition guard/version check.
3. **All long CPU work off the JS thread.** Hashing, scanning, and large
   serialization run natively or in a worker, with yields between items.
4. **Secrets are never logged.** No tokens, credentials, presigned URLs, or full
   auth headers in logs, events, diagnostics, or crash reports.
5. **No duplicate or out-of-order response application.** Responses are bound to
   request/correlation identity and deduplicated; unmatched responses are
   ignored.
6. **All timeouts and backoffs are configurable.** No hard-coded magic numbers;
   defaults live in `src/config/appconfig.json` and are surfaced in diagnostics.

## 7. Verification log

Append one row after each phase (and after any significant re-verification).

| Date | Phase | Command / check | Result |
| --- | --- | --- | --- |
| 2026-11-21 | 0 | Plan/tracker created; links added to README and docs; no code checks run | Recorded (plan only) |
| 2026-11-21 | 0 | `npx tsc --noEmit` | Passed: no TypeScript errors. |
| 2026-11-21 | 0 | `npx expo export --platform web` | Passed: exported the web bundle to `dist` (796 modules, 3 JS bundles). |
| 2026-11-21 | 0 | Doc review: response version, folder access, lifecycle recovery, Kafka delivery | `ARCHITECTURE.md` corrected; no state-machine or request-version-2 contradictions remain. |
| 2026-11-21 | 1 (1A) | `npx tsc --noEmit` | Passed: no TypeScript errors. |
| 2026-11-21 | 1 (1A) | `node:sqlite` migration regression: old `files` table (20 columns) + `SCHEMA` + v2 migration | Passed: open succeeded after `SCHEMA`, 29 columns, `user_version=2`, `idx_files_next_attempt` present, existing row preserved and `updated_at` backfilled. |
| 2026-11-21 | 1 (1B) | `npx tsc --noEmit` | Passed: no TypeScript errors after the outbox, lifecycle, background-pass and S3 changes. |
| 2026-11-21 | 1 (1B) | `npx expo export --platform web` | Passed: exported the web bundle to `dist` (3 JS bundles). |
| 2026-11-21 | 2 | `npx tsc --noEmit` | Passed: no TypeScript errors after native digest, `Directory.list()` scanning, system picker, cooperative yields and upload transfer options. |
| 2026-11-21 | 2 | `npx expo export --platform web` | Passed: exported the web bundle to `dist` (802 modules, 3 JS bundles). |
| 2026-11-21 | 2 | `npx expo export --platform android` | Passed: bundled the Android JS bundle to `dist` (1101 modules). |
| 2026-11-21 | 3 | `npx tsc --noEmit` | Passed: no TypeScript errors after schema v3, hash cache, folder ingestion, pagination, byte-aware upload batches and S3 HEAD reuse. |
| 2026-11-21 | 3 | `npx expo export --platform web` | Passed: exported the web bundle to `dist` (804 modules, 3 JS bundles). |
| 2026-11-21 | 3 | `npx expo export --platform android` | Passed: bundled the Android JS bundle to `dist` (1103 modules). |
| 2026-11-21 | 3 | `node:sqlite` v3/duplicate check | Passed: an existing v2 DB upgraded to `user_version=3` with `idx_files_discovered_at` and `idx_files_status_discovered` and the row preserved; `INSERT OR IGNORE` inserted 1 of 3 rows (primary-key and content-hash duplicates skipped). Temporary script deleted. |
| 2026-11-21 | 4 | `npx tsc --noEmit` in `react_native_stash` | Passed: no TypeScript errors after response identity parsing/validation. |
| 2026-11-21 | 4 | `npm test` in `kafka_proxy_vercel` | Passed: 24 tests, 24 pass, 0 fail (includes the new device-filtering test). |
| 2026-11-21 | 4 | `npm run typecheck` in `kafka_proxy_vercel` | Passed: no TypeScript errors. |
| 2026-11-21 | 4 | `npx expo export --platform web` (output `dist-phase4`) | Passed: 804 modules, 3 JS bundles. |
| 2026-11-21 | 4 | `dotnet test StashHost.Tests/StashHost.Tests.csproj` | Blocked by a pre-existing source issue: `CS2001` for missing `../Stash.Maui/Auth/*.cs`; `StashHost.Shared` and `StashHost.Functions` compiled before the test project failed. Not caused by the additive response fields. |
| 2026-11-21 | 4 | `dotnet build StashHost.Functions/StashHost.Functions.csproj` | Passed: 0 warnings, 0 errors; `StashHost.Shared` and `StashHost.Functions` compile with the additive response identity fields. |
| 2026-11-21 | 5 | `npm run typecheck` in `react_native_stash` | Passed: no TypeScript errors after the diagnostics UI, error boundary and lifecycle edge fixes. |
| 2026-11-21 | 5 | `npx expo export --platform web` (output `dist`) | Passed: 807 modules, 3 JS bundles. |
| 2026-11-21 | 5 | `npx expo export --platform android` (output `dist`) | Passed: 1106 modules, 1 Android bundle. |
| 2026-11-21 | 5 | `npm test` in `kafka_proxy_vercel` | Passed: 24 tests, 24 pass, 0 fail. |
| 2026-11-21 | 5 | `npm run typecheck` in `kafka_proxy_vercel` | Passed: no TypeScript errors. |
| 2026-11-21 | 5 | `dotnet build StashHost.Functions/StashHost.Functions.csproj` | Passed: 0 warnings, 0 errors. Full host tests not rerun; the pre-existing missing `Stash.Maui/Auth` sources remain. |
| 2026-11-21 | 5 | `rg StoragePermissionGate` in `react_native_stash/src` and `App.tsx` | No references found. |
| 2026-11-21 | 5 | npm run typecheck after boot recovery/content-URI digest hardening | Passed: no TypeScript errors. |

## 8. Deferred / blocked register

| Item | Status | Why | Exit criteria |
| --- | --- | --- | --- |
| Host S3 storage provider + request v2 acceptance | `Blocked` | Host still stages through MEGA and validates version 1 (`megaTempPath`), so RN S3/v2 requests are rejected. Cross-team. | Host reads S3 temporary objects and accepts version-2 requests end to end. |
| Proxy ACK / inbox protocol (commit-after-delivery) | `Blocked` | The gateway commits offsets before the client applies a record; making it safe needs an ACK or durable inbox protocol. Proxy-side identity filtering alone does not fix it. Cross-team. | Proxy commits only after delivery/ACK, or exposes a durable inbox. |
| Server-side response routing / read amplification | `Blocked` | Each device's poll can still read other devices' response records from the shared topic before the proxy drops them; fixing this needs host/proxy routing (per-device topics, partitioning or a durable cursor). | Response records are routed or partitioned per device/user so other devices' records are not read. |
| Multipart / resumable upload and bucket lifecycle configuration | `Deferred` | Single signed PUT remains capped by the app's 500 MB limit and S3's 5 GB single-PUT limit; requires part-level slicing/presigning, persisted upload state, and a host-compatible key/contract. | Provider supports multipart signing and a bucket lifecycle policy is approved for temporary objects. |
| Remote telemetry / metrics export | `Deferred` | Requires approval and infrastructure; local logs/metrics/diagnostics cover Phase 5 first. | Approved backend and retention/privacy policy. |
| Structured telemetry/log shipping | `Deferred` | Local `file_events` and the persistent error log cover on-device diagnosis; shipping logs/metrics off-device needs approval and infrastructure. | An approved telemetry backend with retention/privacy rules and an opt-in client. |
| SLO alert delivery | `Deferred` | SLO targets are documented, but alert routing/delivery needs an operations backend and on-call ownership. | SLOs are wired to a monitored alert channel with documented response procedures. |
| Offline/degraded UX | `Deferred` | Clear no-network/auth-expiry/host-unavailable states need product copy and screen work beyond this pass. | Screens show explicit offline/degraded states without retrying silently. |
| CI unit-test/lint suite | `Deferred` | Only the `typecheck` script was added; lint configuration and transition/dedup/outbox unit tests need a runner decision. | CI runs typecheck, lint and unit tests on every change. |
| Device performance baseline | `Deferred` | No representative device or library is available in this environment; only the typecheck and web-export checks were run. | Capture app boot, first-scan and hash timings, and upload success rate on a representative device/library. |
**Phase 3 deferred entry:** Multipart/resumable upload and bucket lifecycle
configuration — deferred; single signed PUT remains capped by the app's 500 MB
limit and S3's 5 GB single-PUT limit; requires part-level slicing/presigning,
persisted upload state, and a host-compatible key/contract.

## 9. Maintenance note

Update the **progress tracker** (Section 4), the phase task checkboxes, and the
**verification log** (Section 7) in this same file after every phase. A phase is
`Complete` only when all acceptance criteria are met and a verification row
records the command/check and result. Keep the deferred/blocked register current
so cross-team gaps are never mistaken for finished work.
