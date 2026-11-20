# Stash Implementation Verification Steps

**Based on:** ARCHITECTURE_HLD_v2.md and ARCHITECTURE_LLD_v2.md  
**Version:** 1.2  
**Date:** 2026-10-29  
**Last verified:** 2026-10-29  
**Purpose:** Verification checklist for each implementation step  
**Status:** Phase 0 complete; Phase 1 code complete but live Mega.io calls unverified; Phase 2.1 implemented/tested with revoke authorization fixed; Phase 2.2 deploy blocked on Azure access; Phase 3 core pipeline implemented, ImageSharp replaced by Magick.NET, HEIC/AVIF/WebP conversion and RAW→JPEG with a real CC0 DNG fixture verified, request/hash/JSON/cleanup/provider fixes tested; MOV→MP4 is implemented through the FFmpeg CLI and tested, while video thumbnails remain unimplemented; live E2E blocked; **Phases 4.1–4.7 code complete and tested**; physical Android/iOS background execution and packaged Windows background registration remain unverified; Phase 4.8 and 8 not started; Phase 7 partial, with mocked orchestration and Kafka-trigger tests added. Debug build: 0 errors; Android emits one `XA0141` warning plus WorkManager `NU1608` dependency-range warnings. Tests: 110 `StashHost.Tests` + 52 `Stash.Maui.Tests` pass. Mobile Kafka uses a REST proxy; live Kafka verification is deferred.  

---

## How to Use This Document

Each implementation task in `IMPLEMENTATION_TODO.md` has corresponding verification steps below. Execute the verification steps after completing each task. A task is considered **complete** only when all its verification steps pass.

---

## 2026-10-29 Verification Run

| Check | Command / evidence | Result |
|-------|--------------------|--------|
| Debug solution build | `dotnet build Stash\Stash.slnx -v:q --nologo` | **0 errors, 1 Android `XA0141` warning (`Microsoft.JavaScript.LibNode`) plus `NU1608` WorkManager/Lifecycle dependency-range warnings** |
| Full test suite | `dotnet test Stash\Stash.slnx --no-build --nologo` | **110** host tests + **52** MAUI configuration/auth/database/scanner/upload/Kafka/background tests passed |
| MAUI Windows build | `dotnet build Stash\Stash.Maui\Stash.Maui.csproj -f net10.0-windows10.0.19041.0 -v:q --nologo` | 0 errors, 6 `NU1608` restore warnings |
| MAUI Windows runtime | Launch `Stash.Maui.exe`, wait 8 seconds; UI Automation checks | Stayed running; login fields rendered; submit reached expected unconfigured-URL error; register route opened |
| MAUI iOS/MacCatalyst build | `dotnet build ... -f net10.0-ios` / `net10.0-maccatalyst` | 0 errors each, 6 `NU1608` restore warnings each (Windows-host compile; not run on macOS) |
| MAUI Android build | `dotnet build ... -f net10.0-android -v:q --nologo` | 0 errors; one `XA0141` 16 KB page-size warning (`Microsoft.JavaScript.LibNode`) plus `NU1608` WorkManager/Lifecycle dependency-range warnings |
| Phase 4.7 tests | `--filter FullyQualifiedName~Phase4BackgroundUploadTests` | 9 passed |
| Background platform execution | Android/iOS devices, packaged Windows app | **Not verified**; no device available, and Windows is unpackaged |
| Phase 2 tests | `--filter FullyQualifiedName~Phase2IdentityApiTests` | 16 passed |
| Phase 3 tests | `--filter FullyQualifiedName~Phase3BackendTests` | 60 passed |
| Phase 7 unit tests | `--filter "FullyQualifiedName~Phase7OrchestrationTests\|FullyQualifiedName~Phase7KafkaTriggerTests"` | 30 passed |
| Magick.NET runtime | Q8 AnyCPU 14.17.2 / ImageMagick 7.1.2-32 | HEIC read=True, AVIF read/write=True, WebP read/write=True, CR2/NEF/ARW/DNG/RAW read=True, HEIC write=False (not required) |
| HEIC production path | `ImageConverter.ConvertAsync` on a 718,114-byte HEIC fixture | Decoded 1280×854; wrote a 501,015-byte JPEG |
| RAW production path | CC0 Blackmagic DNG fixture, 1,228,096 bytes, 1952×1104 | `RawImageConverter` and `ConvertFormatActivity` both wrote a valid JPEG >10 KB; corrupt DNG failed with no JPEG |
| AVIF/WebP production path | Unit tests | Valid JPEG output |
| MOV→MP4 production path | FFmpeg 9.0.1; 1-second 160×120 MOV fixture; default `libx264` | Converted to MP4; full-decode check exited 0 |
| Missing FFmpeg | `VideoConverter` with a nonexistent executable path | Clear `InvalidOperationException`; no partial output |
| Download size validation | `DownloadFileActivity.RunCore` with exact, shorter, and longer streams | Exact size succeeds; mismatches fail and leave no temp file |

**Not verified:** a complete Release solution build was not obtained (the command timed out after 300 seconds while building the Android target; it emitted an unrelated Android 16 KB page-size warning for `libnode.so`). Live Kafka/Azure/Mega and video thumbnails remain blocked or unimplemented; production must provide FFmpeg or set `STASH_FFMPEG_PATH`. Proprietary CR2/NEF/ARW files use the same Magick.NET decoder but each format has not been separately exercised with a fixture.

---

## Phase 0: Foundation & Solution Structure (COMPLETE)

### 0.1 Create Solution Structure

**Verification Steps:**
- [x] Run `dotnet build Stash\Stash.slnx` → exits with code 0, **0 errors, 0 warnings** (Debug, 2026-10-29). ImageSharp was removed, so the former license warning is gone.
- [x] All projects target .NET 10 (check `.csproj` files for `<TargetFramework>net10.0</TargetFramework>`)
- [x] `Stash.Maui` references `StashHost.Shared`
- [x] `StashHost.Functions` references `StashHost.Shared`
- [x] `StashHost.IdentityApi` references `StashHost.Shared`
- [x] `StashHost.Tests` references `StashHost.Functions`, `StashHost.IdentityApi`, and `StashHost.Shared`
- [x] MAUI.Tests does not reference MAUI app directly (expected for MAUI architecture - testable logic in shared class libs)

---

## Phase 1: Shared Core & Storage Provider (code complete; live Mega unverified)

### 1.1 Implement Shared Models & Contracts (COMPLETE)

**Verification Steps:**
- [x] `UploadRequestMessage` serializes to JSON with all fields: messageId, timestamp, fileId, fileName, fileSize, mimeType, megaTempPath, metadata, deviceId, userId, correlationId, version
- [x] `UploadResponseMessage` serializes to JSON with all fields: messageId, timestamp, fileId, status, permanentPath, thumbnails, convertedFormat, deduplicated, processingTimeMs, error, correlationId, version
- [x] `ProcessingContext` has all fields: MessageId, FileId, FileName, FileSize, MimeType, MegaTempPath, UserId, DeviceId, CorrelationId, FileHash, LocalFilePath, ConvertedFilePath, ConvertedFormat, PermanentPath, Thumbnails, IsDeduplicated, StartTime
- [x] `ActivityResult.Success()` returns `IsSuccess=true`, `Error=null`
- [x] `ActivityResult.Failure("msg")` returns `IsSuccess=false`, `Error="msg"`
- [x] JSON round-trip: `JsonSerializer.Deserialize<UploadRequestMessage>(JsonSerializer.Serialize(msg))` produces equal object

### 1.2 Implement Storage Provider Abstraction (CODE COMPLETE; LIVE MEGA UNVERIFIED)

