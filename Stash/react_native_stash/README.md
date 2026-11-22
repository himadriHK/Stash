# Stash (React Native)

A React Native (Expo) recreation of the **Stash.Maui** app: same UI look —
exact MAUI palette, OpenSans typography, light/dark theming — and the full
feature set documented in `FlutterStash*.md` and `ReactNativeStashPlan.md`.

## Features

- **Identity API auth** — register / login / refresh / revoke against the
  Identity API (the Vercel function in `kafka_proxy_vercel`, which shares the
  proxy origin, or the local .NET `StashHost.IdentityApi`) with JWT access
  tokens plus a stable 32-hex device ID (expo-secure-store, localStorage
  fallback on web), proactive refresh with a 60-second expiry margin, session
  restore on startup, and logout from the header or Settings.
- **SQLite storage** — `files` (UNIQUE content hash → dedup) and
  `folder_configs` tables via expo-sqlite with repositories mirroring the MAUI
  data layer. `files` also persists the logical storage temp path
  (`storage_temp_path`) used by the upload pipeline.
- **Folder scanning** — system folder picker (`Directory.pickDirectoryAsync()`)
  with 14 documented media patterns, recursive `Directory.list()` walk, native
  `File.digest('SHA-256')`, dedup inserts, manual *Scan now* and background
  scanning of enabled folders. A manual path remains for development/legacy
  locations; iOS grants are session-scoped.
- **S3 upload with presigned SigV4 URLs** — the app builds AWS Signature V4
  presigned URLs on the device with a pure-JS signer (`js-sha256`,
  `UNSIGNED-PAYLOAD`, host-only signing) and transfers through short-lived
  presigned URLs. Native uploads stream through SDK 58 `File.createUploadTask`
  (whole files are not buffered in JS); web uploads the picked `Blob` with
  `fetch`. Byte-aware batched uploads (`BatchSize`, `MaxConcurrentBytes`), retry state
  (`MaxRetries`), SHA-256 dedup, 500 MB client limit, logical temp path
  `/temp/uploads/{deviceId}/{contentHash}/{fileName}`, and a manual Upload screen (document
  picker → hash → dedup → batch → publish).
- **Kafka proxy transport** — `kafka_proxy_vercel/` Vercel Function produces
  with the native Confluent client, and the app **polls** `GET /api/messages`
  for upload responses (de-duplication, backoff, token refresh).
- **Background upload pass** — the documented 15-minute AppState-aware
  interval (`BackgroundUpload:IntervalMinutes`, max 50 files per run): scan →
  dedup → filter candidates → batch upload → publish → status bookkeeping.
  Runs on pull-to-refresh in Files as well.
- **Screens** — Login, Register, and a main shell with **Gallery / Files /
  Upload / Folders / Settings / About** tabs. **Gallery** mirrors the reviewed
  mockup: a three-column media grid with All/Photos/Videos/Favorites filters,
  search, per-tile status badges, long-press selection with share/remove, a
  pending-sync badge and pull-to-refresh. **Notifications** (opened from the
  Gallery bell) is a status feed with All/Uploads/Errors/Synced tabs, unread
  markers, mark-all-read and retry for failed uploads. Folders gained include/
  exclude pattern editing, subfolder choice and a details sheet (last scan,
  patterns, subfolder toggle, scan/delete). Settings gained Backup Status (total
  files/size/pending/last sync, storage readiness, **Sync now**), Auto-upload
  and Backup videos preferences, and an About block. Status chips, empty states,
  snackbar toasts, the effective-config readout and **Diagnostics** remain.

## Architecture

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the runtime shell, local data model, upload and background passes, S3 provider internals, Kafka contract and platform behavior.

See **[docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)** for the reliability, performance and observability implementation plan and progress tracker.

## Run

See **[docs/SETUP_AND_USAGE.md](docs/SETUP_AND_USAGE.md)** for the full
setup, configuration, usage, backend-contract and troubleshooting guide.

No sibling SDK or package build step is required: the storage abstraction and
S3 client live in `react_native_stash/src/services/storage/`. Install and run:

