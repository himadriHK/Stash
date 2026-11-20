# Stash (React Native) — Setup & Usage Guide

A complete guide to installing, configuring and operating the React Native
(Expo) recreation of **Stash.Maui**. The app keeps the MAUI look — exact
palette, OpenSans typography, form/button styling, light + dark appearance —
and reimplements the documented feature set: Identity API authentication,
SQLite storage with SHA-256 deduplication, folder scanning, direct MEGA upload
through the local `react-native-mega` client, Kafka REST messaging and the
15-minute background upload pass.

> To run the app against the real backend (Identity API, Functions host, MongoDB,
> Aiven Kafka and MEGA) on one machine, use the repository-wide runbook:
> **[../../docs/LOCAL_FULL_STACK_SETUP.md](../../docs/LOCAL_FULL_STACK_SETUP.md)**.
> This document stays client-only: it explains the app itself and its contracts.

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
    services/             scanner, MEGA client (react-native-mega) + file
                          adapters, upload manager, Kafka REST producer/
                          consumer, background pass + scheduler, singletons
    theme/                colors, typography, ThemeContext
    utils/                secure storage, base64, formatting, ids, MEGA name
                          mapping (ports the host's MegaPathMapper)
```

Related documents at the repository root: `ReactNativeStashPlan.md` (the
plan/spec this implementation follows), `ReactNativeMegaStashIntegrationPlan.md`
(the MEGA transport migration), `FlutterStash*.md` (the original UI and feature
documentation), and `Stash.Maui/` (the .NET reference app).

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
all supported by Expo Go — no custom development build is required.

Backend services (Identity API, MEGA account, Kafka REST proxy) are **optional**.
Without them the UI, navigation, theming, local database and scanning all work;
network-dependent actions surface an explanatory error instead.

---

## 3. Installation

The app depends on the sibling `react-native-mega` package through
`file:../react-native-mega`. The package is consumed from its compiled `dist/`,
which is not committed, so build it first:

```bash
cd react-native-mega
npm install
npm run build

cd ../react_native_stash
npm install
```

Re-run `npm run build` in `react-native-mega` after changing its `src/` (Metro
watches the package, but it resolves `dist/`).

Clean install if dependencies ever look broken:

```bash
cd react-native-mega && npm install && npm run build
cd ../react_native_stash
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
| `IdentityApiBaseUrl` | `EXPO_PUBLIC_IDENTITY_API_BASE_URL` | Base URL of the Identity API, e.g. `https://auth.example.com`. **Empty means the app cannot sign in** and shows “Identity API base URL is not configured.” |
| `IdentityApiTimeoutSeconds` | `30` | Timeout for auth requests (register/login/refresh). |
| `Auth.Jwt.Issuer` | `"stash-auth"` | Expected token issuer (informational / validation parity). |
| `Auth.Jwt.Audience` | `"stash-app"` | Expected token audience. |

### 4.2 Upload settings

| Key | Default | Meaning |
| --- | --- | --- |
| `UploadSettings.BatchSize` | `10` | Files per upload batch. |
| `UploadSettings.MaxRetries` | `3` | Retry attempts before a file is marked `Failed` and dead-lettered. |
| `UploadSettings.MaxFileSizeBytes` | `524288000` | 500 MB per-file limit. Larger files are flagged instead of uploaded. |

### 4.3 Background upload pass

| Key | Default | Meaning |
| --- | --- | --- |
| `BackgroundUpload.Enabled` | `true` | Turns the periodic pass on/off. |
| `BackgroundUpload.IntervalMinutes` | `15` | Pass interval, matching the documented 15-minute cadence. |
| `BackgroundUpload.MaxFilesPerRun` | `50` | Cap of files handled per run (`0` or less = unlimited). |

### 4.4 Storage (MEGA)

| Key | Default | Meaning |
| --- | --- | --- |
| `Storage.Provider` | `"Mega"` | Storage provider label (shown in Settings). |
| `Storage.Mega.Email` | `EXPO_PUBLIC_MEGA_EMAIL` | MEGA account the app logs into with `react-native-mega`. Empty means uploads fail with “MEGA account is not configured.” |
| `Storage.Mega.Password` | `EXPO_PUBLIC_MEGA_PASSWORD` | Password for that account (used for the MEGA login, never sent as a header). |
| `Storage.Mega.SecondFactorCode` | `EXPO_PUBLIC_MEGA_SECOND_FACTOR_CODE` | Optional TOTP code for accounts with two-factor authentication; leave empty otherwise. |

There is no MEGA base URL: `src/services/megaHttpService.ts` creates a
`MegaStorage` session through `src/services/megaClient.ts` and talks to
`api.mega.co.nz` directly (§8). The SDK performs the protocol cryptography in
pure JS (`@noble/ciphers` + `@noble/hashes`), so Hermes needs no WebCrypto or
stream polyfills. Login passes `expo-crypto`'s secure RNG and native SHA-256
(the latter for MEGA's hashcash proof-of-work). No development build or native
module is required.

A full MEGA login is expensive (a 100k-round PBKDF2 in JS, an RSA session-id
decrypt, four sequential API calls and sometimes a hashcash proof of work), so
the session returned by the SDK is cached in secure storage under
`stash.mega.session`. Later launches resume with `MegaStorage.fromSession`
(one tree fetch, no password work) and fall back to a password login only when
MEGA rejects the stored session. `App.tsx` also warms the session in the
background once the user is authenticated, so the first upload does not wait
for authentication. Delete the key (or the app data) to force a fresh login.

MEGA may also answer the password login with a **hashcash proof of work**. Each
candidate hashes a 12.58 MB buffer and a typical challenge (`1:192:…`) accepts
about one candidate in 256, so the phase inherently costs ~3.2 GB of SHA-256 —
typically 5–15 s on a phone, during which `expo-crypto`'s synchronous native
digest occupies the JS thread. Nothing can be reused between candidates (the
counter is in the first block), so the app's levers are the stored session above
(no challenge on resume), the native digest, and `hashcashConcurrency`, which it
sets above 1 only on web where `crypto.subtle` hashes off the JS thread. The solve
is cancellable and reports progress through `hashcashProgress`.

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
EXPO_PUBLIC_IDENTITY_API_BASE_URL=https://auth.example.com
EXPO_PUBLIC_KAFKA_REST_URL=https://kafka-rest.example.com/
EXPO_PUBLIC_KAFKA_REST_USERNAME=
EXPO_PUBLIC_KAFKA_REST_PASSWORD=
EXPO_PUBLIC_MEGA_EMAIL=stash@example.com
EXPO_PUBLIC_MEGA_PASSWORD=
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
  retries, Mega temp path, permanent path, device id, last attempt, error text.
- **Tap ⋯ on a card** → actions: **Retry upload** (only for `Failed` /
  `Retrying` files), **Details**, **Close**.
- **Upload FAB** (cloud icon) jumps to the Upload tab.
- Empty state offers **Add Folders**, which opens the Folders tab.

### 7.2 Upload

1. Tap **Pick Files** → choose one or more images/videos
   (`expo-document-picker`, `image/*` + `video/*`, multi-select).
2. Picked files are listed with sizes; a file above the 500 MB limit is flagged,
   and the ✕ on a row removes it from the selection.
3. Tap **Upload Files**. The app hashes each file (SHA-256, chunked reads),
   skips duplicates already present by hash, inserts new rows as `Pending`,
   uploads to Mega in batches, and publishes Kafka upload requests for the
   uploaded files.
4. A toast summarises the outcome, e.g.
   `Uploaded: 3, Queued: 1, Failed: 0, Duplicates skipped: 2`.
5. While work is in flight the button shows **Uploading…** and is disabled.

Signing in is required; otherwise the app shows *“Sign in to upload files.”*

### 7.3 Folders

- **＋ FAB** (or the empty-state **Add Folder** button) opens the add dialog.
  Duplicate paths are rejected with *“This folder is already configured.”*
- Each row shows the folder name/path with an enable switch — the background
  pass and *Scan now* only consider enabled folders.
- **Tap a row** for actions: **Scan now** (scan this folder immediately and
  report `Scanned N files, M new`), **Delete**, **Close**.
- Default include patterns are the 14 documented media patterns:
  `*.jpg *.jpeg *.png *.heic *.heif *.raw *.dng *.cr2 *.nef *.arw *.mov *.mp4
  *.avif *.webp`, with recursive subfolder walks.

Folder paths are host paths as recorded in `folder_configs`; the scanner walks
them with `expo-file-system` (on web, only bundled/available URIs can be
read, so scanning is primarily a native feature).

### 7.4 Settings

- **Appearance** — *System / Light / Dark* chips. The choice is persisted under
  `stash.theme.mode` and drives the palette everywhere.
- **Account** — current **User ID** and **Device ID**, and **Log out**.
- **Configuration** — read-only readout of the effective values: Identity API,
  request timeout, storage provider, batch size, max retries, max file size,
  background cadence, files per run, Kafka REST proxy and the three topics.
  This is the quickest way to verify a deployment picked up the right
  `appconfig.json` plus `.env` values.

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
| `Uploading` | Sending bytes to Mega | purple `#9C27B0` |
| `Uploaded` | Stored in Mega temp storage | green `#4CAF50` |
| `Processing` | Kafka request published, awaiting host result | indigo `#3F51B5` |
| `Completed` | Host confirmed the permanent copy | teal `#009688` |
| `Failed` | Upload/publish failed (retry available) | red `#F44336` |
| `Retrying` | Retry scheduled/in progress | orange `#FF9800` |
| `Deduplicated` | Skipped because the content hash already exists | grey `#9E9E9E` |

Steps performed by the upload manager:

1. **Hash** — SHA-256 of the file contents (chunked reads via
   `expo-file-system`; `js-sha256`).
2. **Dedup** — `existsByContentHashAsync(hash)`; `content_hash` is `UNIQUE`, so
   the same bytes are never uploaded twice.
3. **Batch** — files are grouped by `UploadSettings.BatchSize`.
4. **MEGA upload** — `src/services/megaHttpService.ts` opens the local file as
   a chunked `ByteSource` (`src/services/megaFileAdapters.ts`) and calls
   `storage.root.upload(physicalName, source)` on a lazily created
   `react-native-mega` session for the `EXPO_PUBLIC_MEGA_EMAIL`/`EXPO_PUBLIC_MEGA_PASSWORD` credentials. The SDK
   encrypts and uploads 128 KB–1 MB chunks, commits the node, and verifies the
   meta-MAC; the whole file is never buffered on native. A retry deletes the
   previous physical-name node first.
   The logical path is `/temp/uploads/{deviceId}/{fileName}`; because the host
   can only address the MEGA account root, `src/utils/megaPathMapper.ts` (a port
   of `StashHost.Shared/Services/MegaPathMapper.cs`) encodes it into a physical
   root-level name such as `temp_uploads_{deviceId}_{name}_{hash8}{ext}`. The
   host recomputes the same name, so the two mappings must stay byte-identical.
   `existsAsync` uses `storage.find(physicalName)`; `downloadAsync` streams the
   node into a local `ByteSink` with ranged GETs and MAC verification.
5. **Publish** — with `Kafka.Proxy.Enabled`, an authenticated
   `POST {Kafka.Proxy.BaseUrl}/api/messages` to the Vercel proxy, which produces
the record with the native Confluent client and adds the headers
   `X-Message-Version`, `Authorization`, `X-Correlation-Id`, `X-Device-Id`,
   `X-User-Id`. Otherwise a Confluent REST Proxy **v3** produce call to
   `POST {RestUrl}v3/clusters/{clusterId}/topics/{topic}/records`.
6. **Consume** — with the proxy enabled, a **polling loop**
   (`GET {Kafka.Proxy.BaseUrl}/api/messages?topic=…`) drains
   `TopicUploadResponse`. Otherwise a **v2** consumer (`POST consumers/{groupId}`,
   subscription, `GET .../records`) reads it. Either way records are matched by
   `fileId`/`correlationId` and move rows to `Processing`, `Completed` or
   `Failed`. Exhausted retries are produced to `TopicDeadLetter`.

Upload request payload (`camelCase` JSON, matching the shared .NET contract):

```json
{
  "messageId": "uuid",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "fileId": "<sha256 content hash, also the record key>",
  "fileName": "IMG_0001.jpg",
  "fileSize": 1234567,
  "mimeType": "image/jpeg",
  "megaTempPath": "/temp/uploads/<deviceId>/IMG_0001.jpg",
  "metadata": { "createdAt": "...", "modifiedAt": "..." },
  "deviceId": "<32 hex>",
  "userId": "<identity user id>",
  "correlationId": "uuid",
  "version": 1
}
```

Upload response payload: `fileId`, `status` (`COMPLETED` | `FAILED`),
`permanentPath`, `thumbnails`, `convertedFormat`, `deduplicated`,
`processingTimeMs`, `error`, `correlationId`, `version`.

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
`mega_temp_path`, `permanent_path`, `error_message`, `retry_count`,
`last_attempt_at`, `device_id`, `user_id`, `thumbnails`, `converted_format`,
`is_deduplicated`. Indexed on `status` and `content_hash`.

`folder_configs` — `id`, `folder_path`, `folder_name`, `is_enabled`,
`added_at`, `last_scanned_at`, `include_patterns`, `exclude_patterns`,
`include_subfolders`.

Stored keys: `stash.auth.access_token`, `stash.auth.refresh_token`,
`stash.auth.expires_at`, `stash.auth.user_id`, `stash.auth.device_id`
(secure store, or `localStorage` on web) and `stash.theme.mode`.

---

## 11. Backend contract summary

If you need to stand up a backend, these are the endpoints the app calls:

| Purpose | Request |
| --- | --- |
| Register | `POST {IdentityApiBaseUrl}/api/auth/register` `{ email, password, deviceId }` |
| Login | `POST {IdentityApiBaseUrl}/api/auth/login` `{ email, password, deviceId }` |
| Refresh | `POST {IdentityApiBaseUrl}/api/auth/refresh` `{ refreshToken }` |
| Revoke device | `POST {IdentityApiBaseUrl}/api/auth/revoke` `{ deviceId }` + `Authorization: Bearer <access token>` |
| Kafka produce | `POST {RestUrl}v3/clusters/{id}/topics/{topic}/records` |
| Kafka consume | `POST {RestUrl}consumers/{group}` → `POST .../subscription` → `GET .../records` |

MEGA is **not** part of this HTTP contract: the app logs into the account
itself with `react-native-mega` and calls the MEGA API (`api.mega.co.nz`) from
the device. No bridge/host endpoint is involved, so a backend only has to read
the account with the same credentials and the same physical file names.

Auth responses must return a body with `accessToken` (or `access_token`) and
`refreshToken` (or `refresh_token`); an optional expiry claim is read from the
JWT `exp` when present. Error responses should carry a readable message
(`error`, `message`, `detail` or plain text) — the app shows it verbatim in the
error label or toast.

---

## 12. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Signing in shows *“Identity API base URL is not configured.”* | `IdentityApiBaseUrl` is empty | Set `EXPO_PUBLIC_IDENTITY_API_BASE_URL` in `.env` and restart the dev server. |
| Signing in fails with a network/timeout error | Host unreachable, wrong scheme/port, or a device that cannot see `localhost` of your machine | Use a LAN IP or HTTPS tunnel URL instead of `localhost`, check `IdentityApiTimeoutSeconds`. |
| Config edits have no effect | `appconfig.json` and `.env` are bundled at build time | Stop and restart `npx expo start` (clear cache with `npx expo start -c` if needed). |
| Web build/bundle errors about `wa-sqlite` or `SharedArrayBuffer` | `metro.config.js` missing or headers not served | Keep `metro.config.js` as shipped; serve web over HTTP(S) with COOP/COEP if you host `dist/`. |
| Upload says *“MEGA account is not configured…”* | `Storage.Mega.Email` or `Storage.Mega.Password` is empty | Set `EXPO_PUBLIC_MEGA_EMAIL` and `EXPO_PUBLIC_MEGA_PASSWORD` in `.env` and restart the dev server. |
| Upload says *“MEGA login failed: Object not found (wrong password?)”* | MEGA rejected the credentials | Check `EXPO_PUBLIC_MEGA_EMAIL` / `EXPO_PUBLIC_MEGA_PASSWORD` in `.env`. |
| Upload says *“MEGA login requires a two-factor code…”* | The account has 2FA enabled | Put the current TOTP in `EXPO_PUBLIC_MEGA_SECOND_FACTOR_CODE` in `.env` and restart the dev server. |
| Upload hangs on the first file for a while | MEGA's PBKDF2 login key (100 000 iterations) is derived in pure JS by the SDK | Expected on low-end phones; the session is reused for later uploads. |
| Kafka produce fails with *no cluster_id* | Proxy did not return a cluster id | Set `EXPO_PUBLIC_KAFKA_CLUSTER_ID` explicitly (e.g. `confluent-local`). |
| Files never reach `Completed` | No consumer running, wrong `TopicUploadResponse`, or the host never replies | Confirm the topic names and that the Kafka REST proxy consumer endpoints are enabled. |
| Folder scan finds nothing | Folder disabled, path not readable, or files outside the 14 patterns | Enable the folder; verify the path and extension; remember scans are meaningful mainly on native platforms. |
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
- **No live backend bundled.** Identity and Kafka endpoints (and, in a fresh
  checkout, the MEGA credentials) are placeholders; the corresponding actions
  fail with explicit messages until configured.
- **MEGA transfers stream on native, buffer on web.** `react-native-mega`
  reads/writes 128 KB–1 MB chunks through expo-file-system handles, so the
  500 MB limit is no longer a memory limit. Web has no expo-file-system
  implementation, so the browser path reads the picked Blob into memory; keep
  the limit moderate for web-only use. If a provider cannot be opened as a
  file handle, the adapter logs a fallback and reads the file into memory.
- **MEGA login cryptography is pure JS inside the SDK.** The first login derives
  PBKDF2-SHA-512 (100 000 iterations) on the JS thread and can take a moment on
  older phones; hashcash proof-of-work uses native `expo-crypto` SHA-256. There
  is no WebCrypto shim to maintain.
- **MEGA credentials are read from `EXPO_PUBLIC_*` variables (`.env`) and used
  on the device** by `react-native-mega`; they are inlined into the app bundle.
  That is fine for a personal/dev build, but ship a restricted account (or move
  the upload back to a server) before distributing the app.
- **Thumbnails/conversion** are displayed and stored from the host response;
  the app does not generate thumbnails locally.
- **Web is a development target.** SQLite works via the wasm worker, and secure
  storage degrades to `localStorage`.

---

## 14. Verification checklist

Already verified for this project:

```bash
cd ../react-native-mega && npm run build   # the linked SDK is consumed from dist/
cd ../react_native_stash
npx tsc --noEmit                  # exit 0, no type errors
npx expo export --platform web    # exit 0, bundles wa-sqlite.wasm + react-native-mega
npx expo export --platform android # exit 0, bundles react-native-mega for Hermes
npx expo start --web --port 8081  # dev server on http://localhost:8081
```

Manual checks performed in the browser preview:

- Login renders with the Stash headline, OpenSans typography and a
  pre-generated 32-hex device ID.
- **Create account** → Register screen; **Back to sign in** → Login.
- Entering credentials and pressing **Sign in** runs the validation path and
  shows *“Identity API base URL is not configured.”* with the placeholder
  config, i.e. the full press → handler → error-label flow works.

To verify against a real backend: set `EXPO_PUBLIC_IDENTITY_API_BASE_URL` in `.env`, restart, register a
user, confirm the shell appears, sign out and sign back in, then configure the
MEGA account + Kafka and follow §8.

---

## 15. Where to change things

| Task | File |
| --- | --- |
| Colours / palette | `src/theme/colors.ts` |
| Fonts, sizes, form metrics | `src/theme/typography.ts` |
| Theme resolution (system/light/dark) | `src/theme/ThemeContext.tsx` |
| Auth endpoints, token handling | `src/auth/authenticationService.ts` |
| Session state, startup restore | `src/auth/AuthContext.tsx` |
| Media patterns / MIME map | `src/models/mediaPatterns.ts` |
| Status labels, colours, icons | `src/models/uploadStatus.ts` |
| SQLite schema | `src/data/database.ts` |
| Kafka message contracts | `src/models/messages.ts` |
| Kafka REST calls | `src/services/kafkaRestTransport.ts` |
| MEGA client (react-native-mega) | `src/services/megaHttpService.ts` |
| MEGA login/adapters (RNG, SHA-256, fetch, 2FA) | `src/services/megaClient.ts` |
| Streaming file source/sink for MEGA transfers | `src/services/megaFileAdapters.ts` |
| Logical → MEGA file name mapping | `src/utils/megaPathMapper.ts` |
| Batching / retry / publish orchestration | `src/services/uploadManager.ts`, `src/services/uploadActions.ts` |
| Background pass and timer | `src/services/backgroundUploadService.ts`, `src/services/backgroundUploadScheduler.ts` |
| Service wiring | `src/services/singletons.ts` |
| Tabs and header | `src/navigation/MainTabs.tsx`, `src/navigation/RootNavigator.tsx` |
