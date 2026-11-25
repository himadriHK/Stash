# Local setup-and-run

`node scripts/setup-and-run.mjs` prepares and starts the Stash local stack from a
single command: it collects configuration, writes every value into the selected
projects' `.env` files and the React Native app's `appconfig.json`, installs
dependencies, runs build/validation checks, then launches the Kafka proxy
(Identity API), the host service, and Expo with health checks.

## Prerequisites

- Node.js >= 22.18 (the script refuses to run on older versions) and npm.
- Optional: Docker, for a local MongoDB (`mongo:7` container named `stash-mongo`,
  published on loopback only).
- Optional: Kafka (Aiven/Confluent) broker, SASL credentials, and S3 credentials
  for full upload flows.
- FFmpeg is bundled for the host via `ffmpeg-static`; no separate install needed.

## Quick start

From the repo folder that contains `kafka_proxy_vercel`, `stash_host_node`, and
`react_native_stash`:

```powershell
cd Stash
node scripts/setup-and-run.mjs
```

Other common invocations:

```powershell
node scripts/setup-and-run.mjs --yes                 # non-interactive, defaults + existing .env
node scripts/setup-and-run.mjs --dry-run --yes       # print the plan, write/start nothing
node scripts/setup-and-run.mjs --only=proxy,host     # subset of the stack (all phases scoped)
node scripts/setup-and-run.mjs --platform=android    # web | android | ios
```

In a non-TTY/CI environment, `--dry-run` requires `--yes`; without it the interactive TTY error is returned.

## Flags

| Flag | Meaning |
| --- | --- |
| `-h`, `--help` | Show usage and exit. |
| `--dry-run` | Preview `.env` values and every planned install, build, directory, port preflight, and service command; writes nothing, starts nothing. In a non-TTY/CI environment it requires `--yes`. |
| `-y`, `--yes` | Non-interactive: use existing `.env` values and defaults; disables S3 when its bucket/keys are missing and Kafka when no broker is configured (with a warning; it does not invent `localhost:9092`), and regenerates an invalid (<32 character) JWT key. Existing broker/S3 credential values are preserved in the written files. Docker is never started in this mode (warning only). |
| `--skip-install` | Skip `npm install` for the selected projects. |
| `--skip-build` | Skip build/validation checks (proxy typecheck, host build, Expo typecheck). |
| `--skip-run` | Do not start any services. |
| `--platform=<target>` | `web`, `android`, or `ios` (default `web`); passed to Expo. |
| `--only=<targets>` | Comma-separated subset of `proxy,host,expo` (default all); scopes **everything** — `.env` writes, installs, checks, host runtime directories, Mongo readiness (proxy), and services. |

Unknown flags exit nonzero with a hint to run `--help`.

## What gets written

Every key each project reads gets a concrete value, so no blank template entry is
left behind; the `.env.example` file still supplies comments and key order. An
existing file is copied to `.env.bak-<timestamp>`, the new content is written to a
temp file with owner-only permissions (0600 on POSIX), then renamed into place. On
Windows a fallback unlink + rename may be used, restoring from the backup on
failure — do not treat the Windows path as strictly atomic.

| File | Keys written | Source |
| --- | --- | --- |
| `kafka_proxy_vercel/.env` | `KAFKA_BOOTSTRAP_SERVERS`, `KAFKA_SECURITY_PROTOCOL`, `KAFKA_SASL_MECHANISM`, `KAFKA_USERNAME`, `KAFKA_PASSWORD`, `KAFKA_CLIENT_ID`, Kafka timeouts/consumer tuning, `MONGODB_URI`, `MONGODB_DATABASE`, `JWT_SIGNING_KEY`, `JWT_ISSUER`, `JWT_AUDIENCE`, `AUTH_*`, `ALLOWED_PRODUCE_TOPICS`, `ALLOWED_CONSUME_TOPICS`, `CONSUMER_GROUP_PREFIX`, `CORS_ALLOWED_ORIGINS`, `MAX_BODY_BYTES`, `POLL_TIMEOUT_MS`, `HOST`, `PORT` | Prompts / existing `.env` / defaults |
| `stash_host_node/.env` | Runtime (`NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL`, `DB_PATH`, `LOCAL_ROOT_PATH`, `TEMP_DIR`), all `KAFKA_*` settings and topics, all `S3_*` settings, all `JWT_*` settings, worker/lease/retry/timeout tuning, media (`FFMPEG_*`, quality, decoder) settings, dashboard and metrics settings | Shared values from the proxy/S3 answers; tuning preserved from the existing `.env` |
| `react_native_stash/.env` | `EXPO_DEV_PORT`, `EXPO_PUBLIC_IDENTITY_API_BASE_URL`, `EXPO_PUBLIC_KAFKA_PROXY_BASE_URL`, `EXPO_PUBLIC_S3_*` (including credentials and presign expiry), `EXPO_PUBLIC_UPLOAD_MAX_HOST_RETRIES` | Derived from the proxy/S3/Expo-port answers |
| `react_native_stash/src/config/appconfig.json` | Every setting the app reads: Identity base URL/timeout, Kafka topics and proxy tuning, `Storage.Provider`, all `Storage.S3.*` including credentials, `UploadSettings.*`, `BackgroundUpload.*` | Same collected values; existing file values are the defaults for app-only tuning |