**Verification Steps:**
- [x] `MegaStorageProvider` constructor accepts `IOptions<MegaStorageOptions>` and `ILogger<MegaStorageProvider>` (compile-verified)
- [ ] `UploadFileAsync` uploads file stream to Mega.io via MegaStorageClient (code present; **live Mega blocked**; the client buffers the whole stream in memory)
- [ ] `DownloadFileAsync` downloads file stream from Mega.io via MegaStorageClient (code present; **live Mega blocked**; whole file is buffered in memory)
- [ ] `DeleteFileAsync` returns `true`/`false` (code present; live Mega blocked)
- [ ] `FileExistsAsync` returns `true`/`false` (code present; live Mega blocked)
- [ ] `GetFileSizeAsync` returns file size in bytes (code present; live Mega blocked)
- [x] `StorageProviderFactory.Create()` returns the same cached `MegaStorageProvider` when config `Storage:Provider` = "Mega" (unit test)
- [x] `StorageProviderFactory.Create("Unknown")` throws `NotSupportedException` (unit test)
- [x] `StorageProviderFactory` implements `IAsyncDisposable` and disposes the cached provider at host shutdown (code + build)
- [x] `MegaStorageProvider` shares one initialization task across concurrent calls and resets it after failure (code review; no concurrency test)
- [x] `MegaPathMapper` maps `/thumbs/{user}/128/{hash}.jpg` and `/thumbs/{user}/256/{hash}.jpg` to different deterministic root names (unit test)
- [ ] Mega physical hierarchy `/temp`, `/backups`, `/thumbs` is **not** created; unique root names are used instead. Live Mega is still blocked, and existing bare root files need migration/re-upload.
- [x] Build succeeds with 0 errors and 0 warnings for `MegaConnectivity.Core` + `StashHost.Shared`

---

## Phase 2: Identity API

### 2.1 Implement Identity API Project (IMPLEMENTED/TESTED; REVOKE AUTH FIXED)

**Verification Steps:**
- [x] `POST /api/auth/register` with valid email/password/deviceId returns 200 with JSON containing `accessToken` and `refreshToken`
- [x] `POST /api/auth/register` with duplicate email returns **409** (invalid input returns 400)
- [x] `POST /api/auth/login` with valid credentials returns 200 with JWT tokens
- [x] `POST /api/auth/login` with invalid credentials returns 401
- [x] `POST /api/auth/refresh` with valid refresh token returns 200 with new access token
- [x] `POST /api/auth/refresh` with expired/invalid refresh token returns 401
- [x] `POST /api/auth/revoke` with a valid JWT and the caller's deviceId returns 200
- [x] `POST /api/auth/revoke` without a JWT returns 401
- [x] Revoking a `deviceId` that belongs to another user does not revoke that user's device/refresh tokens (cross-user test with the same `deviceId`)
- [x] JWT tokens contain `userId` and `deviceId` claims
- [x] JWT tokens are signed with configured `Auth:Jwt:SigningKey`
- [x] JWT tokens have `issuer` = "stash-auth" and `audience` = "stash-app"
- [x] MongoDB connection string configured (`MongoDB:ConnectionString`, `MongoDB:DatabaseName`)
- [x] User data persisted in MongoDB `users` collection

**Execution log (2026-10-29):**
- `dotnet test Stash\StashHost.Tests\StashHost.Tests.csproj` → 110 passed, 0 failed (including 16 Identity API, 60 Phase 3, 30 Phase 7 orchestration/trigger, and 1 mobile-auth integration)
- Real MongoDB 7 run (2026-10-23) confirmed the full register → login → refresh → revoke flow and persisted camelCase documents
- Concurrent duplicate registrations returned exactly one `200` and one `409`; Mongo created the unique `ux_users_email` index
- Password hashes are PBKDF2-SHA256 with per-password salts; plaintext is never stored

**Revoke security fix (2026-10-29):** `/api/auth/revoke` now requires a valid JWT, resolves `userId` from claims, and filters device plus refresh-token updates by `(userId, deviceId)`. Automated tests cover unauthenticated revocation and a cross-user attempt where both users registered the same `deviceId`.

### 2.2 Deploy Identity API (BLOCKED — requires Azure deployment access)

**Verification Steps:**
- [x] Identity API responds to health check endpoint
- [ ] JWT signing key is loaded from Azure Key Vault (not hardcoded) — blocked: no Azure credentials
- [x] CORS policy allows configured origins — local origin covered by integration test
- [ ] CORS policy allows production mobile app origins — blocked: production origins not available
- [x] StashHost's `JwtValidationMiddleware.Validate()` returns `true` for tokens issued by Identity API
- [x] StashHost's `JwtValidationMiddleware.Validate()` returns `false` for tokens signed with different key

---

## Phase 3: StashHost Backend (Azure Functions)

> **2026-10-29 audit status:** Debug build succeeds with 0 errors/0 warnings; 109 StashHost tests pass (60 Phase 3, 30 Phase 7 mock orchestration/trigger). ImageSharp was replaced by Apache-2.0 Magick.NET Q8 14.17.2. The production converter decoded a real 718,114-byte HEIC fixture to a 1280×854 JPEG; AVIF/WebP conversion is unit-tested. A real 1,228,096-byte CC0 Blackmagic DNG fixture (1952×1104) converts to JPEG through both `RawImageConverter` and `ConvertFormatActivity`, and corrupt DNG input leaves no partial JPEG. MOV→MP4 transcoding is implemented with the FFmpeg CLI and covered by conversion, activity, decodability, and missing-FFmpeg tests. Mocked orchestration tests cover happy-path ordering, deduplication, failure responses, thumbnail failure, temp-delete retry, and local cleanup. Mocked Kafka-trigger tests cover JWT identity, payload/header mismatches, key validation, duplicate instances, DLQ producer failures, and batch continuation. Request validation, hash consistency, camelCase Kafka JSON, local temp cleanup, provider reuse/disposal, unique Mega root names, and user-scoped revoke are implemented and covered by tests. Host configuration and package restore pass. The Kafka trigger still uses the isolated-worker signature `[KafkaTrigger(brokerList, topic, ...)]` with `ConsumerGroup`, SASL_SSL, and SCRAM-SHA-256 settings. Live `func start`, Kafka, Mega.io, and end-to-end pipeline checks are blocked because Functions Core Tools/Azure CLI are not installed and Kafka/Mega credentials are empty. Video thumbnails remain incomplete.

### 3.1 Project Configuration

**Verification Steps:**
- [x] `host.json` contains `durableTask.maxConcurrentOrchestratorFunctions` = 10
- [x] `host.json` contains `durableTask.maxConcurrentActivityFunctions` = 10
- [ ] `func start` launches the function app locally without errors (blocked: `func` not installed; Kafka/Mega credentials empty)
- [x] All NuGet packages restore successfully (no NU1605 or NU1101 warnings)
- [x] Project SDK is `Azure.Functions.Sdk/1.0.0` and `Microsoft.Azure.Functions.Worker` is 2.52.0 (both meet the .NET 10 minimum)
- [x] `FUNCTIONS_WORKER_RUNTIME` is `dotnet-isolated` and the TFM is `net10.0`
- [x] `Microsoft.Azure.Functions.Worker.Extensions.DurableTask` is pinned to `1.20.0`
- [x] Root `global.json` pins SDK `10.0.402`
- [x] `StashHost.Functions` references Magick.NET-Q8-AnyCPU 14.17.2 and no longer references ImageSharp, MongoDB.Driver, or FFmpeg.AutoGen
- [x] FFmpeg CLI is available on the local PATH (9.0.1) and `VideoConverter` honors `STASH_FFMPEG_PATH`
- [ ] Hosted on Flex Consumption/Premium/Dedicated (classic Consumption does not support Kafka; .NET 10 on Linux Consumption is unsupported)

