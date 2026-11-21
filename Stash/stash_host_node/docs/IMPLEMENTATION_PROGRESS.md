# Stash Host Node - Implementation Progress

Purpose: track the remaining Phase 4-6 work for the Stash Host Node at `D:\Projects\Stash\Stash\stash_host_node`. This file is the execution checklist and verification record; `docs/IMPLEMENTATION_PLAN.md` remains the design and scope document. Checkboxes stay unchecked until the item is implemented and verified. No code is implemented by this tracker, and no live-provider result is claimed unless it was actually run.

Plan date: 2026-11-21. Last updated: 2026-11-21.

## 1. Overall status

| Phase | Status | Notes |
| --- | --- | --- |
| 0 - Plan / architecture | Complete | Implementation plan reviewed against the legacy host and the RN v2 contract. |
| 1 - Scaffold, config, DB, types | Complete | TypeScript ESM scaffold, zod config, SQLite WAL with `user_version` migrations, repositories, unit tests. |
| 2 - Contracts, JWT, Kafka, enqueue, outbox, health | Complete | v2 validation, HS256 verification, fake-consumer ingest/DLQ/duplicate tests, outbox dispatcher skeleton. |
| 3 - S3, media, workers, leases, recovery | Complete | Ten-stage runner, leases/heartbeats/recovery, worker pool, S3/local/media modules, fake-provider pipeline tests. |
| 4 - API, SSE, health, metrics, runtime wiring | In progress | Route surface, SSE event bus, component checks, metrics, and process wiring are being implemented. |
| 5 - React dashboard / UI | Not started | Vite/React/Mantine shell and pages are not implemented. |
| 6 - Docker, docs, integration, verification | Not started | Packaging, compose, root-doc migration, and final verification are not implemented. |

### Verification snapshot (as of Phase 3)

| Check | Result | Scope |
| --- | --- | --- |
| Vitest suite | Pass: 105 tests passed, 1 skipped | 11 files; skipped case is the optional MOV conversion because no ffmpeg fixture is guaranteed. |
| TypeScript typecheck | Pass | `npm run typecheck` as of Phase 3. |
| Build | Pass | `npm run build` as of Phase 3; emits server and worker entry points. |
| Live Kafka | Not exercised | Consumer/producer tests use fakes. |
| Live S3 | Not exercised | S3 behavior is covered with an injected fake client. |
| Live FFmpeg / codecs | Not exercised | No successful video conversion is claimed; MOV case skipped. |
| Dashboard UI | Not implemented | Phase 5. |
| Docker / compose | Not implemented | Phase 6. |

## 2. Phase 4 - API, SSE, health, metrics, runtime wiring

### 2.1 Finalization and leases

- [ ] Fix finalization re-claim: a job in terminal finalization must not be re-claimed by the worker pool.
- [ ] Extend lease/heartbeat ownership across finalization (response outbox, send, temp deletion) or use a distinct finalization guard.
- [ ] Keep expired-lease recovery idempotent: requeue or finalize exactly once, with no double response and no unsafe permanent writes.
- [ ] Preserve the guarded deletion policy and terminal-row exclusion from automatic upload candidates.
- [ ] Add regression tests for finalization race, heartbeat renewal, lease expiry, and stale Uploading/Processing recovery.

### 2.2 Fastify app and routes

- [ ] Fastify app factory with config injection, Pino logger, request IDs, error serializer, helmet, and consistent JSON error envelopes.
- [ ] Health: `GET /health/live`, `GET /health/ready`.
- [ ] Status: `GET /api/status`, `GET /api/components`.
- [ ] Jobs: `GET /api/jobs` (filters and pagination), `GET /api/jobs/:id`, `GET /api/jobs/:id/events`.
- [ ] Job actions: `POST /api/jobs/:id/retry`, `POST /api/jobs/:id/cancel` with validation and terminal-state rules.
- [ ] Stats: `GET /api/stats`, `GET /api/stats/timeseries`.
- [ ] Logs: `GET /api/logs` from the in-memory redacted ring buffer.
- [ ] Config: `GET /api/config` with secrets and credentials redacted.
- [ ] Metrics: `GET /metrics` in Prometheus text format.
- [ ] Optional HTTP Basic auth for dashboard/API routes; enabled only when credentials are configured.
- [ ] Keep the localhost bind default (`127.0.0.1:8080`); do not expose unauthenticated control routes by default.