Secrets (JWT key, Kafka/S3 credentials, MongoDB URI, dashboard password) are
stored in the `.env` files, and the S3 credentials are also written into
`appconfig.json`, which is tracked by git — do not commit real credentials.
`.env` is gitignored in all three projects; `stash_host_node` also ignores
`.env.bak*`. A blank JWT signing key generates a fresh 48-character one, and
`--yes` regenerates an invalid key shorter than 32 characters. When dashboard auth
is enabled without a password in non-interactive mode, a random one is generated
and printed once.

Disabling Kafka or S3 only sets the host `KAFKA_ENABLED`/`S3_ENABLED` flags to
`false`; existing broker and S3 credential values are preserved in the proxy/host
`.env` files. The Expo `EXPO_PUBLIC_S3_*` values are preserved/populated even when
host S3 staging is disabled, so re-enabling it does not require re-entering them.

In `--yes` mode, S3 is disabled when bucket/access key/secret are missing, and
Kafka is disabled when `KAFKA_BROKERS` is empty, because the host refuses to boot
with those features enabled but unconfigured. A disabled Kafka integration is
reported as a warning; the script does not invent `localhost:9092` (interactive
mode still defaults to it). S3 credentials are read only from existing project
`.env` files, not from ambient environment variables. Docker is never
auto-started. A relative `LOCAL_ROOT_PATH` is resolved against the user's home
(falling back to `~/StashLibrary`).

The Kafka security protocol is validated against
`PLAINTEXT|SSL|SASL_PLAINTEXT|SASL_SSL`, and the mechanism against
`plain|scram-sha-256|scram-sha-512`. Username/password are prompted and written
only for `SASL*` protocols (`PLAINTEXT`/`SSL` write empty credentials).
`KAFKA_SSL` is `true` for `SSL`/`SASL_SSL` and `false` for
`PLAINTEXT`/`SASL_PLAINTEXT`; the proxy now uses the same mapping, so its
`SASL_PLAINTEXT` path no longer enables TLS.

The Expo port is prompted before CORS and persisted in `react_native_stash/.env`
as `EXPO_DEV_PORT` (setup metadata; passed to Expo via `--port`). The default CORS
origin is derived from that port (`http://localhost:<expoPort>`) unless existing
origins already cover it (including `*`).

`EXPO_PUBLIC_S3_*` values are inlined into the Expo bundle at build time, so use
scoped credentials; the script redacts them in its own output. Stored secret
defaults for the JWT signing key, Kafka password, S3 access key/secret/session
token, MongoDB URI, and dashboard password display `[set]` instead of the raw
value; characters typed at the prompt are still echoed visibly (readline
limitation).

For the launched services, generated project `.env` values take precedence over
ambient shell variables: the script strips keys present in `.env` from each
child's environment.

## What runs and where

| Service | Default URL | Notes |
| --- | --- | --- |
| Proxy + Identity (`kafka_proxy_vercel`) | http://localhost:3000 | `/api/health`, `/api/auth/health`, `/api/messages` |
| Host (`stash_host_node`) | http://localhost:8080 | `/` dashboard, `/settings` settings editor, `/api/health` |
| Expo (`react_native_stash`) | http://localhost:8081 | `--web`/`--android`/`--ios` passed through |

**Open the dashboard.** After the host starts, open `http://localhost:<hostPort>/`
(default `http://localhost:8080/`); settings are at `/settings`. The settings page
writes `stash_host_node/.env` atomically (keeping `.env.bak`) and requires a host
restart for every setting except `LOG_LEVEL`, which is live. Set
`DASHBOARD_AUTH_ENABLED=true` (plus `DASHBOARD_USER` and a >=12-character
`DASHBOARD_PASSWORD`) to require HTTP Basic auth for the UI and APIs;
`/health/live` stays open.