**Platform requirements:** Flex Consumption, Elastic Premium, or Dedicated only. Kafka bindings are not supported on classic Consumption. `KafkaRecord[]` compiles with extension 4.3.3, but the deployed extension bundle must support it; fallback is `KafkaEventData<string>[]`. ImageSharp was removed; Magick.NET is Apache-2.0. HEIC encoding is not supported by the bundled delegate and is not required because the pipeline only decodes HEIC to JPEG. MOV→MP4 requires an FFmpeg executable in the deployed image, or `STASH_FFMPEG_PATH` must point to one. `STASH_FFMPEG_VIDEO_CODEC` overrides the default `libx264`; the repo does not redistribute FFmpeg, and the operator must confirm the external build's license (common `libx264` builds are GPL).

### 3.2 Implement Kafka Trigger Function

**Verification Steps:**
- [ ] Valid JWT message on `stash.upload.request` starts `FileProcessingOrchestration` (code implemented with isolated-worker `KafkaRecord[]`; live broker blocked)
- [ ] Orchestration `instanceId` equals message `correlationId` (code implemented; live broker blocked)
- [ ] Message without `Authorization` header is sent to `stash.dlq` (code implemented with `x-dlq-reason`; live broker blocked)
- [ ] Message with invalid JWT is sent to `stash.dlq` (code implemented; live broker blocked)
- [ ] Duplicate message with same `correlationId` does not start duplicate orchestration (idempotency check implemented; live broker blocked)
- [ ] Kafka message key is set to `file_hash` (SHA-256 hash string) (trigger rejects missing/mismatched keys; live broker blocked)
- [x] `UploadRequestValidator` accepts a valid request and rejects invalid version, ids, fileId, file name, MIME, temp path, and file size (unit tests)
- [x] Outbound Kafka JSON uses camelCase; PascalCase input remains readable (unit test)

### 3.3 Implement Durable Functions Orchestration

**Verification Steps:**
- [ ] Orchestration completes all 8 steps for a new file: Download → Hash → Dedup → Convert → Thumbnail → Store → Delete → Response (live Mega/Kafka run blocked)
- [ ] When `CheckDeduplicationActivity` returns true, orchestration skips Convert/Thumbnail/Store and goes directly to SendResponse with `deduplicated=true` (code implemented; live blocked)
- [ ] All 3 thumbnail activities (128, 256, 512) run in parallel via `Task.WhenAll` (fan-out implemented; live blocked)
- [ ] If one thumbnail activity fails, orchestration continues with available thumbnails (non-fatal) (code implemented; live blocked)
- [ ] Failed step (e.g., DownloadFileActivity returns failure) triggers `HandleFailureAsync` and sends `status: "FAILED"` response (code implemented; live blocked)
- [ ] Orchestration `instanceId` equals `correlationId` from input message (code implemented; live blocked)
- [x] Computed SHA-256 is compared with the supplied `fileId`; a mismatch fails the orchestration and the computed hash becomes canonical (helper and mocked orchestration tests; live orchestration remains blocked)
- [x] Local `%TEMP%/stash/{guid}` is deleted in a `finally` cleanup activity (deletion + outside-root unit tests)
- [x] Downloaded-size validation accepts an exact byte count and rejects shorter/longer downloads with no temp file left (unit tests)

### 3.4 Implement Activity Functions

**Verification Steps:**
- [ ] `DownloadFileActivity` successfully downloads a 500 MB file from Mega.io temp path (live Mega blocked; whole-file memory buffering is a risk)
- [x] `DownloadFileActivity` rejects a byte count that differs from `FileSize` and leaves no temp file (shorter/longer unit tests; directory deletion is best-effort)
- [x] `ComputeHashActivity` produces correct SHA-256 hash (verify with known test file) — unit test with `"hello"`
- [x] `CheckDeduplicationActivity` returns `true` when the normalized `/backups/{userId}/{hash}{normalizedExtension}` (e.g., `.jpg` or `.mp4`) exists in Mega.io — unit test with fake provider
- [x] `CheckDeduplicationActivity` returns `false` when path does not exist — unit test with fake provider
- [ ] Deduplication path is physically checked in the Mega hierarchy (provider encodes root names; live Mega blocked)
- [x] `ConvertFormatActivity`/`ImageConverter` converts HEIC → JPEG successfully (real 718,114-byte HEIC fixture → 1280×854, 501,015-byte JPEG through production code)
- [x] `ImageConverter` converts AVIF → JPEG and WebP → JPEG (unit tests)
- [x] `ConvertFormatActivity`/`RawImageConverter` converts RAW → JPEG with a real fixture (CC0 Blackmagic DNG, 1,228,096 bytes, 1952×1104 → valid JPEG >10 KB; corrupt DNG leaves no JPEG)
- [x] `ConvertFormatActivity`/`VideoConverter` converts MOV → MP4 successfully (converter and activity tests; output decodes fully with FFmpeg)
- [ ] `ConvertFormatActivity` passes through JPEG/MP4 without conversion (JPEG pass-through unit test passes; MP4 not explicitly tested)
- [x] `GenerateThumbnailActivity` generates a 128×128 thumbnail and preserves a centered square's aspect ratio (unit test); video thumbnails are not supported
- [x] All three thumbnail sizes map to different deterministic physical names (`MegaPathMapper` unit test); live Mega persistence is still blocked
- [x] `StorePermanentActivity` builds `/backups/{userId}/{contentHash}{normalizedExtension}` — unit test verifies normalized path; live Mega blocked
- [ ] `DeleteTempFileActivity` deletes the temp file from Mega.io (retry + warning implemented; live Mega blocked)
- [x] `DeleteLocalTempActivity` deletes the per-file local temp directory and refuses outside-root paths (unit tests)
- [ ] `SendResponseActivity` publishes `UploadResponseMessage` to `stash.upload.response` with key = `fileId` (code implemented; live broker blocked)

### 3.5 Implement Dead Letter Handler

**Verification Steps:**
- [ ] Messages on `stash.dlq` are received and logged with FileId and reason (handler reads `x-dlq-reason`; live broker blocked)
- [ ] DLQ alert triggers when message count > 10 within alert window (critical log emitted for batches over threshold; Azure Monitor alert not configured)
- [ ] DLQ messages contain the original `file_hash` key when present, otherwise `FileId` as a fallback (producer preserves the original key; live broker blocked)

### 3.6 Implement Health Check

**Verification Steps:**
- [ ] `GET /api/health` returns HTTP 200 (code present; live `func start` blocked)
- [ ] Response body contains `{"status":"healthy","timestamp":"..."}` (code present; live `func start` blocked)
- The route is `/api/health` because Functions applies the default `api` route prefix; `/health` is not the host route.

### 3.7 Implement Converters

**Verification Steps:**
- [x] `ImageConverter.Supports(".heic")` returns `true` (unit test)
- [x] `ImageConverter.Supports(".heif")` returns `true` (unit test)
- [x] `ImageConverter.Supports(".avif")` returns `true` (unit test)
- [x] `ImageConverter.Supports(".webp")` returns `true`
- [x] `ImageConverter.Supports(".png")` returns `true`
- [x] `ImageConverter.Supports(".jpg")` returns `false`
- [x] `RawImageConverter.Supports(".raw")` returns `true`
- [x] `RawImageConverter.Supports(".cr2")` returns `true`
- [x] `RawImageConverter.Supports(".nef")` returns `true`
- [x] `RawImageConverter.Supports(".arw")` returns `true`
- [x] `RawImageConverter.Supports(".dng")` returns `true`
- [x] `VideoConverter.Supports(".mov")` returns `true`
- [x] `VideoConverter.Supports(".mp4")` returns `false`
- [x] Converted JPEG file is valid — PNG/WebP/AVIF unit tests and the real HEIC fixture all load the output
- [x] RAW→JPEG converts a real DNG fixture through `RawImageConverter` and `ConvertFormatActivity` (1,228,096-byte CC0 Blackmagic fixture, 1952×1104; valid JPEG >10 KB; invalid DNG fails without a partial JPEG)
- [x] Magick.NET reports read support for HEIC, AVIF, CR2, NEF, ARW, DNG, and RAW (unit test)
- [x] Converted MP4 file is valid/playable (FFmpeg full-decode check exits 0 in the unit test)
- [x] The `mpeg4` codec override produces a valid MP4 (unit test)

