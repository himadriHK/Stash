# Stash (React Native)

A React Native (Expo) recreation of the **Stash.Maui** app: same UI look —
exact MAUI palette, OpenSans typography, light/dark theming — and the full
feature set documented in `FlutterStash*.md` and `ReactNativeStashPlan.md`.

## Features

- **Identity API auth** — register / login / refresh / revoke with JWT access
  tokens plus a stable 32-hex device ID (expo-secure-store, localStorage
  fallback on web), proactive refresh with a 60-second expiry margin, session
  restore on startup, and logout from the header or Settings.
- **SQLite storage** — `files` (UNIQUE content hash → dedup) and
  `folder_configs` tables via expo-sqlite with repositories mirroring the MAUI
  data layer.
- **Folder scanning** — 14 documented media patterns, recursive walk, SHA-256
  hashing (js-sha256, chunked reads), dedup inserts, manual *Scan now* and
  background scanning of enabled folders.
- **MEGA upload with `react-native-mega`** — direct login/upload from the
  device (no host endpoint), chunked streaming transfers with MAC
  verification, batched uploads (`BatchSize`), retry state (`MaxRetries`),
  500 MB file limit, temp path `/temp/uploads/{deviceId}/{fileName}` encoded to
  the host's root-level physical name, manual Upload screen (document picker →
  hash → dedup → batch → publish).
- **Kafka proxy transport** — `kafka_proxy_vercel/` Vercel Function produces
  with the native Confluent client, and the app **polls** `GET /api/messages`
  for upload responses (de-duplication, backoff, token refresh).
- **Kafka REST transport (fallback)** — Confluent REST Proxy v3 produce (record headers:
  `X-Message-Version`, `Authorization`, `X-Correlation-Id`, `X-Device-Id`,
  `X-User-Id`) and v2 consume for upload responses, correlation IDs, status
  transitions to `Processing`/`Completed`/`Failed`, and dead-letter production
  when retries are exhausted.
- **Background upload pass** — the documented 15-minute AppState-aware
  interval (`BackgroundUpload:IntervalMinutes`, max 50 files per run): scan →
  dedup → filter candidates → batch upload → publish → status bookkeeping.
  Runs on pull-to-refresh in Files as well.
- **Screens** — Login, Register, Main shell with **Files / Upload / Folders /
  Settings / About** tabs, status chips with the documented colors, empty
  states, snackbar toasts, and a Settings readout of the effective config.

## Run

See **[docs/SETUP_AND_USAGE.md](docs/SETUP_AND_USAGE.md)** for the full
setup, configuration, usage, backend-contract and troubleshooting guide.

The MEGA client is the sibling package `../react-native-mega`, linked with
`file:../react-native-mega`. Build it once (and after changing its `src/`)
before installing or starting the app:

```bash
cd ../react-native-mega && npm install && npm run build
cd ../react_native_stash
npm install
npx expo start          # dev server (scan QR with Expo Go)
npx expo start --web    # web (metro.config.js adds wasm + COOP/COEP headers)
npx tsc --noEmit        # typecheck
npx expo export --platform web   # static web build -> dist/
```

## Configuration

- `src/config/appconfig.json` holds non-secret defaults (topics, timeouts, batch sizes).
- Secrets and machine-specific endpoints are supplied through `EXPO_PUBLIC_*` variables in a local `.env` file (git-ignored); see `.env.example`.

| Area | Environment variables |
| --- | --- |
| Identity | `EXPO_PUBLIC_IDENTITY_API_BASE_URL` |
| Kafka | `EXPO_PUBLIC_KAFKA_BOOTSTRAP_SERVERS`, `EXPO_PUBLIC_KAFKA_USERNAME`, `EXPO_PUBLIC_KAFKA_PASSWORD`, `EXPO_PUBLIC_KAFKA_REST_URL`, `EXPO_PUBLIC_KAFKA_REST_USERNAME`, `EXPO_PUBLIC_KAFKA_REST_PASSWORD`, `EXPO_PUBLIC_KAFKA_CLUSTER_ID`, `EXPO_PUBLIC_KAFKA_PROXY_BASE_URL` |
| MEGA | `EXPO_PUBLIC_MEGA_EMAIL`, `EXPO_PUBLIC_MEGA_PASSWORD`, `EXPO_PUBLIC_MEGA_SECOND_FACTOR_CODE` |
| App Insights | `EXPO_PUBLIC_APPINSIGHTS_CONNECTION_STRING` |

Copy `.env.example` to `.env` and fill in real values, then restart the dev server: Expo inlines these variables into the bundle at build time.

Non-secret settings stay in `appconfig.json`:

| Section | Purpose |
| --- | --- |
| `IdentityApiTimeoutSeconds` | Identity API request timeout |
| `Kafka.Proxy.*` (except `BaseUrl`) | Proxy polling interval/timeout and page size |
| `Kafka.RestTimeoutSeconds` | REST proxy request timeout |
| `Kafka.Topic*` | Upload request/response and dead-letter topics |
| `Auth.Jwt.*` | Expected token issuer and audience |
| `Storage.Provider` | Storage provider label |
| `UploadSettings` | `BatchSize`, `MaxRetries`, `MaxFileSizeBytes` |
| `BackgroundUpload` | `Enabled`, `IntervalMinutes` (15), `MaxFilesPerRun` (50) |
| `ApplicationInsights.Enabled` | Telemetry flag |

**Never commit `.env`.** `EXPO_PUBLIC_*` values are inlined into the client bundle, so use scoped/limited credentials and rotate anything that was previously committed.

## Structure

```
src/
  auth/        Identity API client + AuthContext (session restore)
  components/  AppButton, FormInput, dialogs, cards, toasts (MAUI styles.xaml parity)
  config/      appconfig.json + typed StashConfig
  data/        SQLite schema + File/Folder repositories
  models/      entities, messages, upload status contract, media patterns
  navigation/  Root stack (Login/Register/Main) + 5-tab Main shell
  screens/     Login, Register, Files, Upload, Folders, Settings, About
  services/    scanner, MEGA client (react-native-mega) + file adapters,
               upload manager, Kafka producer/consumer, background pass +
               scheduler, singletons
  theme/       colors.ts (palette), typography (OpenSans), ThemeContext
  utils/       storage, base64, formatting, ids, MEGA name mapping
```

## Notes

- Background execution uses the documented polling fallback (no native
  background modules): a timer fires only while the app is `active`.
- Expo Router is not used; navigation is React Navigation (native-stack +
  bottom-tabs) to match the plan's auth-gated shell.
- MEGA transfers are chunked (128 KB–1 MB) on native, so uploads no longer
  buffer whole files in memory. Web reads the picked Blob in memory because
  expo-file-system has no web implementation.
- The integration design and phase log live in
  [`../ReactNativeMegaStashIntegrationPlan.md`](../ReactNativeMegaStashIntegrationPlan.md).