```bash
cd react_native_stash
npm install
npx expo start          # dev server (scan QR with Expo Go)
npx expo start --web    # web (metro.config.js adds wasm + COOP/COEP headers)
npm run typecheck       # typecheck (tsc --noEmit)
npx expo export --platform web   # static web build -> dist/
```

## Configuration

- `src/config/appconfig.json` holds non-secret defaults (topics, timeouts, batch sizes).
- Secrets and machine-specific endpoints are supplied through `EXPO_PUBLIC_*` variables in a local `.env` file (git-ignored); see `.env.example`.

| Area | Environment variables |
| --- | --- |
| Identity | `EXPO_PUBLIC_IDENTITY_API_BASE_URL` (`https://<vercel-project>.vercel.app`; `http://localhost:5102` for local) |
| Kafka | `EXPO_PUBLIC_KAFKA_PROXY_BASE_URL` |
| S3 | `EXPO_PUBLIC_S3_BUCKET`, `EXPO_PUBLIC_S3_REGION`, `EXPO_PUBLIC_S3_ACCESS_KEY_ID`, `EXPO_PUBLIC_S3_SECRET_ACCESS_KEY`, `EXPO_PUBLIC_S3_SESSION_TOKEN`, `EXPO_PUBLIC_S3_ENDPOINT`, `EXPO_PUBLIC_S3_PREFIX`, `EXPO_PUBLIC_S3_FORCE_PATH_STYLE`, `EXPO_PUBLIC_S3_PRESIGN_EXPIRY_SECONDS` |

Copy `.env.example` to `.env` and fill in real values, then restart the dev server: Expo inlines these variables into the bundle at build time.

The Identity API may be the Vercel function in [`kafka_proxy_vercel`](../kafka_proxy_vercel/README.md) (the same origin can also serve the Kafka proxy, so `EXPO_PUBLIC_KAFKA_PROXY_BASE_URL` can reuse it) or the local .NET `StashHost.IdentityApi`. Deployment and environment details: [kafka_proxy_vercel/README.md](../kafka_proxy_vercel/README.md); implementation plan: [kafka_proxy_vercel/docs/IDENTITY_API_PLAN.md](../kafka_proxy_vercel/docs/IDENTITY_API_PLAN.md).

### Storage.S3 keys

| Key | Default | Meaning |
| --- | --- | --- |
| `Storage.Provider` | `"S3"` | Storage provider label; `S3` is the only supported provider. |
| `Storage.S3.Bucket` | `EXPO_PUBLIC_S3_BUCKET` | Target bucket. Empty means uploads fail with “Amazon S3 is not configured…”. |
| `Storage.S3.Region` | `us-east-1` | AWS region used in the SigV4 credential scope and default endpoint. |
| `Storage.S3.AccessKeyId` | `EXPO_PUBLIC_S3_ACCESS_KEY_ID` | Access key used to sign presigned URLs. |
| `Storage.S3.SecretAccessKey` | `EXPO_PUBLIC_S3_SECRET_ACCESS_KEY` | Secret key used to sign presigned URLs. |
| `Storage.S3.SessionToken` | empty | Optional STS/role session token; sent as `X-Amz-Security-Token` when set. |
| `Storage.S3.Endpoint` | empty (AWS) | Custom S3-compatible endpoint, e.g. `https://minio.example.com` or Cloudflare R2. Must start with `http://` or `https://`. |
| `Storage.S3.ForcePathStyle` | `false` | Path-style addressing (`https://host/bucket/key`); required by MinIO and many S3-compatible servers. |
| `Storage.S3.Prefix` | empty | Optional key prefix (no leading/trailing slash), e.g. `stash`. |
| `Storage.S3.PresignExpirySeconds` | `3600` | Presigned URL lifetime; clamped to 1…604800 seconds. |

The bucket key is the optional prefix plus the logical path without its leading
slash, so the default object key is `temp/uploads/{deviceId}/{contentHash}/{fileName}`. Because the key contains the content hash, a repeated upload reuses the existing object (checked with HEAD).

Non-secret settings stay in `appconfig.json`:

| Section | Purpose |
| --- | --- |
| `IdentityApiTimeoutSeconds` | Identity API request timeout |
| `Kafka.Proxy.*` (except `BaseUrl`) | Proxy polling interval/timeout and page size |
| `Kafka.Topic*` | Upload request/response and dead-letter topics |
| `Storage.Provider` / `Storage.S3` | Storage provider and S3 defaults |
| `UploadSettings` | `BatchSize`, `MaxConcurrentBytes`, `MaxRetries`, `MaxFileSizeBytes` |
| `BackgroundUpload` | `Enabled`, `IntervalMinutes` (15), `MaxFilesPerRun` (50) |

**Never commit `.env`.** `EXPO_PUBLIC_*` values are inlined into the client bundle, so use scoped/limited credentials and rotate anything that was previously committed.

## Structure

```
src/
  auth/        Identity API client + AuthContext (session restore)
  components/  AppButton, FormInput, dialogs, cards, toasts (MAUI styles.xaml parity)
  config/      appconfig.json + typed StashConfig
  data/        SQLite schema + File/Folder repositories (storage_temp_path)
  models/      entities, messages, upload status contract, media patterns
  navigation/  Root stack (Login/Register/Main) + 5-tab Main shell
  screens/     Login, Register, Files, Upload, Folders, Settings, About
  services/    scanner, upload manager, Kafka producer/consumer, background pass
               + scheduler, singletons
    storage/   storageProvider.ts, storageProviderFactory.ts, s3StorageService.ts,
               s3Signing.ts (pure-JS SigV4), s3Transfer.ts (native streaming /
               web Blob)
  theme/       colors.ts (palette), typography (OpenSans), ThemeContext
  utils/       storage, base64, formatting, ids, file access
```

## Backend contract

Upload requests are published with `version: 2` and carry:

- `storageTempPath` — the logical path `/temp/uploads/{deviceId}/{contentHash}/{fileName}`
- `storageProvider` — `"S3"`

The host/consumer must accept version 2, read the object from the configured S3
bucket (applying any `Storage.S3.Prefix`), and delete the temporary object after
processing. The .NET backend in this repository still uses MEGA
(`Storage:Provider=Mega`, `MegaStorageProvider`, and a version-1 validator that
expects the `megaTempPath` field), so the new client cannot complete the
end-to-end flow against it until the host gains S3 support. That host change is a
known follow-up.

## Notes

- Background execution uses the documented polling fallback (no native
  background modules): a timer fires only while the app is `active`.
- Expo Router is not used; navigation is React Navigation (native-stack +
  bottom-tabs) to match the plan's auth-gated shell.
- S3 uploads stream on native with SDK 58 `File.createUploadTask`; downloads
  use `downloadAsync` to write streamed bytes to disk. Web reads the picked
  `Blob` into memory because it has no file-system module, and downloads are
  handed to the browser as an object URL.
- Presigning is pure JS (`js-sha256`); there is no WebCrypto, Node `crypto`,
  `Buffer`, stream or AWS SDK dependency, so Expo Go still works with no extra
  native modules.
- Web uploads/downloads call S3 directly from the browser, so the bucket needs
  CORS rules allowing the Expo origin (at least `PUT`, `GET` and `HEAD`).
- S3 credentials are read from `EXPO_PUBLIC_*` variables and are therefore
  inlined into the app bundle. Use scoped credentials and rotate them; presigned
  URLs are short-lived (3600 seconds by default) but are themselves bearers.
- A single presigned PUT is limited by S3 to 5 GB. Multipart/resumable upload and
  bucket lifecycle configuration are deferred; the app's 500 MB
  `MaxFileSizeBytes` cap keeps single-PUT uploads below that.
- The setup guide covers configuration, the upload pipeline, the Kafka payload
  and troubleshooting: **[docs/SETUP_AND_USAGE.md](docs/SETUP_AND_USAGE.md)**.
  The full-stack runbook is
  **[../docs/LOCAL_FULL_STACK_SETUP.md](../docs/LOCAL_FULL_STACK_SETUP.md)**.