**Remaining Phase 3 gaps:** RAW→JPEG is validated with a real DNG; proprietary CR2/NEF/ARW files still rely on the same Magick.NET decoder but have not each been exercised with a fixture; video thumbnails are not implemented; MOV→MP4 needs FFmpeg installed in production (external binary, default `libx264` license must be reviewed); Mega uses encoded unique root names instead of real folders and existing bare roots need migration; whole-file Mega buffering remains a memory risk; orchestration/trigger now have mocked tests, but live Kafka/Mega/Azure verification remains blocked; no Durable retry/DLQ policy; no git repository.

---

## Phase 4: Mobile App (MAUI)

> **Status: Phases 4.1–4.7 code complete; Phase 4.8 next.** `Stash.Maui` loads embedded configuration, binds `StashConfig`, registers shared services, resolves the shell/pages through DI, implements authentication with SecureStorage-backed tokens, uses a standard SQLite/EF Core database through `Stash.Maui.Data`, implements folder discovery/SHA-256 scanning, streams files to temp storage with batch/status/retry tracking, produces/consumes upload messages through an injectable REST-proxy Kafka transport, and schedules background uploads with WorkManager/BGTaskScheduler/BackgroundTaskBuilder. Gallery, settings, and notifications remain unimplemented; physical background execution and live REST-proxy/Kafka verification are deferred.

### 4.1 Project Configuration (COMPLETE WITH MOBILE KAFKA CAVEAT)

**Verification Steps:**
- [x] `dotnet build Stash\Stash.Maui\Stash.Maui.csproj -f net10.0-android` succeeds (0 errors; 4 `XA0141` native page-size warnings)
- [x] `dotnet build Stash\Stash.Maui\Stash.Maui.csproj -f net10.0-ios` succeeds (Windows-host compile; no device/Mac runtime test)
- [x] `dotnet build Stash\Stash.Maui\Stash.Maui.csproj -f net10.0-maccatalyst` succeeds (Windows-host compile; no Mac runtime test)
- [x] `dotnet build Stash\Stash.Maui\Stash.Maui.csproj -f net10.0-windows10.0.19041.0` succeeds with 0 warnings
- [x] `StashConfig` loads all values from embedded `appsettings.json` (`Phase4MauiConfigurationTests`)
- [x] Configuration, HTTP client factory, storage factory, and shared storage provider are registered and resolvable (`Phase4MauiConfigurationTests`)
- [x] Windows MAUI assembly exposes embedded resource `Stash.Maui.appsettings.json`
- [x] Windows runtime smoke test: app stays running and does not crash during `App`/`AppShell`/`MainPage` construction
- [ ] Live mobile Kafka verification (blocked: `Confluent.Kafka`/`librdkafka.redist` 2.6.0 has no Android/iOS native runtime)

**Evidence (2026-10-29):**
- `dotnet test Stash\Stash.Maui.Tests\Stash.Maui.Tests.csproj --nologo` → 4 passed
- `dotnet test Stash\Stash.slnx --no-build --nologo` → 109 host + 4 MAUI passed
- `dotnet build Stash\Stash.slnx -v:q --nologo` → 0 errors, 1 Android `XA0141` warning (`Microsoft.JavaScript.LibNode`)
- Windows executable ran for 8 seconds without exiting; stopped manually after the smoke window
- Startup fix: `App` injects `IServiceProvider` and resolves `AppShell` in `CreateWindow`; resolving the shell from the `App` constructor built `MainPage` before `App.InitializeComponent()` loaded application resources, causing a WinUI `0xC000027B` crash on `StaticResource` lookup
- Android APK inspection found Linux `librdkafka`/`libnode` shared objects under `lib/arm64-v8a` and `lib/x86_64`; these are not supported mobile Kafka binaries
- JWT signing key is intentionally absent from mobile `appsettings.json`; signing remains server-side

### 4.2 Implement Authentication (COMPLETE)

**Verification Steps:**
- [x] Login screen accepts email, password, and deviceId inputs
- [x] `LoginAsync` calls Identity API `/api/auth/login` and stores tokens in SecureStorage
- [x] `RegisterAsync` calls Identity API `/api/auth/register` and stores tokens in SecureStorage
- [x] `GetAccessTokenAsync` returns token from SecureStorage
- [x] `EnsureValidAccessTokenAsync` returns an unexpired token or refreshes a missing/near-expiry token
- [x] `RefreshTokenAsync` calls Identity API `/api/auth/refresh` and updates SecureStorage
- [x] `LogoutAsync` removes tokens from SecureStorage
- [x] `RevokeDeviceAsync` calls Identity API `/api/auth/revoke` with the access token

**Evidence (2026-10-29):**
- `dotnet test Stash\Stash.Maui.Tests\Stash.Maui.Tests.csproj --nologo` → 17 passed
- `dotnet test Stash\StashHost.Tests\StashHost.Tests.csproj --nologo` → 110 passed, including an in-process mobile-client round trip through the real Identity API pipeline
- Windows, iOS, MacCatalyst, and Android builds completed with 0 warnings and 0 errors in the current build; the known Android `XA0141` warning remains tied to the unsupported mobile Kafka native runtime
- Windows UI Automation found `LoginEmailEntry`, `LoginPasswordEntry`, and `LoginDeviceIdEntry`; submitted valid-looking credentials and observed `Identity API base URL is not configured.`, proving the device ID was populated and the login command executed
- Windows UI Automation invoked “Create account” and confirmed the DI-created register page rendered its email, password, confirm-password, and device-ID fields
- Unit tests cover login/register request paths and bodies, token persistence, access-token retrieval, expiry-aware refresh (`EnsureValidAccessTokenAsync` with valid and expired tokens), refresh rotation, refresh-failure clearing, logout clearing, bearer-authenticated revoke, stable device ID, and the unconfigured-base-URL error
- The in-process integration test runs register → logout → login → refresh → revoke against the real Identity API pipeline with an in-memory user store; it also corrected a contract mismatch by confirming that success responses are raw `JwtToken` payloads rather than an `AuthResult` envelope
- `MauiSecureStorage` wraps `SecureStorage.Default`; the unit tests use an in-memory `ISecureStorageService` fake. Physical iOS/Android Keychain/Keystore behavior remains untested
- Logout removes access, refresh, expiry, and user keys but intentionally retains `stash.auth.device_id`
- Live deployed Identity API login/registration remains unverified because `IdentityApiBaseUrl` is empty in `appsettings.json`; the in-process test exercises the real API code path
- JWT signing remains server-side; no signing key is present in mobile configuration

### 4.3 Implement Local Database (COMPLETE)

**Verification Steps:**
- [x] Database file created at `FileSystem.AppDataDirectory/stash.db`
- [x] Database is standard SQLite (no encryption)
- [x] `Files` table has unique index on `ContentHash`
- [x] `Files` table has indexes on `Status`, `DeviceId`, `UserId`, `ContentHash`
- [x] `FolderConfigs` table has unique index on `FolderPath`
- [x] CRUD operations (Create, Read, Update, Delete) work for `FileEntity`
- [x] CRUD operations work for `FolderConfig`