### 2.3 Event bus and SSE

- [ ] Typed in-process event bus for job, stage, component, outbox, and worker-pool events.
- [ ] `GET /api/events` SSE endpoint with an initial snapshot, live incremental updates, heartbeat/comment frames, and `Last-Event-ID` replay where supported.
- [ ] Slow-client eviction and bounded subscriber resources; no unbounded buffering.
- [ ] Document snapshot plus invalidation semantics so the Phase 5 UI can reconcile REST data with live events.

### 2.4 Component health checks

- [ ] Database: open handle, WAL mode, quick integrity check, migration version.
- [ ] Temp directory: exists, writable, and usable.
- [ ] Local library: root exists, writable, and disk free space via `statfs`.
- [ ] S3: `HeadBucket` with classified error details (sanitized, no credentials).
- [ ] Kafka consumer/producer: connection/state, assigned partitions, and lag where available.
- [ ] Worker pool: capacity, active workers, and stalled/expired leases.
- [ ] Outbox: backlog count and oldest pending age.
- [ ] Media tooling: sharp, ffmpeg/ffprobe, HEIC decoder, and RAW loader availability/version probes.
- [ ] Missing or unavailable providers report `degraded`/`down` instead of crashing the process.
- [ ] Persist latest checks in `component_checks` and refresh periodically with jitter; expose sanitized status, latency, detail, and checked-at timestamps.

### 2.5 Metrics, runtime wiring, shutdown

- [ ] Prometheus metrics: jobs by stage/status, stage duration, failures/retries, queue depth, outbox backlog, lease age, component status/latency, SSE clients, and HTTP latency.
- [ ] Surface queue depth/backpressure in metrics and drive consumer pause/resume.
- [ ] Start the outbox dispatcher loop, Kafka consumer, worker pool, component refresh, and SSE heartbeat from the server entry point.
- [ ] Graceful shutdown with a bounded timeout: stop intake, drain/stop workers, flush/stop dispatcher and producer, close SSE/HTTP/DB, and avoid leaked handles.

### 2.6 Static UI serving hook

- [ ] Serve `ui/dist` through `@fastify/static` when it exists.
- [ ] SPA fallback for non-API routes, excluding `/api`, `/health`, and `/metrics`.
- [ ] Return a clear placeholder or 404 when the UI build is absent, without breaking API routes.

### 2.7 Tests and acceptance

- [ ] Fastify `inject` tests: health live/ready, auth 401/200, pagination/filters, detail 404, events, retry/cancel validation, config redaction, and metrics scrape.
- [ ] SSE tests: initial snapshot, live update, heartbeat, replay, and slow-client eviction.
- [ ] Finalization regression tests pass alongside the Phase 3 suite.
- [ ] Acceptance: typecheck, tests, and build pass; JSON is stable and secret-free; readiness reflects dependency state; missing providers degrade; SSE and metrics work; start/stop is clean; no unverified live-provider claims.

## 3. Phase 5 - React dashboard / UI

