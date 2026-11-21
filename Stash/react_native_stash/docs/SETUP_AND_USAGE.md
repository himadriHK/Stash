# Stash (React Native) — Setup & Usage Guide

A complete guide to installing, configuring and operating the React Native
(Expo) recreation of **Stash.Maui**. The app keeps the MAUI look — exact
palette, OpenSans typography, form/button styling, light + dark appearance —
and reimplements the documented feature set: Identity API authentication,
SQLite storage with SHA-256 deduplication, folder scanning, direct S3 upload
through presigned AWS Signature V4 URLs, Kafka REST messaging and the
15-minute background upload pass.

> To run the app against the real backend (Identity API, Functions host, MongoDB,
> Aiven Kafka and the backend's storage provider) on one machine, use the
> repository-wide runbook:
> **[../../docs/LOCAL_FULL_STACK_SETUP.md](../../docs/LOCAL_FULL_STACK_SETUP.md)**.
> This document stays client-only: it explains the app itself and its contracts.
>
> **Compatibility note:** the client now uploads to S3 and publishes upload
> requests as version 2. The backend in this repository still uses MEGA and a
> version-1 validator, so the runbook above cannot complete the upload flow
> end-to-end until the host supports S3 and accepts version 2. See §11.

> **Architecture & data flow:** see **[ARCHITECTURE.md](ARCHITECTURE.md)** for the runtime shell, SQLite schema, scanner and upload pipeline, background pass, S3 internals, Kafka contract and platform matrix.

> **Implementation plan:** see **[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)** for the reliability, performance and observability roadmap and tracker.

---

## 1. What is in the project

```
react_native_stash/
  App.tsx                 providers (Theme, Auth, Toast) + background wiring
  index.ts                Expo entry point
  app.json                Expo app config (name "Stash", automatic light/dark)
  metro.config.js         web support for expo-sqlite (wasm + COOP/COEP)
  src/
    auth/                 Identity API client + AuthContext (session restore)
    components/           AppButton, FormInput, dialogs, cards, toasts
    config/               appconfig.json + typed StashConfig helpers
    data/                 SQLite schema, file + folder repositories
    models/               entities, Kafka message contracts, upload status
    navigation/           auth-gated stack + 5-tab main shell
    screens/              Login, Register, Files, Upload, Folders, Settings, About
    services/             scanner, storage provider interface + factory, S3
                          service, pure-JS SigV4 presigner, presigned transfer
                          adapter, upload manager, Kafka REST producer/consumer,
                          background pass + scheduler, singletons
      storage/            storageProvider.ts, storageProviderFactory.ts,
                          s3StorageService.ts, s3Signing.ts, s3Transfer.ts
    theme/                colors, typography, ThemeContext
    utils/                secure storage, base64, formatting, ids, file access
```

Related documents at the repository root: `ReactNativeStashPlan.md` (the
plan/spec this implementation follows), `FlutterStash*.md` (the original UI and
feature documentation), and `Stash.Maui/` (the .NET reference app).

---

## 2. Requirements

| Requirement | Notes |
| --- | --- |
| **Node.js 20 LTS or newer** | Metro and Expo SDK 58 expect a modern Node. |
| **npm** (bundled with Node) | `package-lock.json` is the source of truth; do not swap package managers. |
| **Windows / macOS / Linux** | The project is developed on Windows; web works everywhere. |
| **Expo Go** (phone) | Easiest way to run on a real device. Install from the App Store / Play Store. |
| **Android Studio + SDK** (optional) | Only for emulators or native builds. |
| **Xcode** (optional, macOS only) | Only for iOS simulators or native builds. |

The app runs in **Expo Go** as-is: `expo-sqlite`, `expo-secure-store`,
`expo-document-picker`, `expo-file-system`, `expo-crypto` and `expo-font` are
all supported by Expo Go. The S3 client adds no native module — SigV4 signing
uses the pure-JS `js-sha256` package and transfers use Expo FileSystem — so
there is **no SDK build step and no custom development build** required.

Backend services (Identity API, S3 bucket, Kafka REST proxy) are **optional**.
Without them the UI, navigation, theming, local database and scanning all work;
network-dependent actions surface an explanatory error instead.

---

## 3. Installation

Install dependencies in the app only:

```bash
cd react_native_stash
npm install
```

There is no sibling package to build and no `file:` dependency: the S3 storage
implementation is part of `src/services/storage/`.

Clean install if dependencies ever look broken:

```bash
cd react_native_stash
rm -rf node_modules .expo
npm install
```

No global Expo CLI installation is needed — `npx expo` resolves the SDK-local
CLI.

---

## 4. Configuration

Configuration is split in two:

- **`src/config/appconfig.json`** holds non-secret defaults (topics, timeouts,
  batch sizes, proxy tuning), mirroring the MAUI app's `appsettings.json`.
- **`.env`** (git-ignored) holds secrets and machine-specific endpoints as
  `EXPO_PUBLIC_*` variables. Copy `.env.example` to `.env` and fill in real
  values.

Both are compiled into the bundle (`src/config/appConfig.ts` imports the JSON
and overlays the `EXPO_PUBLIC_*` values), so **restart the dev server after
editing either file** — changes are not hot-reloaded.

### 4.1 Identity (authentication)

| Key | Default | Meaning |
| --- | --- | --- |
| `IdentityApiBaseUrl` | `EXPO_PUBLIC_IDENTITY_API_BASE_URL` | Identity API origin: the Vercel function (`https://<vercel-project>.vercel.app`) or the local .NET service (`http://localhost:5102`). **Empty means the app cannot sign in** and shows “Identity API base URL is not configured.” |
| `IdentityApiTimeoutSeconds` | `30` | Timeout for auth requests (register/login/refresh). |
| `Auth.Jwt.Issuer` | `"stash-auth"` | Expected token issuer (informational / validation parity). |
| `Auth.Jwt.Audience` | `"stash-app"` | Expected token audience. |

Set `EXPO_PUBLIC_IDENTITY_API_BASE_URL` to `https://<vercel-project>.vercel.app` (deployed Vercel function) or `http://localhost:5102` (local .NET API); no trailing slash is required. The Vercel function serves `POST /api/auth/register|login|refresh|revoke` and `GET /api/auth/health`; the health route is the liveness check.

### 4.2 Upload settings

| Key | Default | Meaning |
| --- | --- | --- |
| `UploadSettings.BatchSize` | `10` | Maximum files per upload batch (also bounded by `MaxConcurrentBytes`). |
| `UploadSettings.MaxRetries` | `3` | Retry attempts before a file is marked `Failed` and dead-lettered. |
| `UploadSettings.MaxFileSizeBytes` | `524288000` | 500 MB per-file limit. Larger files are flagged instead of uploaded. |
| `UploadSettings.MaxConcurrentBytes` | `268435456` | 256 MB declared-bytes budget per upload batch (`0` or less = unlimited). A single larger file runs alone. |

### 4.3 Background upload pass

| Key | Default | Meaning |
| --- | --- | --- |
| `BackgroundUpload.Enabled` | `true` | Turns the periodic pass on/off. |
| `BackgroundUpload.IntervalMinutes` | `15` | Pass interval, matching the documented 15-minute cadence. |
| `BackgroundUpload.MaxFilesPerRun` | `50` | Cap of files handled per run (`0` or less = unlimited). |

### 4.4 Storage (S3)

| Key | Default | Meaning |
| --- | --- | --- |
| `Storage.Provider` | `"S3"` | Storage provider. `S3` is the only supported value (case-insensitive); anything else fails with “Unsupported storage provider”. |
| `Storage.S3.Bucket` | `EXPO_PUBLIC_S3_BUCKET` | Target bucket. Empty makes uploads fail with “Amazon S3 is not configured…”. |
| `Storage.S3.Region` | `us-east-1` | Region used in the SigV4 credential scope and the default AWS endpoint. |
| `Storage.S3.AccessKeyId` | `EXPO_PUBLIC_S3_ACCESS_KEY_ID` | Access key used to sign presigned URLs. |
| `Storage.S3.SecretAccessKey` | `EXPO_PUBLIC_S3_SECRET_ACCESS_KEY` | Secret key used to sign presigned URLs. |
| `Storage.S3.SessionToken` | empty | Optional STS/role session token. When set it is added to the URL as `X-Amz-Security-Token`. |
| `Storage.S3.Endpoint` | empty (AWS) | Custom S3-compatible endpoint, e.g. `https://minio.example.com` or a Cloudflare R2 endpoint. Must start with `http://` or `https://`. |
| `Storage.S3.ForcePathStyle` | `false` | Use path-style addressing (`https://host/bucket/key`). Required by MinIO and many S3-compatible servers. |
| `Storage.S3.Prefix` | empty | Optional key prefix (leading/trailing slashes are stripped), e.g. `stash`. |
| `Storage.S3.PresignExpirySeconds` | `3600` | Presigned URL lifetime, clamped to 1–604800 seconds. |

The app never logs into a storage account or calls a host upload endpoint. It
generates a presigned URL on the device and transfers directly to S3:

- **AWS:** leave `Endpoint` empty. Virtual-hosted addressing is used
  (`https://{bucket}.s3.{region}.amazonaws.com/{key}`), and `ForcePathStyle`
  stays `false`.
- **MinIO / custom S3-compatible servers:** set `Endpoint` (for example
  `http://localhost:9000`) and `ForcePathStyle = true`. Use the region the
  server expects (MinIO commonly accepts `us-east-1`).
- **Cloudflare R2 and similar:** set the provider's S3 endpoint and the region
  it documents; enable path-style only if the provider requires it.
- **Temporary credentials (STS / IAM role):** set `SessionToken` together with
  the matching access key and secret. All three values rotate together; an
  expired token makes requests fail with `403`.
- **Prefix:** the bucket key is the optional prefix plus the logical path
  without its leading slash. With `Prefix = "stash"`, the default temp object is
  `stash/temp/uploads/{deviceId}/{contentHash}/{fileName}`. The app still stores and
  sends the logical path `/temp/uploads/{deviceId}/{contentHash}/{fileName}`.
- **Presign expiry:** choose a value long enough for the upload/download to
  finish but no longer than the credentials' remaining lifetime. The signer
  clamps out-of-range values to 1–604800 seconds.

Minimal S3 `.env` example:

```bash
EXPO_PUBLIC_S3_BUCKET=stash-uploads
EXPO_PUBLIC_S3_REGION=us-east-1
EXPO_PUBLIC_S3_ACCESS_KEY_ID=
EXPO_PUBLIC_S3_SECRET_ACCESS_KEY=
EXPO_PUBLIC_S3_SESSION_TOKEN=
EXPO_PUBLIC_S3_ENDPOINT=
EXPO_PUBLIC_S3_PREFIX=
EXPO_PUBLIC_S3_FORCE_PATH_STYLE=false
EXPO_PUBLIC_S3_PRESIGN_EXPIRY_SECONDS=3600
```

> **Credentials are inlined.** `EXPO_PUBLIC_*` values end up in the client
> bundle. Use a scoped key/role that can only `PutObject`, `GetObject`,
> `DeleteObject` and `HeadObject` on this bucket/prefix, and rotate anything
> that was ever committed.

### 4.5 Kafka transport (Vercel proxy or REST proxy)

The app can reach Kafka through the **Stash Kafka proxy** deployed as a Vercel
Function (`kafka_proxy_vercel/`), or through a Confluent REST Proxy directly.
The proxy is preferred for production: broker credentials stay server-side and
upload responses arrive by polling instead of a long-lived REST consumer.

| Key | Default | Meaning |
| --- | --- | --- |
| `Kafka.Proxy.Enabled` | `false` | Use the Vercel proxy for produce/poll instead of the REST transport. |
| `Kafka.Proxy.BaseUrl` | `EXPO_PUBLIC_KAFKA_PROXY_BASE_URL` | Deployed proxy URL, e.g. `https://stash-kafka-proxy-<team>.vercel.app`. |
| `Kafka.Proxy.PollIntervalMs` | `15000` | Delay between polls after an empty poll (clamped 1 s–5 min). |
| `Kafka.Proxy.PollTimeoutMs` | `8000` | Server-side long-poll window per request (max 30 s). |
| `Kafka.Proxy.MaxRecordsPerPoll` | `50` | Records requested per poll (max 200). |
| `Kafka.Proxy.RequestTimeoutSeconds` | `45` | HTTP timeout per proxy request (must exceed `PollTimeoutMs`). |

A full page of records is drained immediately; failures back off exponentially
(2 s → 60 s) and deliveries are de-duplicated by `topic/partition/offset`.

With `Kafka.Proxy.Enabled = false` (the shipped default) the app keeps using the
direct REST transport below.

| Key | Default | Meaning |
| --- | --- | --- |
| `Kafka.RestUrl` | `EXPO_PUBLIC_KAFKA_REST_URL` | Confluent REST Proxy base URL, e.g. `https://kafka-rest.example.com/`. |
| `Kafka.RestUsername` / `RestPassword` | `EXPO_PUBLIC_KAFKA_REST_USERNAME` / `EXPO_PUBLIC_KAFKA_REST_PASSWORD` | HTTP Basic credentials for the proxy (blank = anonymous). |
| `Kafka.RestTimeoutSeconds` | `30` | Per-request timeout. |
| `Kafka.ClusterId` | `EXPO_PUBLIC_KAFKA_CLUSTER_ID` | Cluster id for the v3 produce endpoint; discovered via `GET v3/clusters` when blank. |
| `Kafka.TopicUploadRequest` | `stash.upload.request` | Topic for upload requests. |
| `Kafka.TopicUploadResponse` | `stash.upload.response` | Topic consumed for processing results. |
| `Kafka.TopicDeadLetter` | `stash.dlq` | Dead-letter topic for exhausted retries. |

### 4.6 Telemetry

| Key | Default | Meaning |
| --- | --- | --- |
| `ApplicationInsights.Enabled` | `false` | Reserved flag (parity with MAUI config). |
| `ApplicationInsights.ConnectionString` | `EXPO_PUBLIC_APPINSIGHTS_CONNECTION_STRING` | Reserved value. |

Minimal working configuration:

```bash
# .env (git-ignored) — copy from .env.example
EXPO_PUBLIC_IDENTITY_API_BASE_URL=https://<vercel-project>.vercel.app
EXPO_PUBLIC_KAFKA_REST_URL=https://kafka-rest.example.com/
EXPO_PUBLIC_KAFKA_REST_USERNAME=
EXPO_PUBLIC_KAFKA_REST_PASSWORD=
EXPO_PUBLIC_S3_BUCKET=stash-uploads
EXPO_PUBLIC_S3_REGION=us-east-1
EXPO_PUBLIC_S3_ACCESS_KEY_ID=
EXPO_PUBLIC_S3_SECRET_ACCESS_KEY=
```

Keep the shipped `appconfig.json` for non-secret defaults; only the `.env`
variables you set are overlaid on top of it.

> **Secrets:** keep credentials in `.env` (git-ignored), never in
> `appconfig.json`. `EXPO_PUBLIC_*` values are inlined into the bundle, so use
> scoped/limited credentials and rotate any credential that was ever committed.

---

## 5. Running the app

### 5.1 Web (fastest way to look at the UI)

```bash
npm run web
# or explicitly:
npx expo start --web --port 8081
```

Open <http://localhost:8081>. `metro.config.js` is required for web: it adds
`.wasm` to Metro's asset extensions (for the expo-sqlite worker) and serves the
`Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers that
browsers require for `SharedArrayBuffer`.

Notes:

- Web uses `localStorage` for the auth/theme keys instead of the native secure
  store; it is a development convenience, not a hardened secret store.
- The document picker becomes a normal browser file input.
- Web uploads/downloads call S3 from the browser, so the bucket must allow CORS
  from the Expo origin (`PUT`, `GET`, `HEAD`; see §12).
- A static build is produced with `npx expo export --platform web` → `dist/`.
  Serve it over HTTP with the same COOP/COEP headers if you need SQLite there.

### 5.2 Android (device or emulator)

```bash
npm run android          # Expo CLI launches an emulator if available
npx expo start           # then press "a" in the terminal, or scan the QR code
```

On a physical phone, install **Expo Go**, make sure the phone and computer are
on the same network, and scan the QR code printed by `npx expo start`. If LAN
discovery is blocked, use `npx expo start --tunnel`.

### 5.3 iOS

```bash
npm run ios              # macOS + Xcode simulator
npx expo start           # scan the QR code with the Camera app on a device
```

### 5.4 Type checking and production bundles

```bash
npm run typecheck                   # npm script for the same strict check
npx tsc --noEmit                    # strict TypeScript check, must exit 0
npx expo export --platform web      # static web bundle
npx expo export --platform android  # JS bundle for Android
```

### 5.5 Resetting local state

| What | Where | How |
| --- | --- | --- |
| Session (tokens, user, device id) | Secure store (`localStorage` on web) | Log out in the app, or clear site data in the browser |
| SQLite database (`stash.db`) | App sandbox | Web: clear site data. Native: reinstall the app / clear Expo Go data |
| Theme choice | `stash.theme.mode` key | Switch back to *System* in Settings |

---

## 6. Accounts and sessions

### 6.1 Device ID

On first launch the app generates a stable **32-character hex device ID** and
stores it under `stash.auth.device_id`. It is prefilled on the Login and
Register screens and can be edited before submitting; the note under the field
explains that it identifies the installation and normally should be left
unchanged. Every auth request, upload request header and file row carries it,
so one account can be associated with several devices.

### 6.2 Registering

1. Start the app → **Login** screen.
2. Tap **Create account**.
3. Enter email, password (minimum 8 characters) and confirm the password.
4. Leave the device ID as generated (or edit it deliberately).
5. Tap **Create account**. On success the tokens are persisted and the app goes
   straight to the main shell. **Back to sign in** returns to Login.

### 6.3 Signing in

1. Enter the email, the password and the device ID.
2. Tap **Sign in**. Failures — wrong credentials, unreachable host, or a missing
   `IdentityApiBaseUrl` — appear in the red error label above the button
   (for example *“Identity API base URL is not configured.”*).

### 6.4 Session behaviour

- The access token, refresh token, expiry and user id are stored under
  `stash.auth.access_token`, `stash.auth.refresh_token`,
  `stash.auth.expires_at` and `stash.auth.user_id`.
- On startup the app restores the session and returns you to the signed-in
  shell if a refresh token is still valid; otherwise it shows Login.
- Before any authenticated call the service checks the token and refreshes it
  when it is within **60 seconds** of expiry (`POST api/auth/refresh`).
- **Log out** (header button `LogoutButton`, or Settings → Log out) clears the
  stored tokens and returns to Login; the device ID stays stored, so the next
  sign-in reuses the same device. A server-side revoke helper
  (`revokeDeviceAsync`) exists — `POST api/auth/revoke` with a Bearer token and
  `{ deviceId }` — but the UI logout path does not call it.

---

## 7. Using the app

The signed-in shell has five tabs plus a header with the app title and a
**Log out** action.

### 7.1 Files

- Lists every file row in SQLite, newest first, each with a status chip
  (name, colour and Ionicon come from the documented status contract).
- **Pull down to refresh** — runs the background upload pass immediately
  (scan enabled folders → dedup → upload → publish → bookkeeping).
- **Tap a card** → details dialog: path, size, status, MIME type, SHA-256 hash,
  retries, storage temp path (the logical S3 path), permanent path, device id,
  last attempt, error text.
- **Tap ⋯ on a card** → actions: **Retry upload** (only for `Failed` /
  `Retrying` files), **Details**, **Close**.
- **Upload FAB** (cloud icon) jumps to the Upload tab.
- Empty state offers **Add Folders**, which opens the Folders tab.

### 7.2 Upload

1. Tap **Pick Files** → choose one or more images/videos
   (`expo-document-picker`, `image/*` + `video/*`, multi-select).
2. Picked files are listed with sizes; a file above the 500 MB limit is flagged,
   and the ✕ on a row removes it from the selection.
3. Tap **Upload Files**. The app hashes each file (native
   `File.digest('SHA-256')` on iOS/Android, `crypto.subtle` on web), skips
   duplicates already present by hash, inserts new rows as `Pending`,
   uploads to S3 in batches through presigned PUT URLs, and publishes Kafka
   upload requests for the uploaded files.
4. A toast summarises the outcome, e.g.
   `Uploaded: 3, Queued: 1, Failed: 0, Duplicates skipped: 2`.
5. While work is in flight the button shows **Uploading…** and is disabled.

Signing in is required; otherwise the app shows *“Sign in to upload files.”*

### 7.3 Folders

- **＋ FAB** (or the empty-state **Add Folder** button) opens **Add Folder**.
  Tap **Choose Folder** to use the system folder picker
  (`Directory.pickDirectoryAsync()`); the picked name and URI are stored.
  **Enter a path manually** remains under the dialog for development and legacy
  locations. Duplicate paths are rejected with *“This folder is already
  configured.”*
- On Android, system-picked folders use per-folder SAF grants and do not need
  broad storage permissions. Manual non-`content://` paths still request storage
  access before they are added.
- On iOS, folder access is granted for the current session; re-select the folder
  after the app restarts.
- Each row shows the folder name with an enable switch — the background pass
  and *Scan now* only consider enabled folders. System-picked folders show a
  friendly “System folder” subtitle instead of the long URI.
- **Tap a row** for actions: **Scan now** (scan this folder immediately and
  report `Scanned N files, M new`), **Delete**, **Close**.
- Default include patterns are the 14 documented media patterns:
  `*.jpg *.jpeg *.png *.heic *.heif *.raw *.dng *.cr2 *.nef *.arw *.mov *.mp4
  *.avif *.webp`, with recursive subfolder walks.

The scanner enumerates the configured folder with `Directory.list()` and hashes
files natively with `File.digest('SHA-256')`. Folder scanning is native-only; in
the browser use Upload → Pick Files.

### 7.4 Settings

- **Appearance** — *System / Light / Dark* chips. The choice is persisted under
  `stash.theme.mode` and drives the palette everywhere.
- **Account** — current **User ID** and **Device ID**, and **Log out**.
- **Configuration** — read-only readout of the effective values: Identity API,
  request timeout, storage provider, storage bucket, storage region, batch
  size, max retries, max file size, background cadence, files per run, Kafka
  REST proxy and the three topics. This is the quickest way to verify a
  deployment picked up the right `appconfig.json` plus `.env` values.
- **Diagnostics** — a read-only health snapshot (files by status, stuck
  uploads/processing, outbox state, hash-cache and processed-response
  counts, last background pass/flush/Kafka response, recent `file_events`),
  refreshed on focus or with **Refresh diagnostics**. The same section keeps
  the legacy manual-path permission controls and the error-log show/clear
  actions.

### 7.5 About

Version/product information and the documented colour swatches, useful for
checking palette parity at a glance.

### 7.6 Look and feel

- OpenSans (400/600/700) loaded through `@expo-google-fonts/open-sans`.
- Colours, spacing and button styles mirror `Stash.Maui` resources; light and
  dark palettes are selected from the system setting or the Settings chips.
- Feedback is a snackbar-style toast; confirmations use an in-app dialog
  (not the platform alert) so behaviour is identical on web and native.

---

## 8. Upload pipeline and status lifecycle

For each file the app records a row in `files` and moves it through:

| Status | Meaning | Chip colour |
| --- | --- | --- |
| `Pending` | Discovered/picked, not processed yet | grey `#9E9E9E` |
| `Scanning` | Folder scan in progress | blue `#2196F3` |
| `Hashing` | Computing SHA-256 | orange `#FF9800` |
| `Uploading` | Sending bytes to S3 | purple `#9C27B0` |
| `Uploaded` | Stored in S3 temp storage | green `#4CAF50` |
| `Processing` | Kafka request published, awaiting host result | indigo `#3F51B5` |
| `Completed` | Host confirmed the permanent copy | teal `#009688` |
| `Failed` | Upload/publish failed (retry available) | red `#F44336` |
| `Retrying` | Retry scheduled/in progress | orange `#FF9800` |
| `Deduplicated` | Skipped because the content hash already exists | grey `#9E9E9E` |

Steps performed by the upload manager:

1. **Hash** — SHA-256 of the file contents: native `File.digest('SHA-256')`
   (with a `content://` cache-copy fallback); web `crypto.subtle` with a
   `js-sha256` fallback.
2. **Dedup** — `existsByContentHashAsync(hash)`; `content_hash` is `UNIQUE`, so
   the same bytes are never uploaded twice.
3. **Batch** — files are grouped into byte-aware batches: at most
   `UploadSettings.BatchSize` transfers and at most
   `UploadSettings.MaxConcurrentBytes` declared bytes per batch. A single file
   larger than the byte budget runs alone.
4. **S3 upload** — `src/services/storage/s3StorageService.ts` derives the bucket
   key from the logical path (`Storage.S3.Prefix` + the path without its leading
   slash), presigns a `PUT` with
   `src/services/storage/s3Signing.ts` (AWS SigV4, `UNSIGNED-PAYLOAD`,
   host-only signing, pure-JS `js-sha256`), and sends the file:
   - **Native:** SDK 58 `File.createUploadTask` with `PUT` +
     `BINARY_CONTENT`, which streams the file on the native side and reports
     progress and cancellation. Android `content://` (SAF) URIs are first
     copied to the cache and the temporary copy is deleted afterwards.
   - **Web:** the picked `Blob` is uploaded with `fetch`; the browser path
     buffers the file in memory.
   The logical path `/temp/uploads/{deviceId}/{contentHash}/{fileName}` is
   persisted in SQLite (`storage_temp_path`) and is the value sent to Kafka.
   Before presigning a `PUT`, the provider HEADs the key; when the object already
   exists (same content hash) the transfer is skipped and the path is reused. No physical-name
   mapping and no storage account login are involved.
   `existsAsync`/`getFileSizeAsync` use presigned `HEAD`, `downloadAsync` uses a
   presigned `GET`, and `deleteFileAsync` uses a presigned `DELETE`.
5. **Publish** — with `Kafka.Proxy.Enabled`, an authenticated
   `POST {Kafka.Proxy.BaseUrl}/api/messages` to the Vercel proxy, which produces
   the record with the native Confluent client and adds the headers
   `X-Message-Version`, `Authorization`, `X-Correlation-Id`, `X-Device-Id`,
   `X-User-Id`. Otherwise a Confluent REST Proxy **v3** produce call to
   `POST {RestUrl}v3/clusters/{clusterId}/topics/{topic}/records`.
6. **Consume** — with the proxy enabled, a **polling loop**
   (`GET {Kafka.Proxy.BaseUrl}/api/messages?topic=…`) drains
   `TopicUploadResponse`; the proxy filters the returned records to the verified
   device/user and drops unidentified records before the app sees them.
   Otherwise a **v2** consumer (`POST consumers/{groupId}`,
   subscription, `GET .../records`) reads it without a server-side identity
   filter. Either way records are matched by `fileId`/`correlationId` (and
   response identity when present) and move rows to `Processing`, `Completed` or
   `Failed`. Exhausted retries are produced to `TopicDeadLetter`.

Upload request payload (`camelCase` JSON, version 2):

```json
{
  "messageId": "uuid",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "fileId": "<sha256 content hash, also the record key>",
  "fileName": "IMG_0001.jpg",
  "fileSize": 1234567,
  "mimeType": "image/jpeg",
  "storageTempPath": "/temp/uploads/<deviceId>/<contentHash>/IMG_0001.jpg",
  "storageProvider": "S3",
  "metadata": { "createdAt": "...", "modifiedAt": "..." },
  "deviceId": "<32 hex>",
  "userId": "<identity user id>",
  "correlationId": "uuid",
  "version": 2
}
```

`storageTempPath` is the logical path, not the bucket key. The consumer must
apply the same `Storage.S3.Prefix` configuration when it reads the object.

Upload response payload: `fileId`, `status` (`COMPLETED` | `FAILED`),
`permanentPath`, `thumbnails`, `convertedFormat`, `deduplicated`,
`processingTimeMs`, `error`, `deviceId`, `userId`, `correlationId`, `version`.
The response contract stays at version 1; the identity fields are additive.
Through the Vercel proxy, polled responses are filtered to the authenticated
device/user, and records without a usable `deviceId` are excluded.

---

## 9. Background upload pass

React Native has no OS-level periodic task in this project (see §12), so the
documented polling fallback is used:

- A timer is armed for `BackgroundUpload.IntervalMinutes` (15 by default).
- It fires **only while the app is in the `active` AppState**; when the app
  goes to background the timer is cleared, and on return it is re-armed.
- Each run: scan enabled folders → hash/dedup → select candidates → batch
  upload → publish Kafka requests → update statuses, limited to
  `MaxFilesPerRun` (50) files.
- The Files pull-to-refresh gesture runs the same pass on demand.
- `BackgroundUpload.Enabled: false` disables both the timer and the pass.
- The Kafka response consumer runs in the same lifecycle, so incoming
  `Completed`/`Failed` results are applied while the app is foregrounded.

---

## 10. Local data

Database file: `stash.db` (WAL mode).

`files` — one row per discovered/selected file:
`id`, `file_name`, `file_path`, `file_size`, `content_hash` (UNIQUE),
`mime_type`, `created_at`, `modified_at`, `discovered_at`, `status`,
`storage_temp_path`, `permanent_path`, `error_message`, `retry_count`,
`last_attempt_at`, `device_id`, `user_id`, `thumbnails`, `converted_format`,
`is_deduplicated`. Indexed on `status` and `content_hash`.

`folder_configs` — `id`, `folder_path`, `folder_name`, `is_enabled`,
`added_at`, `last_scanned_at`, `include_patterns`, `exclude_patterns`,
`include_subfolders`.

`storage_temp_path` replaces the old `mega_temp_path` column. On first open the
app runs an idempotent migration: it renames `mega_temp_path` when possible,
otherwise it adds `storage_temp_path` and copies the old values into it, then
drops the legacy column when SQLite supports it. Existing rows keep their temp
paths, so in-flight files are not re-uploaded. The old column is retired when
possible; on SQLite builds that cannot drop it, it remains unused.

Stored keys: `stash.auth.access_token`, `stash.auth.refresh_token`,
`stash.auth.expires_at`, `stash.auth.user_id`, `stash.auth.device_id`
(secure store, or `localStorage` on web) and `stash.theme.mode`.

---

## 11. Backend contract summary

Identity requests go to the Identity API (Vercel or local .NET) at `{IdentityApiBaseUrl}`. If you need to stand up a backend, these are the endpoints the app calls:

| Purpose | Request |
| --- | --- |
| Register | `POST {IdentityApiBaseUrl}/api/auth/register` `{ email, password, deviceId }` |
| Login | `POST {IdentityApiBaseUrl}/api/auth/login` `{ email, password, deviceId }` |
| Refresh | `POST {IdentityApiBaseUrl}/api/auth/refresh` `{ refreshToken }` |
| Revoke device | `POST {IdentityApiBaseUrl}/api/auth/revoke` `{ deviceId }` + `Authorization: Bearer <access token>` |
| Kafka produce | `POST {RestUrl}v3/clusters/{id}/topics/{topic}/records` |
| Kafka consume | `POST {RestUrl}consumers/{group}` → `POST .../subscription` → `GET .../records` |

S3 is **not** part of this HTTP contract: the app writes directly to the bucket
with presigned URLs generated on the device. The host must therefore:

- accept upload requests with `version: 2`;
- read `storageTempPath` from S3, applying the configured `Storage.S3.Prefix`
  and bucket/region/credentials;
- treat `storageProvider: "S3"` as the staging provider (and reject or route
  other providers explicitly);
- delete the temporary object after processing if that is the desired
  lifecycle.

Auth responses must return a body with `accessToken` (or `access_token`) and
`refreshToken` (or `refresh_token`); an optional expiry claim is read from the
JWT `exp` when present. Error responses should carry a readable message
(`error`, `message`, `detail` or plain text) — the app shows it verbatim in the
error label or toast.

**Known gap:** the .NET backend in this repository still uses
`MegaStorageProvider` (`Storage:Provider=Mega`), expects `megaTempPath`, and its
`UploadRequestValidator` only accepts `version == 1`. It will reject the new
client's version-2 messages and cannot read the S3 object. The full-stack flow
therefore does not work end-to-end until the host gains S3 support and a version
2 contract. This is a documented follow-up, not something the client can work
around.

---

## 12. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Signing in shows *“Identity API base URL is not configured.”* | `IdentityApiBaseUrl` is empty | Set `EXPO_PUBLIC_IDENTITY_API_BASE_URL` in `.env` and restart the dev server. |
| Signing in fails with a network/timeout error | Host unreachable, wrong scheme/port, or a device that cannot see `localhost` of your machine | Use a LAN IP or HTTPS tunnel URL instead of `localhost`, check `IdentityApiTimeoutSeconds`. |
| Vercel Identity API returns 500 | Required environment variables are missing on the Vercel project | Set `MONGODB_URI`, `MONGODB_DATABASE`, `JWT_SIGNING_KEY`, `JWT_ISSUER` and `JWT_AUDIENCE`, then redeploy. |
| 401 `invalid_token` from the proxy/host after deploying the Identity API | `JWT_SIGNING_KEY`, issuer or audience differs between the Vercel project, the Kafka proxy and any host validating tokens | Keep `JWT_SIGNING_KEY`, `JWT_ISSUER` (`stash-auth`) and `JWT_AUDIENCE` (`stash-app`) identical across all token consumers. |
| Browser CORS error on `/api/auth/*` | The Expo/web origin is not in `CORS_ALLOWED_ORIGINS` on the Vercel project | Set `CORS_ALLOWED_ORIGINS` on the Vercel project to the app origin(s), comma-separated; the default is `*`. |
| Config edits have no effect | `appconfig.json` and `.env` are bundled at build time | Stop and restart `npx expo start` (clear cache with `npx expo start -c` if needed). |
| Web build/bundle errors about `wa-sqlite` or `SharedArrayBuffer` | `metro.config.js` missing or headers not served | Keep `metro.config.js` as shipped; serve web over HTTP(S) with COOP/COEP if you host `dist/`. |
| Upload says *“Amazon S3 is not configured…”* | Bucket, region, access key or secret is empty | Set `EXPO_PUBLIC_S3_BUCKET`, `EXPO_PUBLIC_S3_REGION`, `EXPO_PUBLIC_S3_ACCESS_KEY_ID` and `EXPO_PUBLIC_S3_SECRET_ACCESS_KEY` and restart. |
| Upload fails with `403 SignatureDoesNotMatch` | Wrong secret, wrong region, or the device clock is skewed from AWS | Re-check the secret and region; enable automatic device time and retry. SigV4 rejects large clock skew. |
| Upload fails with `403 AccessDenied` / `InvalidAccessKeyId` | Key disabled, wrong account, or the bucket policy/IAM role denies the operation | Grant the key `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and `s3:HeadObject` on the bucket/prefix; verify the key id. |
| Upload fails with `403 Request has expired` / token errors | The presigned URL or the STS session token expired | Raise `PresignExpirySeconds` within the credential lifetime, or refresh the temporary credentials; presigns are clamped to 604800 s. |
| Upload fails with `404 NoSuchBucket` / `NoSuchKey` | Bucket name, key, prefix or region is wrong | Verify the bucket exists in that region and that the expected key is `Prefix/temp/uploads/...`; check `Storage.S3.Prefix` on both client and host. |
| S3 request redirects, or DNS/TLS errors | Wrong region or endpoint | Set the bucket's real region. For AWS leave `Endpoint` empty; for MinIO/R2 set the correct `Endpoint` (and path style if required). |
| Web upload says *“Failed to fetch”* / CORS preflight fails | The bucket has no CORS rule for the Expo origin | Add a bucket CORS rule allowing `PUT`, `GET`, `HEAD` (and the request headers the browser sends) from `http://localhost:8081` or your deployed origin. |
| S3 transfer fails immediately on Android with a `content://` URI | The SAF provider cannot be streamed directly | Expected fallback: the app stages a cache copy before uploading; check free cache space and storage permission. |
| Kafka produce fails with *no cluster_id* | Proxy did not return a cluster id | Set `EXPO_PUBLIC_KAFKA_CLUSTER_ID` explicitly (e.g. `confluent-local`). |
| Files never reach `Completed` | No consumer running, wrong `TopicUploadResponse`, the host never replies, or the host rejects version 2 | Confirm the topic names and consumer endpoints. With the repository backend, expect v2 requests to be rejected until S3/version-2 support is added. |
| Folder scan finds nothing | Folder disabled, stale iOS grant, unreadable URI, or files outside the 14 patterns | Enable the folder; re-select it with Choose Folder (especially after an iOS restart); verify the extension; folder scanning is native-only. |
| Theme does not follow the OS | A fixed mode is selected | Settings → Appearance → **System**. |
| Buttons seem unresponsive in a browser automation tool | Some DOM click automation (single synthetic `click`) does not satisfy React Native Web's responder system | Use real pointer input or `element.click()`; the app's handlers themselves are fine. |
| `npx tsc --noEmit` fails after a dependency update | Type mismatches from a new SDK | Align versions with `npx expo install --fix` and re-run the check. |

---

## 13. Known limitations and deviations

- **No OS background worker.** The 15-minute pass is AppState-aware in-app
  polling, per the documented fallback; it does not run while the app is
  backgrounded or killed. Adding `expo-background-task`/`expo-task-manager`
  would be a follow-up.
- **React Navigation, not Expo Router.** The plan specifies an auth-gated
  native-stack with a bottom-tab shell, which is implemented with
  `@react-navigation/native-stack` + `@react-navigation/bottom-tabs`.
- **No live backend bundled.** Identity, Kafka and S3 endpoints/credentials are
  placeholders; the corresponding actions fail with explicit messages until
  configured.
- **S3 credentials are inlined in the app bundle.** They come from
  `EXPO_PUBLIC_*` variables and are readable by anyone with the bundle. Use a
  tightly scoped key/role and rotate it; this is acceptable for personal/dev
  builds, not for wide distribution without a credential broker.
- **Presigned URLs are bearer credentials with a limited lifetime.** The default
  is 3600 seconds (clamped to 1–604800). A URL that leaks before it expires can
  be used until expiry; keep lifetimes short.
- **Single PUT only.** S3 limits one presigned PUT to 5 GB. Multipart/resumable
  upload and bucket lifecycle configuration are deferred; the app's 500 MB cap
  keeps single-PUT uploads comfortably below that.
- **Native streams, web buffers.** Native uploads use SDK 58
  `File.createUploadTask` and downloads use `downloadAsync`, so whole files are
  not held in JS.
  The web path reads the picked `Blob` into memory and downloads are handed to
  the browser as an object URL; keep the limit moderate for web-only use.
- **Web needs bucket CORS.** Browser PUT/GET calls are cross-origin; without a
  bucket CORS rule the transfer fails even though native builds work.
- **Host follow-up required.** The repository backend still uses MEGA and
  version 1. It does not read S3 and rejects `version: 2`, so live end-to-end
  processing is not available from this client until the host changes.
- **Thumbnails/conversion** are displayed and stored from the host response;
  the app does not generate thumbnails locally.
- **Web is a development target.** SQLite works via the wasm worker, and secure
  storage degrades to `localStorage`.

---

## 14. Verification checklist

Run from the app directory:

```bash
cd react_native_stash
npm install
npm run typecheck                  # exit 0, no type errors (package script)
npx tsc --noEmit                   # exit 0, no type errors
npx expo export --platform web     # static web bundle (no SDK build step)
npx expo export --platform android # JS bundle for Android
npx expo start --web --port 8081   # dev server on http://localhost:8081
```

Manual checks in the browser preview:

- Login renders with the Stash headline, OpenSans typography and a
  pre-generated 32-hex device ID.
- **Create account** → Register screen; **Back to sign in** → Login.
- Entering credentials and pressing **Sign in** runs the validation path and
  shows *“Identity API base URL is not configured.”* with the placeholder
  config, i.e. the full press → handler → error-label flow works.

For a deployed Identity API, check liveness:

```bash
curl -s https://<vercel-project>.vercel.app/api/auth/health
# {"status":"healthy","timestamp":"…"}
```

To verify against a real backend: set `EXPO_PUBLIC_IDENTITY_API_BASE_URL` and
the S3 variables in `.env`, restart, register a user, confirm the shell appears,
sign out and sign back in, then upload a file and confirm the object appears at
`Prefix/temp/uploads/{deviceId}/{contentHash}/{fileName}`. Check that the published record is
version 2 with `storageTempPath` and `storageProvider: "S3"`. A host that
accepts version 2 and reads S3 is required for `Completed`; the repository
backend does not yet do so. No live S3 run is claimed by this guide.

---

## 15. Where to change things

| Task | File |
| --- | --- |
| Architecture, data flow and diagrams | [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) |
| Colours / palette | `src/theme/colors.ts` |
| Fonts, sizes, form metrics | `src/theme/typography.ts` |
| Theme resolution (system/light/dark) | `src/theme/ThemeContext.tsx` |
| Auth endpoints, token handling | `src/auth/authenticationService.ts` |
| Session state, startup restore | `src/auth/AuthContext.tsx` |
| Media patterns / MIME map | `src/models/mediaPatterns.ts` |
| Status labels, colours, icons | `src/models/uploadStatus.ts` |
| SQLite schema and `storage_temp_path` migration | `src/data/database.ts` |
| Kafka message contracts | `src/models/messages.ts` |
| Kafka REST calls | `src/services/kafkaRestTransport.ts` |
| Storage provider contract | `src/services/storage/storageProvider.ts` |
| Storage provider factory | `src/services/storage/storageProviderFactory.ts` |
| S3 upload/exists/download/delete | `src/services/storage/s3StorageService.ts` |
| Pure-JS AWS SigV4 presigner | `src/services/storage/s3Signing.ts` |
| Native streaming / web Blob transfers | `src/services/storage/s3Transfer.ts` |
| Batching / retry / publish orchestration | `src/services/uploadManager.ts`, `src/services/uploadActions.ts` |
| Background pass and timer | `src/services/backgroundUploadService.ts`, `src/services/backgroundUploadScheduler.ts` |
| Service wiring | `src/services/singletons.ts` |
| Tabs and header | `src/navigation/MainTabs.tsx`, `src/navigation/RootNavigator.tsx` |