**Evidence (2026-10-29):**
- `Stash.Maui.Data` (`net10.0`) contains `StashDbContext`, `FileEntity`, `FolderConfig`, `UploadStatus`, repositories, `StashDatabase.AddStashData`, and EF Core migration `20261029064802_InitialCreate`
- `MauiProgram` uses `Path.Combine(FileSystem.AppDataDirectory, StashDatabase.FileName)` and calls `InitializeStashDatabase()` at startup; tests pass an explicit temp path
- `dotnet test Stash\Stash.Maui.Tests\Stash.Maui.Tests.csproj` → 20 passed (5 configuration/DI, 10 authentication, 5 local database)
- Migration/schema test verifies both tables, `IX_Files_ContentHash` (unique), `IX_Files_Status`, `IX_Files_DeviceId`, `IX_Files_UserId`, and `IX_FolderConfigs_FolderPath` (unique)
- Repository tests cover create/read/update/delete, content-hash lookup, folder-path lookup, and DI registration; unique-constraint tests verify duplicate `ContentHash` and `FolderPath` inserts fail
- Windows runtime smoke created `C:\Users\himad\AppData\Local\User Name\com.companyname.stash.maui\Data\stash.db`; `sqlite3` read `Files`, `FolderConfigs`, all five indexes, WAL journal mode, and the `20261029064802_InitialCreate` migration row
- Windows, iOS, and MacCatalyst builds → 0 warnings, 0 errors; Android → 0 errors with 4 known `XA0141` warnings from unsupported mobile `librdkafka`/`libnode` native assets, unrelated to SQLite
- Physical iOS/Android database creation was not exercised; platform builds and plain .NET migration/CRUD tests cover the code path

### 4.4 Implement Folder Scanner (COMPLETE)

**Verification Steps:**
- [x] `ScanFolderAsync` discovers image/video files matching include patterns (*.jpg, *.jpeg, *.png, *.heic, *.raw, *.mov, *.mp4, *.avif, *.webp)
- [x] `ScanFolderAsync` excludes files matching exclude patterns
- [x] `ScanFolderAsync` includes subfolders when `IncludeSubfolders` = true
- [x] `ComputeFileHashAsync` produces correct SHA-256 hash for test file
- [x] `IsFolderAccessibleAsync` returns `true` for accessible folder, `false` for inaccessible

**Evidence (2026-10-29):**
- `Stash.Maui/Services/IFolderScannerService.cs` and `FolderScannerService.cs` added; registered as a singleton in `ServiceRegistration`
- Defaults in `Stash.Maui.Data/MediaFilePatterns.cs` cover the documented media patterns plus HEIF, DNG, CR2, NEF, and ARW; `FolderConfig` now uses the same defaults
- `ScanFolderAsync(FolderConfig)` honors include/exclude patterns and `IncludeSubfolders`; empty include patterns mean all files; matching is case-insensitive
- Enumeration skips hidden/system/reparse-point entries, ignores inaccessible subdirectories, and returns an empty list for missing/inaccessible roots
- `ComputeFileHashAsync` streams SHA-256 and returns lowercase hex; the known SHA-256 of `abc` is asserted exactly
- `IsFolderAccessibleAsync` returns false for empty, missing, and non-directory paths and probes enumeration for permission errors; an actual ACL-denied folder is not simulated in tests
- `dotnet test Stash\Stash.Maui.Tests\Stash.Maui.Tests.csproj` → 27 passed (5 configuration/DI, 10 authentication, 5 local database, 7 folder scanner)
- Windows, iOS, and MacCatalyst builds → 0 warnings, 0 errors; Android → 0 errors with 4 known `XA0141` warnings from unsupported mobile `librdkafka`/`libnode` native assets
- The scanner is not yet wired into the UI or upload flow

### 4.5 Implement Upload Manager (COMPLETE)

**Verification Steps:**
- [x] `UploadBatchAsync` processes files in batches of `UploadSettings:BatchSize` (default 10)
- [x] `UploadFileAsync` uploads to Mega.io temp path (`/temp/uploads/{deviceId}/{fileName}`)
- [x] Upload status tracked in local database (Pending → Uploading → Uploaded)
- [x] `IsUploadInProgressAsync` returns `true` during active upload, `false` when complete

**Evidence (2026-10-29):**
- `Stash.Maui/Services/IUploadManager.cs`, `UploadManager.cs`, and `UploadResults.cs` added; registered through `AddStashUploadServices()` after `AddStashData()`
- `UploadFileAsync(file, megaTempPath)` uses the supplied path; the overload builds `/temp/uploads/{deviceId}/{fileName}` and streams the file to `IStorageProvider.UploadFileAsync`
- Status transitions are persisted through `IFileRepository`: Pending → Uploading → Uploaded; failures persist `Failed`, `ErrorMessage`, `LastAttemptAt`, and increment `RetryCount`; cancellation resets to Pending best-effort
- `UploadBatchAsync` chunks by `UploadSettings:BatchSize` (default 10), runs each chunk with `Task.WhenAll`, and reports `BatchSize`, `BatchCount`, and total/success/failure counts
- `IsUploadInProgressAsync` uses an in-memory concurrent file-ID set and returns true while an upload is active
- Files larger than `UploadSettings:MaxFileSizeBytes` are rejected without contacting storage
- `dotnet test Stash\Stash.Maui.Tests\Stash.Maui.Tests.csproj` → 33 passed (5 configuration/DI, 10 authentication, 5 local database, 7 folder scanner, 6 upload manager)
- Tests use real SQLite persistence plus a hand-rolled fake `IStorageProvider`; no live Mega.io upload was performed
- Windows/iOS/MacCatalyst builds → 0 warnings, 0 errors; Android builds → 0 errors (full/APK builds can still emit the four known `XA0141` native page-size warnings)
- Windows runtime smoke still reaches the login page with the new DI registration; the upload manager is not yet wired to UI/Kafka

### 4.6 Implement Kafka Producer & Consumer (COMPLETE; LIVE KAFKA DEFERRED)

**Transport decision:** `Confluent.Kafka` has no supported Android/iOS native runtime and was removed from `Stash.Maui`. The mobile app now uses `IKafkaTransport` with a Confluent REST Proxy implementation: **v3 produce** for record headers and **v2 consume** for responses. `Kafka:RestUrl` is required; optional `RestUsername`/`RestPassword` and `ClusterId` are supported.

**Verification Steps:**
- [x] `ProduceUploadRequestAsync` produces message with key = `file_hash` (SHA-256)
- [x] Kafka headers include: `Authorization: Bearer <token>`, `X-Device-Id`, `X-User-Id`, `X-Correlation-Id`, `X-Message-Version: 1`
- [x] `ConsumeUploadResponsesAsync` subscribes to `stash.upload.response`
- [x] Consumer group is `stash-mobile-{deviceId}`
- [x] Response messages update local `FileEntity` status to `Completed` or `Failed`
- [x] Response messages update `PermanentPath`, `Thumbnails`, `ConvertedFormat`, `IsDeduplicated`

**Evidence (2026-10-29):**
- Added `IKafkaTransport`, `KafkaTransportModels`, `KafkaRestTransport`, `KafkaProducer`, `KafkaConsumer`, and `MobileKafkaJson`; registered via `AddStashKafkaServices()` after auth/data/upload
- `KafkaProducer` uses `UploadRequestMessage.FileId` as the key and sets the five required headers; missing user/device IDs fall back to `IAuthenticationService`
- `KafkaConsumer` uses group `stash-mobile-{deviceId}` and case-insensitive camelCase/PascalCase parsing; it updates `Completed`/`Failed`, `PermanentPath`, `Thumbnails`, `ConvertedFormat`, `IsDeduplicated`, `ErrorMessage`, and `LastAttemptAt`
- `KafkaRestTransport` maps produce to v3 `/v3/clusters/{clusterId}/topics/{topic}/records` with base64 key/header values and maps consume to v2 `/consumers/{group}` + `/subscription` + `/records`
- 8 Phase 4.6 tests: producer key/headers/camelCase serialization, missing-token rejection, completed/failed updates, PascalCase parsing, v3 produce request mapping, v2 consumer REST flow, and DI registration
- `dotnet test Stash\Stash.slnx --nologo` → **110 host tests + 52 MAUI tests pass**
- Windows/iOS/MacCatalyst builds → 0 warnings, 0 errors; Android builds → 0 errors with one remaining `XA0141` warning from `Microsoft.JavaScript.LibNode` (the librdkafka warning is gone)
- **Not verified live:** no REST proxy URL/credentials are configured; no real produce/consume, proxy authentication, or host response was exercised. `Kafka:RestUrl` remains empty in `appsettings.json`