- [ ] Vite + React + TypeScript + Mantine shell with React Router and a shared theme.
- [ ] Dashboard: component cards, live pipeline graph (`@xyflow/react`), active jobs with progress, metrics charts (Recharts), and recent events.
- [ ] Jobs list with filters, pagination, and status/stage indicators.
- [ ] Job detail with stage timeline, events, logs, retry, and cancel actions.
- [ ] Components page and logs page backed by REST plus SSE updates.
- [ ] SSE hook with snapshot hydration, live updates, reconnect/backoff, and TanStack Query invalidation.
- [ ] TanStack Query for all REST data with loading, error, and empty states.
- [ ] Responsive layout, keyboard/focus basics, accessible labels, and no secret exposure in UI state or rendered output.
- [ ] `npm run build:ui` passes and the built assets are served by the Fastify static hook.
- [ ] Acceptance: all routes render against a fake API; live updates, auth, empty, and error states work; UI build passes; no screenshots or browser E2E are claimed unless actually run.

## 4. Phase 6 - Docker, docs, integration, verification

### 4.1 Packaging

- [ ] Multi-stage non-root `Dockerfile` with a healthcheck.
- [ ] `.dockerignore` covering node_modules, dist, test artifacts, local DB, and secrets.
- [ ] `docker-compose.yml` for the app, MinIO, and Redpanda, including bucket bootstrap and optional profiles.
- [ ] Mounted library volume, env wiring, and container healthcheck validated.

### 4.2 Configuration and docs

- [ ] `.env.example` for app, S3/MinIO, Kafka/Redpanda, auth, paths, and media settings.
- [ ] `README.md`, `docs/ARCHITECTURE.md`, and `docs/RUNBOOK.md`.
- [ ] Update root runbook, proxy consumer, and RN docs to point at the Node host; mark the old Functions project legacy.
- [ ] Clearly label anything not yet live-verified.

### 4.3 Integration and final verification

- [ ] Optional MinIO/Redpanda integration tests, or a documented manual smoke procedure.
- [ ] Final typecheck, tests, build, UI build, and Docker config checks.
- [ ] Record every executed command/result in the verification log below.
- [ ] Acceptance: image builds and starts with mounted volume/env; compose integration passes when run; docs contain no unverified claims; the old Functions project is untouched.

## 5. Verification log

| Date | Phase | Check | Result |
| --- | --- | --- | --- |
| 2026-11-21 | 0-3 | Vitest suite | Pass: 105 tests, 1 skipped (optional MOV conversion). |
| 2026-11-21 | 0-3 | Typecheck | Pass as of Phase 3. |
| 2026-11-21 | 0-3 | Build | Pass as of Phase 3. |
| 2026-11-21 | 4 | API/SSE inject tests | Pending implementation. |
| 2026-11-21 | 4 | Finalization regression | Pending implementation. |
| 2026-11-21 | 5 | UI build | Pending (Phase 5 not started). |
| 2026-11-21 | 6 | Docker/compose config | Pending (Phase 6 not started). |
| 2026-11-21 | 6 | Live Kafka/S3/FFmpeg validation | Not run. |

## 6. Blocked / deferred

| Item | State | Reason / next step |
| --- | --- | --- |
| Live Kafka end-to-end | Deferred | Requires a live broker (or Redpanda) and exercised consumer/producer paths. |
| Live S3 / MinIO end-to-end | Deferred | Requires a live bucket and credentials; current coverage uses a fake S3 client. |
| Live FFmpeg / codec validation | Deferred | No guaranteed video/codec fixtures; MOV case remains skipped, no successful video conversion claimed. |
| Multi-node scaling | Deferred | Single-writer SQLite and local library are by design for Phases 1-6. |
| UI screenshots / browser E2E | Deferred | Phase 5 not started; only a build check is planned. |
| Backend-issued S3 credentials / STS | Deferred | S3 credentials are still bundled; presigned issuance is a follow-up. |
| Multipart/resumable uploads above 500 MB | Out of scope | Single signed PUT capped by the app's 500 MB limit. |
| Proxy ACK / inbox | Deferred | Offsets are still committed before client apply. |

## 7. Maintenance

After every phase, update this file and `docs/IMPLEMENTATION_PLAN.md` together: phase status, checklist, verification log, blocked/deferred items, and the "as of" snapshot. Only mark a checkbox or claim a provider result after the corresponding command was executed and its result recorded.