The proxy and host ports are configurable during setup and written into their
`.env` files as `PORT`. Expo is the exception: its port lives in
`react_native_stash/.env` as `EXPO_DEV_PORT` and is passed to Expo CLI as `--port`.
Duplicate ports among selected services are rejected, and before launch the script
checks each selected port is free, failing with a clear message if occupied;
`--dry-run` prints the planned checks instead. The final summary prints
the host dashboard at `http://localhost:<hostPort>/` plus
`http://localhost:<expoPort>` for Expo, matching CORS and the RN base URLs.

MongoDB readiness uses the URI's host/port. Docker is offered only for local
hosts (`localhost`, `127.0.0.1`, `::1`); remote hosts get a warning instead. The
container publishes on loopback only (`-p 127.0.0.1:<port>:27017`), so it is not
exposed on the LAN, and `--yes` never starts Docker.

The proxy is launched directly as
`node --experimental-strip-types scripts/local-server.ts` (the `npm run dev:local`
script is the same command), a plain Node HTTP server that mirrors the Vercel
functions: no Vercel login/link or CLI is needed, and Kafka is loaded lazily so
auth and health routes work without a broker. The standalone server enforces a
transport body cap from `MAX_BODY_BYTES` (default 1 MiB, clamped 1 KiB–8 MiB)
while streaming, so over-limit requests get HTTP 413 instead of being fully
buffered; route-specific limits still apply. On Ctrl+C/SIGTERM it closes
connections and force-exits even after Mongo/Kafka clients were created, and the
orchestrator waits longer than its POSIX SIGKILL escalation so children are not
orphaned.

The host runs `npm start` when `stash_host_node/dist/server/index.js` exists (the normal
case after a build), otherwise it falls back to `npm run dev` with a warning.

Health checks run after launch and never stop services: any 2xx response is `ok`; a
reachable non-2xx response is `unhealthy (HTTP <status>)` for the proxy, host, and
Expo (for example a host `/api/health` 503); no response within the timeout is
`timeout`.

## Build gates

- Proxy: `npm run typecheck` (`tsc --noEmit`)
- Host: `npm run build` (`tsup`)
- Expo: `npm run typecheck` (`tsc --noEmit`)

`--skip-build` bypasses all three. `--skip-install` bypasses dependency install.

## Re-run fast path

After the first successful run, skip installs and checks:

```powershell
node scripts/setup-and-run.mjs --skip-install --skip-build
```

## Troubleshooting

- **Prompts require a TTY**: without `--yes`, run in an interactive terminal, or
  add `--yes` to use existing values and defaults. This includes `--dry-run` in
  CI/non-TTY, which returns the interactive TTY error without `--yes`.
- **JWT signing key**: if provided manually it must be at least 32 characters;
  leave it blank to generate one.
- **S3 disabled in `--yes`**: set `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and
  `S3_SECRET_ACCESS_KEY` in the existing project `.env` files to keep it on
  (ambient environment variables are not read).
- **Kafka disabled in `--yes`**: `KAFKA_BROKERS` (or `KAFKA_BOOTSTRAP_SERVERS`) is
  empty, so no `localhost:9092` fallback is written; set a broker in the existing
  project `.env` files to keep Kafka on.
- **MongoDB not running**: start `mongod` or Docker. Docker is offered only for
  local Mongo hosts; remote hosts get a warning. `--yes` never starts Docker.
- **Port in use**: the pre-launch check fails before anything starts; free the port
  or re-run and choose another proxy/host/Expo port. Duplicate selections are
  rejected during setup.
- **Kafka Aiven/Confluent errors**: check the CA/SASL settings. The protocol must be
  `PLAINTEXT`, `SSL`, `SASL_PLAINTEXT`, or `SASL_SSL`, the mechanism `plain`,
  `scram-sha-256`, or `scram-sha-512`, and credentials are only written for `SASL*`
  protocols. Security protocol defaults to `SASL_SSL`.
- **`/api/messages` returns 500**: Kafka is unset or unreachable; `/api/health`
  and `/api/auth/health` still work.
- **Native device builds**: devices need LAN URLs (not `localhost`) and an open
  firewall on the proxy/host/Expo ports.
- **Health statuses**: `unhealthy (HTTP <status>)` means the service answered with
  a non-2xx status; `timeout` means it did not answer in time. Neither stops the service.
- **Secret prompts**: stored defaults for the JWT signing key, Kafka password, S3
  access key/secret/session token, and MongoDB URI show `[set]`; characters typed
  at the prompt are echoed visibly (readline limitation).
- **Ambient shell variables are ignored**: for launched services, keys present in the
  generated `.env` files override the shell; edit `.env` to change them.
- **Missing manifest after checkout**: the repo root ignores all `package.json` and
  `.gitignore` files; when adding one, stage it with `git add -f`.

`StashHost.Functions` (.NET) is not modified or started by this script.