### 4.7 Implement Background Upload (CODE COMPLETE; DEVICE VERIFICATION PENDING)

**Verification Steps:**
- [x] `IBackgroundUploadService.RunOnceAsync` scans, uploads, and queues files
- [x] Android: `ScheduleAsync` creates a WorkManager `PeriodicWorkRequest`
- [x] iOS: `ScheduleAsync` registers and submits a `BGProcessingTask`
- [ ] Windows: `ScheduleAsync` registers a `BackgroundTaskBuilder` (code exists; unpackaged app cannot register)
- [x] `CancelAsync` cancels Android unique work, iOS BG task, and Windows registration
- [ ] Background upload starts on Android
- [ ] Background upload starts on iOS
- [ ] Upload continues when app is backgrounded

**Evidence (2026-10-29):**
- Added `IBackgroundUploadService`/`BackgroundUploadService`, `BackgroundUploadResult`, `IBackgroundUploadScheduler`, and `NoOpBackgroundUploadScheduler`; registered with `AddStashBackgroundUploadServices()` and invoked from `MauiProgram`
- `RunOnceAsync` ensures a usable access token (refreshing a missing or near-expiry token), scans enabled folders, hashes and inserts new files, uploads Pending/Retrying/Uploaded/retryable-Failed candidates, publishes Kafka requests, and sets `Processing`; Kafka failures persist `Failed`; cancellation between upload and publish resets to `Retrying`
- Single-flight `SemaphoreSlim(1,1)` returns `AlreadyRunning`; `BackgroundUpload:MaxFilesPerRun` defaults to 50
- Android uses `Xamarin.AndroidX.Work.Runtime` 2.10.5, `PeriodicWorkRequest` (network-connected, unique name `stash-background-upload`, `ExistingPeriodicWorkPolicy.Keep`), and `BackgroundUploadWorker`; minimum Android SDK raised to API 23
- iOS uses `BGTaskScheduler` with identifier `com.companyname.stash.maui.upload`; `Info.plist` adds `UIBackgroundModes=processing` and `BGTaskSchedulerPermittedIdentifiers`
- Windows uses `BackgroundTaskBuilder` with a 15-minute `TimeTrigger` and `InternetAvailable` condition; `Package.appxmanifest` declares the timer background-task extension and `internetClient` capability. Registration failure is logged because `WindowsPackageType=None`
- Mac Catalyst/unknown targets use `NoOpBackgroundUploadScheduler`
- Added 9 Phase 4.7 tests: discovery/upload/queue, known-content skip, missing-auth failure, concurrent-run guard, Kafka failure, cancellation between upload and publish, previously uploaded recovery, max-files limit, and DI registration
- `dotnet test Stash\Stash.slnx --nologo` → **110 host tests + 52 MAUI tests pass**
- Windows, iOS, MacCatalyst, and Android builds → 0 errors. All MAUI target builds emit `NU1608` WorkManager/Lifecycle dependency-range warnings; Android additionally emits the existing `libnode` `XA0141` warning on full/APK builds
- **Not verified:** no physical Android/iOS device was available to observe WorkManager or `BGProcessingTask` wake-up and upload continuation. The Windows task cannot register without package identity. A live end-to-end run still requires `Kafka:RestUrl` and credentials.

### 4.8 Implement UI Layer

**Verification Steps:**
- [ ] `GalleryPage` displays backed-up files in thumbnail grid
- [ ] `SettingsPage` shows backup status and configuration
- [ ] `FolderConfigPage` allows adding/removing backup folders
- [ ] `NotificationCenterPage` shows upload progress and errors
- [ ] `LoginPage` and `RegisterPage` accessible from app startup

---

## Phase 5: Infrastructure (Terraform — owner-managed, deferred)

> **Status: not implemented.** There is no `terraform/` directory. IaC is intentionally out of scope for this documentation pass and is owned by the project owner. The original classic Consumption plan is **invalid**: Kafka bindings require Flex Consumption/Elastic Premium/Dedicated, and .NET 10 is unsupported on Linux Consumption. The Identity API is an ASP.NET Core app, not a Function App.

### 5.1 Terraform Modules

**Verification Steps:**
- [ ] `terraform init` succeeds from root `terraform/` directory (no directory exists)
- [ ] `terraform validate` passes for all modules with no errors
- [ ] `modules/function_app_flex/` creates a **Flex Consumption** Function App compatible with the Kafka trigger (classic Consumption is invalid)
- [ ] `modules/key_vault/` creates Key Vault with soft delete enabled
- [ ] `modules/app_insights/` has `workspace_resource_id` pointing to Log Analytics workspace
- [ ] `modules/kafka_topic/` is a placeholder (topics created manually via Aiven Console/CLI)

### 5.2 Environments

**Verification Steps:**
- [ ] `terraform plan -var-file=environments/dev/terraform.tfvars` shows correct resource count
- [ ] `terraform plan -var-file=environments/staging/terraform.tfvars` shows correct resource count
- [ ] `terraform plan -var-file=environments/prod/terraform.tfvars` shows correct resource count
- [ ] Dev environment uses shared dev Kafka cluster
- [ ] Staging/Prod environments use dedicated Kafka clusters
- [ ] Kafka topics created manually via Aiven Console/CLI (not Terraform):
  - `stash.upload.request` (partitions/retention are Aiven operational settings, not managed here)
  - `stash.upload.response` (partitions/retention are Aiven operational settings)
  - `stash.status.events` (**not implemented/used by the host**; target only)
  - `stash.dlq` (partitions/retention are Aiven operational settings)

> Partition counts and retention in the original list were targets, not repository settings. Do not claim they are enforced.

### 5.3 Key Vault Secrets

> **Status: not implemented.** Key Vault packages are referenced but no Key Vault client or managed-identity wiring exists. These steps are targets.

**Verification Steps:**
- [ ] `MegaEmail` secret stored in Key Vault
- [ ] `MegaPassword` secret stored in Key Vault
- [ ] `KafkaUsername` secret stored in Key Vault
- [ ] `KafkaPassword` secret stored in Key Vault
- [ ] `JwtSigningKey` secret stored in Key Vault
- [ ] `MongoDB:ConnectionString` secret stored in Key Vault
- [ ] Function App Managed Identity has `Get` and `List` permissions on Key Vault secrets

---

## Phase 6: CI/CD Pipeline

> **Status: not implemented.** There is no `.github/` directory. These are target checks.

### 6.1 GitHub Actions Workflow

**Verification Steps:**
- [ ] Pipeline triggers on push to `main` and `develop` branches
- [ ] `build-mobile` job succeeds on `windows-latest` with .NET 10
- [ ] `build-host` job succeeds on `windows-latest` with .NET 10
- [ ] `build-identity` job succeeds on `ubuntu-latest` with .NET 10
- [ ] `terraform-plan` job succeeds on `ubuntu-latest`
- [ ] `deploy` job runs only on `refs/heads/main`
- [ ] Deployment to dev environment succeeds
- [ ] Function app deployed with correct name (`stashhost-func-dev`)

---

## Phase 7: Testing & Verification

### 7.1 Unit Tests

**Current automated result (2026-10-29):** `StashHost.Tests` **110 passed** (including 16 Identity API, 60 Phase 3, 30 Phase 7 orchestration/trigger, and 1 mobile-auth integration); `Stash.Maui.Tests` **52 passed** (5 Phase 4.1 configuration/DI, 12 Phase 4.2 authentication, 5 Phase 4.3 local database, 7 Phase 4.4 folder scanner, 6 Phase 4.5 upload manager, 8 Phase 4.6 Kafka, 9 Phase 4.7 background upload).

**Verification Steps:**
- [ ] `MegaStorageProvider` unit tests mock `MegaStorageClient` and pass (no such tests exist)
- [ ] `KafkaProducer` unit tests mock `IProducer<string, string>` and pass (no such tests exist)
- [x] `FileProcessingOrchestration` unit tests mock activities and pass (happy path, dedup, failure branches, thumbnails, temp-delete retry, local cleanup)
- [x] `KafkaTriggerFunction` unit tests mock Kafka records, JWT validation, Durable client, and DLQ producer (JWT identity, key/header validation, duplicates, DLQ failure, batch continuation)
- [x] `ImageConverter` tests pass for AVIF, WebP, and PNG conversions; a real HEIC fixture passes through the production converter (manual runtime validation)
- [x] `RawImageConverter` real-file test passes (CC0 DNG; direct converter + activity integration + corrupt-input cleanup)
- [x] `VideoConverter` unit tests pass for MOV → MP4 conversion, activity integration, decodability, and missing-FFmpeg failure
- [x] `JwtValidator`/`JwtValidationMiddleware` tests pass for valid/invalid tokens
- [x] Identity API register/login/refresh/revoke endpoint tests pass (16 tests; in-memory store), including unauthenticated and cross-user revoke
- [x] Request/hash validation, Kafka JSON casing, local cleanup, provider reuse, and Mega path mapping tests pass
- [ ] Real-Mongo Identity tests are part of the automated suite (manual verification only)
- [ ] Mobile test coverage ≥ 80% (template placeholder only)
- [ ] Host test coverage ≥ 85% (no coverage threshold enforced)
- [ ] Shared test coverage ≥ 90% (no coverage threshold enforced)

### 7.2 Integration Tests

> **Status: blocked/not implemented.** No live integration test can run: `func`/`az` are not installed, Kafka/Mega credentials are empty, and the mobile producer/consumer is absent. The retry test below cannot pass because no Durable retry policy is configured.

**Verification Steps:**
- [ ] End-to-end upload completes: Mobile produces request → Kafka → Host processes → Mega.io stores → Response on Kafka → Mobile receives (mobile side absent; live host blocked)
- [ ] End-to-end upload for 15 MB file completes in < 5 minutes (not measured)
- [ ] Deduplication: Second upload of same file (same SHA-256 hash) returns `deduplicated=true`, skips conversion/storage (unit path covered; live Kafka/Mega blocked)
- [ ] Retry on failure: Simulating Mega.io outage triggers retry with exponential backoff, then DLQ after max retries (**no retry policy exists**; activity failures produce a FAILED response, not a DLQ entry)
- [ ] Orchestration state recovery: Function restart mid-orchestration resumes from last checkpoint (Durable runtime behavior; not tested)
- [ ] JWT validation: Invalid token in Kafka header causes message to be sent to DLQ (code implemented; live broker blocked)
- [ ] DLQ: Invalid auth/key/parse failures appear in `stash.dlq` with the original key when present (or `FileId` fallback); activity failures return a FAILED response (no retry/DLQ path)

---

## Phase 8: Monitoring & Observability

> **Status: not implemented.** Application Insights is referenced as a package but not initialized; no custom events, alerts, action groups, or dashboards exist. All steps below are targets.

### 8.1 App Insights Configuration

**Verification Steps:**
- [ ] Custom event `FileUploadStarted` logged with properties: FileId, UserId, DeviceId, FileSize
- [ ] Custom event `FileProcessingCompleted` logged with properties: FileId, ProcessingTimeMs, Deduplicated
- [ ] Custom event `FileProcessingFailed` logged with properties: FileId, Error, RetryCount
- [ ] Custom event `OrchestrationStarted` logged with properties: InstanceId, CorrelationId
- [ ] Custom event `OrchestrationCompleted` logged with properties: InstanceId, DurationMs
- [ ] Custom event `KafkaMessageConsumed` logged with properties: Topic, Offset, Partition
- [ ] Custom event `MegaIoApiCall` logged with properties: Endpoint, DurationMs, StatusCode
- [ ] App Insights linked to Log Analytics workspace (logs flow to workspace)

### 8.2 Alerts

**Verification Steps:**
- [ ] Alert: Orchestration duration > 60 min (avg over 5 min) → Severity P1 → Pages on-call
- [ ] Alert: Failed orchestrations > 5% (error rate over 5 min) → Severity P2 → Creates ticket
- [ ] Alert: Kafka consumer lag > 1000 messages → Severity P2 → Creates ticket
- [ ] Alert: DLQ message count > 10 → Severity P1 → Pages on-call
- [ ] Alert: Mega.io API error rate > 1% (over 5 min) → Severity P2 → Creates ticket
- [ ] Alert: Identity API latency > 2s p99 (over 5 min) → Severity P2 → Creates ticket

---

## Cross-Cutting Verification Checklist

Statuses: **Implemented** = code exists and is covered by at least a unit/integration test; **Partial** = code/config exists but a required part is absent or unverified; **Unverified** = compiles but runtime behavior is untested; **Design only** = no implementation; **Manual** = an operational step, not repository code; **Needs fix** = a reproducibility or quality issue; **Risk** = a known operational hazard; **Bug/Blocker** = a known defect or release blocker; **Invalid** = the original claim is wrong and must not be used.

| # | Verification Item | Status | Evidence / note |
|---|-------------------|--------|-----------------|
| 1 | Deduplication: SHA-256 content hash | Implemented | `ComputeHashActivity`, normalized `StoragePathBuilder`; unit tests |
| 2 | Kafka message key: `file_hash` | Partial | Trigger rejects missing/mismatched key; request validator enforces 64-hex; no live broker test |
| 3 | Identity API: Minimal API | Implemented | 16 endpoint/auth tests; real Mongo manual check |
| 4 | JWT in Kafka headers: producer adds Authorization | Partial | Host validates; mobile producer does not exist |
| 5 | MegaStorageProvider: single options-based implementation | Partial | Cached/disposed and race-safe init; whole-file buffering and live Mega unverified |
| 6 | Terraform: true Consumption plan | **Invalid** | Kafka requires Flex/Premium/Dedicated; .NET 10 Linux Consumption unsupported |
| 7 | Orchestration instanceId = correlationId | Partial | Trigger `GetInstanceAsync` + `StartOrchestrationOptions`; no live broker test |
| 8 | Dead Letter Handler | Partial | Consume/log only; no persistence, replay UI, or Azure Monitor alert |
| 9 | HEIC/AVIF/WebP→JPEG | Implemented | Magick.NET; real HEIC fixture through production converter; AVIF/WebP tests |
| 10 | RAW→JPEG | Implemented | Real CC0 DNG fixture through `RawImageConverter` and `ConvertFormatActivity`; corrupt-input cleanup test |
| 11 | MOV→MP4 | Implemented | FFmpeg CLI; conversion/activity/decode tests; production FFmpeg dependency |
| 12 | Video thumbnails | **Not implemented** | Image-only thumbnail path |
| 13 | Request validation | Implemented | `UploadRequestValidator` + tests |
| 14 | Local temp cleanup | Implemented | `DeleteLocalTempActivity` + tests |
| 15 | Environments: Dev, Staging, Prod | Design only | No Terraform or deployed environments |
| 16 | Kafka topic partitions | Not managed in repo | Manual Aiven settings; not enforced by code |
| 17 | host.json Durable concurrency | Partial | Values present; host not started |
| 18 | Mobile Kafka consumer with per-device group | **Not implemented** | Phase 4.6; mobile transport decision required first |
| 19 | MAUI configuration: `StashConfig` | Implemented | Embedded `appsettings.json`; nested binding; 4 configuration/DI tests |
| 20 | SecureStorage | Implemented | MAUI SecureStorage adapter; token lifecycle tested with in-memory storage; logout retains stable device ID |
| 21 | App Insights + Log Analytics linked in Terraform | **Not implemented** | Package reference only; no telemetry wiring |
| 22 | Mega.io paths: hash-based for dedup | Partial | Unique root names encoded; no real folders; old bare roots need migration |
| 23 | Thumbnail physical names | Partial | Unique 128/256/512 names verified by unit test; live Mega unverified |
| 24 | Local DB: SQLite without encryption | Design only | No mobile database exists |
| 25 | Message versioning: v1 field | Implemented | Validator rejects non-v1; no forward-compatibility policy |
| 26 | Health checks: `/health` | Partial | Host route is `/api/health`; Identity `/health`; live host unverified |
| 27 | Device re-registration/revoke | Implemented | JWT required; `(userId, deviceId)` scoped; auth/cross-user tests |
| 28 | .NET 10 hosting | **Blocker** for deployment | Must use Flex/Premium/Dedicated; classic Consumption invalid |
| 29 | Kafka `KafkaRecord[]` at runtime | Unverified | Compiles with 4.3.3; deployed bundle support not proven |
| 30 | Durable package reproducibility | **Resolved** | Pinned 1.20.0; `global.json` pins SDK 10.0.402 |
| 31 | ImageSharp license | **Resolved** | Removed; Magick.NET-Q8-AnyCPU 14.17.2 (Apache-2.0) |
| 32 | Kafka/JSON casing interop | **Resolved** | `KafkaJson` camelCase outbound + case-insensitive inbound; test |
| 33 | Hash consistency | **Resolved** | Computed SHA-256 compared to supplied fileId and canonicalized; helper tests |
| 34 | Mega memory/lifetime | **Partial/Risk** | Provider lifetime fixed; whole-file buffering remains |
| 35 | Git/CI/CD | **Not implemented** | No git repository; no `.github/` workflows |
| 36 | FFmpeg runtime for MOV→MP4 | Deployment requirement | FFmpeg 9.0.1 verified locally; install externally and set `STASH_FFMPEG_PATH`; review the encoder license |

---

## .NET 10 Conformance Verification

Run these checks from the repository root. The observed results below are from 2026-10-29 (Debug build).

| Check | Command / evidence | Observed | Requirement |
|-------|-------------------|----------|-------------|
| SDK | `dotnet --version` | `10.0.402` | .NET 10 SDK |
| Host TFM | `StashHost.Functions.csproj` | `net10.0` | `net10.0` |
| Shared/Identity TFM | `.csproj` files | `net10.0` | `net10.0` |
| MAUI TFMs | `Stash.Maui.csproj` | `net10.0-android`, `net10.0-ios`, `net10.0-maccatalyst`, `net10.0-windows10.0.19041.0` | .NET 10 MAUI |
| Functions project SDK | `<Project Sdk="...">` | `Azure.Functions.Sdk/1.0.0` | ≥ 1.0.0 |
| Isolated worker | Package reference | `Microsoft.Azure.Functions.Worker` 2.52.0 | ≥ 2.50.0 |
| Worker runtime | `local.settings.json` / app settings | `dotnet-isolated` | `dotnet-isolated` |
| Solution build | `dotnet build Stash/Stash.slnx -v:q --nologo` | 0 errors; 1 Android `XA0141` warning (Debug) | 0 errors |
| Tests | `dotnet test Stash/Stash.slnx --no-build --nologo` | 110 + 52 passed | All pass |
| SDK pin | `global.json` | 10.0.402 | Reproducible pin |
| Durable pin | `StashHost.Functions.csproj` | 1.20.0 | Reproducible pin |
| Support lifecycle | Microsoft .NET support policy | .NET 10 is LTS, supported until 2028-11-14 | Supported |

### Conformance findings

- **Compliant:** all project TFMs, worker version, Functions SDK version, isolated-worker setting, nullable/implicit usings, and MAUI .NET 10 TFMs.
- **Deployment blocker:** the host must run on **Flex Consumption**, Elastic Premium, or Dedicated. Kafka bindings are not supported on classic Consumption, and .NET 10 is unsupported on Linux Consumption.
- **Reproducibility:** DurableTask is pinned to `1.20.0` and `global.json` pins SDK `10.0.402`. Central package management is still not adopted.
- **Runtime risk:** `KafkaRecord[]` compiles with Kafka extension 4.3.3, but the deployed extension bundle must support it. Verify on the host; the fallback is `KafkaEventData<string>[]`.
- **License:** ImageSharp was removed. Magick.NET-Q8-AnyCPU 14.17.2 is Apache-2.0; retain its license notice.
- **Stale project:** resolved — `FunctionApp1/` no longer exists on disk.
- **Solution membership:** resolved — `MegaConnectivity.Core` is now listed in `Stash.slnx`.
- **Optional C# 14/.NET 10 improvements (not conformance requirements):** `TimeProvider`, `Guid.CreateVersion7()` outside orchestrations, `TypedResults`/OpenAPI/`ProblemDetails` in the Identity API, `System.Threading.Lock`, and source-generated `System.Text.Json` contracts.

---

## Known Blockers & Gaps

| Area | Impact | Required action |
|------|--------|-----------------|
| MOV→MP4 | Implemented locally; production needs FFmpeg | Install FFmpeg in the Flex Consumption image or set `STASH_FFMPEG_PATH`; verify in the deployed host |
| Video thumbnails | No video thumbnail generation | Add FFmpeg frame extraction or mark unsupported in the response |
| RAW real-file conversion | DNG path validated with a CC0 fixture; proprietary CR2/NEF/ARW are not separately exercised | Keep the DNG regression test; add owned proprietary fixtures only if decoder-specific behavior needs coverage |
| Mega physical hierarchy | Unique root names prevent collisions, but `/temp`, `/backups`, `/thumbs` are not real folders | Add folder create/lookup or keep encoded names and document migration |
| Mega name migration | Existing bare root files are no longer addressable by the new mapper | Re-upload or physically rename existing files |
| Mega memory | Whole-file buffering; 500 MB jobs are memory-heavy | Stream/chunk upload/download |
| Orchestration/trigger tests | Mocked orchestration and Kafka-trigger tests now cover the main branches; no live Durable/Kafka execution | Add live integration tests when Kafka/Azure credentials and Functions tooling are available |
| Mobile Kafka transport | `Confluent.Kafka`/`librdkafka.redist` 2.6.0 has no supported Android/iOS native runtime; Android packages Linux `.so` files | Before Phase 4.6, choose a REST/proxy or managed Kafka transport; do not rely on `Confluent.Kafka` on-device |
| Mobile secret handling | Kafka/Mega credentials in `appsettings.json` are placeholders and would be extractable if populated | Provision per-device credentials or a broker/API proxy; never commit real client secrets |
| Downloaded-size test | Resolved | Exact-size, shorter, and longer `DownloadFileActivity` tests pass |
| Durable retry/DLQ | No retry policy; activity failures return FAILED, not DLQ | Add retry/backoff and a DLQ policy if required |
| KafkaRecord runtime | Bundle support unverified | Verify on Flex host; fallback to `KafkaEventData<string>[]` |
| Live verification | No `func`/`az`, empty Kafka/Mega credentials | Install tools, provide test credentials, run E2E |
| IaC/CI/monitoring | Not present | Owner handles IaC; add workflows/alerts separately |
| Git history | Repository is not a git repo | Initialize/commit before further changes |

---

## Pre-Implementation: Design Gaps and Their Status

The original design questions have answers, but several are design decisions rather than working code:

| # | Gap | Decision / status |
|---|-----|-------------------|
| 1 | MegaConnectivity.Core package | Implemented via Microsoft.JavaScript.NodeApi + libnode; root-path/memory limitations remain |
| 2 | SQLCipher key derivation | Not required — SQLite without encryption; mobile DB is design-only |
| 3 | Identity API user store | MongoDB (`users`, `devices`, `refresh_tokens`); real-Mongo flow manually verified |
| 4 | Local Kafka setup | Not required — Aiven dev cluster used directly; live host verification blocked |
| 5 | Aiven Terraform provider | Not implemented — topics manual; IaC owner-managed and not in the repo |

---

## End of Verification Steps

*Mark each checkbox as tasks are completed. A phase is complete only when all its verification steps pass. Unchecked items and statuses are deliberate: they record what has not been verified, not what is expected to work.*