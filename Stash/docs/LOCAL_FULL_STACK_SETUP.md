# Stash — Local Full-Stack Setup & Run Guide (React Native UI)

> **Compatibility warning — the React Native client now uses S3.**
> The RN app uploads temporarily to **S3** (presigned SigV4 `PUT` generated on
> the device) and publishes upload requests as **message version 2** with
> `storageTempPath` and `storageProvider: "S3"`.
> The host steps in this runbook still describe the repository's **MEGA** staging
> provider (`Storage:Provider=Mega`) and a **version-1 validator** that expects
> `megaTempPath`. As written, the host rejects the new client's messages and
> cannot read the S3 object.
> To run the flow end-to-end, the host must implement/configure S3 and accept
> version 2. See
> [react_native_stash/docs/SETUP_AND_USAGE.md §4.4](../react_native_stash/docs/SETUP_AND_USAGE.md#44-storage-s3)
> and [§11](../react_native_stash/docs/SETUP_AND_USAGE.md#11-backend-contract-summary).
> For the client-side architecture and data flow, see
> [react_native_stash/docs/ARCHITECTURE.md](../react_native_stash/docs/ARCHITECTURE.md).
> The backend/MEGA setup sections remain accurate for the repository's current
> host path; client-specific sections are updated to S3.

This runbook takes a clean Windows machine to a **locally running Stash backend and RN client**:

- the **React Native (Expo) UI** in `react_native_stash/` as the only client,
- the **Identity API** (`StashHost.IdentityApi` locally, or the Vercel function in `kafka_proxy_vercel/`),
- the **host backend** (`StashHost.Functions`, Durable Functions + Kafka trigger) running locally,
- **MongoDB** and **Azurite** running locally, plus the **Stash Kafka proxy**
  (`kafka_proxy_vercel/`, or the local Node server the setup script starts),
- and external services: **S3** (client upload staging), **MEGA** (the
  repository backend's staging provider) and **Aiven for Apache Kafka** (broker).

Everything else — database, orchestration storage, broker gateway — is a local process or
container. No Azure subscription, Application Insights, Key Vault, Confluent Cloud or hosted API is
required. The RN client writes to S3 directly with presigned URLs, so no upload bridge process is
part of the client path. The repository backend still stages to MEGA; that is the legacy side of
the mismatch described above.

> **Why the Stash Kafka proxy?**
> The React Native client never talks to Kafka directly. It produces and polls through the
> **Stash Kafka proxy** (`kafka_proxy_vercel/`, or the local Node server started by
> `scripts/setup-and-run.mjs`), which holds the broker credentials and filters responses per
> device/user.
>
> **S3 needs no upload bridge.** The RN app presigns a `PUT` with
> `react_native_stash/src/services/storage/s3Signing.ts` and streams the file to the
> configured bucket with `s3Transfer.ts`; no host upload endpoint is involved.
> The backend must still be taught to read that bucket and accept version 2
> before its processing loop can consume the new client's messages. The MEGA
> bridge mentioned later is legacy and is not part of the current client path.

---

## Automated quick start

`scripts/setup-and-run.mjs` (at the Stash repo root: the folder holding `kafka_proxy_vercel/`,
`stash_host_node/`, `react_native_stash/` and `docs/`) automates most of this runbook:

```bash
node scripts/setup-and-run.mjs          # interactive
node scripts/setup-and-run.mjs --help   # every flag
```

> **Scope.** This automated path runs the **Node host (`stash_host_node`)**, not the legacy .NET
> `StashHost.Functions` described from §7 on (that part of the runbook is unchanged). It also
> serves the Identity API and Kafka proxy with a plain Node server instead of `vercel dev`; the
> deployed Vercel functions are unchanged.

What it does:

1. **Prompts** for all required configuration and writes gitignored `.env` files for the
   selected projects, backing up any existing file as `.env.bak-<timestamp>`:
   - `kafka_proxy_vercel/.env` — Kafka, Mongo, JWT, CORS, host/port
   - `stash_host_node/.env` — bind/port, DB path, library root, Kafka, S3, JWT
   - `react_native_stash/.env` — identity/proxy URLs, S3 public config, `EXPO_DEV_PORT`
   Disabling Kafka/S3 only flips `KAFKA_ENABLED`/`S3_ENABLED` to `false`; existing
   broker/S3 values (and Expo `EXPO_PUBLIC_S3_*`) are preserved. Kafka protocol and
   mechanism are validated, and credentials are written only for `SASL*` protocols.
   Existing secret defaults for the JWT signing key, Kafka password, S3 access
   key/secret/session token, and MongoDB URI show `[set]`; characters typed at the
   prompt are still echoed visibly (readline limitation).
2. **Installs** dependencies and runs the build gates for the selected projects:
   `kafka_proxy_vercel` typecheck, `stash_host_node` build, Expo typecheck.
3. **Launches** the services, waits for health checks, and cleans up on Ctrl+C:
   - Identity API + Kafka proxy — started directly as
     `node --experimental-strip-types scripts/local-server.ts` in `kafka_proxy_vercel`
     (`npm run dev:local` is the same command) on `http://localhost:3000` (plain Node
     server, no Vercel CLI/login; routes `/api/health`, `/api/auth/health`, `/api/messages`).
     It caps streamed bodies via `MAX_BODY_BYTES` (default 1 MiB, clamped 1 KiB–8 MiB),
     returns HTTP 413 over the cap, and on shutdown closes connections and force-exits
     even after Mongo/Kafka clients exist.
   - Node host — `stash_host_node` on `http://localhost:8080` (`/` dashboard,
     `/settings`, `/api/health`, `/api/dashboard/stream`); runs `npm start` when
     `dist/server/index.js` exists, otherwise `npm run dev`
   - Expo UI — web on `http://localhost:8081`, or `--platform=android|ios`

After the host starts, open the dashboard at `http://localhost:8080/` (or
`http://localhost:<hostPort>/` when the port was changed); settings are at
`/settings`. The settings page writes `stash_host_node/.env` atomically (keeping
`.env.bak`) and requires a host restart for every setting except `LOG_LEVEL`,
which applies immediately. `DASHBOARD_AUTH_ENABLED=true` (with a user and a
>=12-character password) adds HTTP Basic auth for the UI and APIs; `/health/live`
stays open. The dashboard updates live over SSE (`/api/dashboard/stream`, about
every 2 seconds), and its health card reports `database`, `temp_dir`, and `config`;
Kafka/S3 connectivity is handled by the pipeline, not the host probe.

Health checks report any 2xx as ok, a reachable non-2xx as `unhealthy (HTTP <status>)`
for the proxy, host, and Expo, and no response within the timeout as `timeout`; they
never stop services. `--only` limits all phases — env files, installs, build checks,
host directory creation, Mongo readiness, and services — not just which services start.

Duplicate ports among selected services are rejected, and each selected port is checked
to be free before launch (failure is a clear pre-launch error; `--dry-run` prints the
planned checks). Proxy/host ports persist as `PORT`; the Expo port is stored as
`EXPO_DEV_PORT` (setup metadata) and passed to Expo via `--port`, and the default CORS
origin is derived from it. The final summary prints the host dashboard URL plus
`http://localhost:<expoPort>`, matching CORS and the RN base URLs.

When MongoDB is unreachable, Docker is offered only for local hosts (`localhost`,
`127.0.0.1`, `::1`); remote hosts get a warning. The container publishes on loopback
only (`-p 127.0.0.1:<port>:27017`), so it is not exposed on the LAN, and `--yes` never
starts Docker. Generated `.env` values override ambient shell variables for the launched
services (the script strips those keys from child environments).

Prerequisites: **Node ≥ 22.18**, npm, Docker (optional, for the local Mongo), and Kafka/S3
credentials for the full upload flow.

| Flag | Effect |
|---|---|
| `--dry-run` | Preview `.env` values and planned installs/builds/port checks/services; writes and starts nothing. In CI/non-TTY it requires `--yes` |
| `--yes` | Use existing values/defaults without prompting; disables S3 when credentials are missing and Kafka when no broker is configured (warning; no invented `localhost:9092`); preserves existing credential values; never starts Docker |
| `--skip-install`, `--skip-build`, `--skip-run` | Skip that phase |
| `--platform=web\|android\|ios` | Expo target (default `web`) |
| `--only=proxy,host,expo` | Limit all phases (env files, installs, build checks, host directory creation, Mongo readiness) and services to the listed projects |

Fast rerun once configured: `node scripts/setup-and-run.mjs --skip-install --skip-build`.
Full details and troubleshooting: [`scripts/README.md`](../scripts/README.md).

---

## 1. What runs, and on which port

| # | Component | How it runs | Address | Needed for |
|---|-----------|-------------|---------|------------|
| 1 | MongoDB | Docker (`mongo:7`) | `mongodb://localhost:27017` | Identity API users/devices/refresh tokens |
| 2 | Identity API (local .NET or Vercel function) | `dotnet run` or Vercel deployment | `http://localhost:5102` (local) or `https://<vercel-project>.vercel.app` | Register / login / refresh / revoke |
| 3 | Azurite (Azure Storage emulator) | Docker | `127.0.0.1:10000-10002` | Durable Functions state, `AzureWebJobsStorage` |
| 4 | StashHost.Functions | `dotnet run` (Core Tools host) | `http://localhost:7071` | Kafka trigger + Durable orchestration + `/api/health` |
| 5 | Stash Kafka proxy | Vercel function or local Node server | `http://localhost:3000` (local) | RN produce and poll (`/api/messages`) |
| 6 | Mega REST bridge (legacy, optional) | `node` | `http://localhost:8090` | Only for old MEGA-era app builds; the current S3 client never calls it |
| 7 | React Native UI | Expo / Metro | `http://localhost:8081` | The client under test |
| 8 | **Amazon S3 / S3-compatible** (external) | SaaS or self-hosted | bucket endpoint | Client upload staging (new RN client) |
| 9 | **MEGA** (external, backend) | SaaS | `mega.nz` | The repository backend's staging (`/temp/...`) and thumbnails; legacy relative to the new client |
| 10 | **Aiven Kafka** (external) | SaaS | `<host>:<port>` (SASL_SSL) | `stash.upload.request`, `stash.upload.response`, `stash.dlq` |
| 11 | **Local media library** | Host filesystem (`Storage:Local:RootPath`) | e.g. `D:\StashLibrary`, `\\nas\photos\stash` | Permanent copy of every processed upload (images/JPEG, videos/MP4) |

### 1.1 Data flow (what actually happens on an upload)

```
┌────────────────────────────┐
│ React Native UI (8081)     │
│  • scan folder → SHA-256   │
│  • presigned PUT to S3     │──────────────► S3 bucket
│  • produce v2 record       │                key: [Prefix/]temp/uploads/…
│    to stash.upload.request │
└─────────┬──────────────────┘
          │ POST /api/messages
          ▼
   Stash Kafka proxy ──► Aiven Kafka ──► StashHost.Functions (7071)
                                                 │ Repository host today:
                                                 │ validator accepts version 1
                                                 │ and megaTempPath only, so it
                                                 │ rejects the v2 request (DLQ).
                                                 ▼
                                        Durable orchestration
                                 Download → Hash → Dedup → Convert →
                                 Thumbnails(128/256/512) → Store permanent (local disk) →
                                 Delete temp → Send response
                                                 │
                                                 ▼
                                   stash.upload.response ──► Stash proxy ──► RN consumer
                                   (RN sets the local file status)
```

The diagram shows the intended flow. With the repository host as checked in, the
version-1 validator rejects the new client's v2 request before the orchestration
starts, so the processing and response steps cannot run until S3 and version-2
support are added on the host.

Storage layout produced by the backend (`StashHost.Functions/Activities/StoragePathBuilder.cs`). The
first row is the new S3 client staging path; the MEGA rows are the repository backend's
current/legacy layout:

| Purpose | Logical path | Physical location |
|---|---|---|
| Temp upload (new S3 client) | `/temp/uploads/{deviceId}/{fileName}` | **S3**: `[Storage.S3.Prefix/]temp/uploads/{deviceId}/{fileName}` |
| Temp upload (repository backend, legacy) | `/temp/uploads/{deviceId}/{fileName}` | MEGA: `temp_uploads_{deviceId}_{name}_{hash8}{ext}` |
| Permanent copy | `/backups/{userId}/{sha256}.{ext}` (`jpg` after image conversion, `mp4` after video conversion) | **Local library disk**: `{Storage:Local:RootPath}\backups\{userId}\{sha256}.{ext}` |
| Thumbnails | `/thumbs/{userId}/{128\|256\|512}/{sha256}.jpg` | MEGA: `thumbs_{userId}_{size}_{sha256}_{hash8}.jpg` |

The permanent copy never goes to MEGA: `StorePermanentActivity` always asks the storage factory for the
`Local` provider (`StashHost.Shared/Services/LocalStorageProvider.cs`), whatever `Storage:Provider` says.
MEGA is only the backend's staging area for the upload in flight (deleted after processing) plus the
thumbnail store. With the new client the temp object is in S3, so the host also needs S3 delete support.

The **physical name** rule for MEGA objects (temp uploads and thumbnails) is produced by the backend's
MEGA writer, `StashHost.Shared/Services/MegaPathMapper.cs`: every path
segment except the last is sanitised (`[A-Za-z0-9._-]`, everything else → `_`), joined with `_`,
truncated to 180 chars, then suffixed with `_<first 8 hex of SHA-256 of the normalised path>` before
the extension. The RN app no longer ports this mapping: it stores and sends the logical
`storageTempPath` and leaves bucket-key mapping to the host. The legacy bridge in Appendix A mirrors
the MEGA rule for old builds only.

---

## 2. Prerequisites

Verified on this machine (Windows 11, Git Bash):

| Tool | Version that worked | How to check | Notes |
|---|---|---|---|
| .NET SDK | **10.0.403** | `dotnet --version` | Both host projects target `net10.0` |
| Node.js | **24.16.0** | `node -v` | Functions host, Expo, (legacy bridge) |
| npm | **12.2.0** | `npm -v` | npm ≥ 12 blocks lifecycle scripts by default — see 2.1 |
| Docker Desktop | **29.9.2** | `docker --version` | MongoDB, Azurite |
| Azure Functions Core Tools | **4.16.0** | `func --version` | Required for Durable + Kafka extensions; **≥ 4.13** for .NET 10 |
| FFmpeg | **9.0.1** | `ffmpeg -version` | MOV→MP4 conversions (`STASH_FFMPEG_PATH`) |
| Git Bash / PowerShell | — | — | Examples use Git Bash |

Accounts you must own:

- **Aiven for Apache Kafka** service (free/starter tier is enough): bootstrap host `host:port`,
  a service user with SCRAM-SHA-256 credentials, and ACLs allowing produce/consume on the three topics.
- **S3 bucket** (AWS or an S3-compatible provider) with credentials that can
  `PutObject`, `GetObject`, `HeadObject` and `DeleteObject` on the client prefix.
  The new RN app writes here; this is not used by the repository backend yet.
- **MEGA** account with enough space for your test files, and its email/password.
  This is for the repository backend's current staging provider (legacy relative
  to the S3 client), not for the new RN upload path.

### 2.1 Installing Azure Functions Core Tools on Windows

The MSI/winget route is the documented one and avoids Node entirely:

```powershell
winget install --id Microsoft.Azure.FunctionsCoreTools --exact
func --version      # expect 4.13.0 or newer (4.16.0 verified here)
```

If you prefer npm, note that **npm 12 refuses to run the package's postinstall** (which downloads the
CLI), so `func` exists but crashes with *"Azure Functions Core Tools binary not found"*:

```bash
npm install -g --allow-scripts=azure-functions-core-tools azure-functions-core-tools@4
func --version
```

If the postinstall is still skipped, finish the download manually (paths are the ones npm reports):

```bash
cd "$(npm config get prefix)/node_modules/azure-functions-core-tools/bin"
unzip -o Azure.Functions.Cli.win-x64.4.16.0.zip
./func --version
```

Do not mix MSI and npm installs — the MSI wins on `PATH` and version conflicts follow. Check with
`where func`.

### 2.2 Git Bash quirk (Windows)

Git Bash rewrites `/opt/...` inside `docker exec` into `C:/…`. Prefix container paths with `//`
(`docker exec stash-kafka //opt/kafka/bin/kafka-topics.sh …`) or set `MSYS_NO_PATHCONV=1`.

---

## 3. External service setup

### 3.1 Aiven for Apache Kafka

1. Create (or reuse) an **Aiven for Apache Kafka** service. Copy **Service URI** (bootstrap servers),
   which looks like `kafka-<project>-<service>.aivencloud.com:<port>`. SASL and client certificates
   use **different ports**, so copy the SASL one.
2. **Enable SASL** on the service (Console → service → *Service settings* → *Advanced configuration*
   → `kafka_authentication_methods.sasl` = *Enabled*; CLI: `avn service update <svc> -c
   kafka_authentication_methods.sasl=true`). SCRAM-SHA-256 is enabled by default. Without this the
   Functions host connects, fails authentication and the trigger stays dead.
3. Create a **service user** (Service users → add) and copy username/password. Aiven uses
   **SASL_SSL + SCRAM-SHA-256** — exactly what `StashHost.Functions` uses.
4. **Trust the broker certificate.** Aiven brokers are signed by the **project CA** (`ca.pem` in the
   console) by default. `StashHost.Functions` uses librdkafka, which only sees the OS trust store, so
   either:
   - enable *public CA certificates* for the service (Console → *Service settings*), which makes the
     normal OS/Java trust stores sufficient — simplest, and what §9 assumes; or
   - download `ca.pem` and import it into the Windows *Trusted Root Certification Authorities* store
     (`certmgr.msc` → Import) for the Functions host, and mount it as a PEM truststore for the REST
     proxy (§9).
5. **Kafka version caveat:** with Aiven Kafka **4.x**, SCRAM-SHA-256 requires **librdkafka ≥ 2.6.1**.
   `StashHost.Functions` pins `Confluent.Kafka 2.6.0`; if your service is 4.x and the host logs SASL
   handshake failures, either create a 3.x service or bump that package (also update
   `KafkaProducer`'s client accordingly).
6. Create the three topics. Either the console (Topics → Create topic) or `kafka-topics` with the CA
   certificate from the console:

   ```bash
   # Git Bash, using the Aiven CA certificate downloaded from the console
   docker run --rm -v "$PWD/ca.pem:/certs/ca.pem" --network host \
     apache/kafka:3.9.0 //opt/kafka/bin/kafka-topics.sh \
     --bootstrap-server <host>:<port> \
     --command-config /certs/client.properties \
     --create --topic stash.upload.request --partitions 3 --replication-factor 3
   ```

   with `client.properties`:

   ```properties
   security.protocol=SASL_SSL
   sasl.mechanism=SCRAM-SHA-256
   sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="<user>" password="<pass>";
   ssl.ca.location=/certs/ca.pem
   ```

   Repeat for `stash.upload.response` and `stash.dlq` (1 partition is fine for `stash.dlq`).
7. ACLs, in production terms: the Functions user needs **consume** on `stash.upload.request` and
   `stash.dlq`, **produce** on `stash.upload.response` and `stash.dlq`; the Stash Kafka proxy's
   Kafka user needs **produce** on `stash.upload.request`/`stash.dlq` and **consume** on
   `stash.upload.response`. Simplest local arrangement: reuse one service user with all of those.

### 3.2 MEGA (backend staging; legacy relative to the S3 client)

> The new RN client uploads to S3, not MEGA. This section configures the
> repository backend's MEGA provider, which is still used for the backend's
> current version-1 flow, temp staging and thumbnails.

1. Create a MEGA account (`https://mega.nz/register`).
2. Use an **empty account** for development: the backend stages uploads and writes thumbnails into
   the account **root** using the encoded physical names above, and `MegaPathMapper` cannot address
   sub-folders (see limitation L4). Permanent copies are **not** written to MEGA — they stay on the
   host's own disk under `Storage:Local:RootPath` (§8.2).
3. Keep a small test set (a JPEG, a PNG, a >2 MB video, one 400–600 MB file to exercise the size cap).

---

## 4. Repository map (what you will run)

```
Stash/
├── StashHost.IdentityApi/      # ASP.NET Core minimal API  (auth)
├── StashHost.Functions/        # .NET 10 isolated Azure Functions host (Kafka + Durable)
├── StashHost.Shared/           # messages, storage provider, path mapper
├── MegaConnectivity.Core/      # backend MEGA via megajs/node-api-dotnet (legacy relative to the S3 client)
├── Stash.Maui/, Stash.Maui.Data/, Flutter*, ...  # not used by this runbook
├── react_native_stash/         # the UI
│   ├── src/config/appconfig.json       # defaults (Storage.Provider = S3)
│   ├── src/services/storage/           # S3 provider, SigV4 presigner, transfers
│   ├── .env                            # secrets/endpoints (create from .env.example)
│   └── docs/SETUP_AND_USAGE.md         # client-only guide
├── scripts/                    # setup-and-run.mjs and its README
└── docs/LOCAL_FULL_STACK_SETUP.md      # this file
```

Shared configuration values that **must match in every component**:

| Value | Identity API (local .NET / Vercel) | Functions | RN app | Effect if it differs |
|---|---|---|---|---|
| JWT signing key | `Auth:Jwt:SigningKey` / `JWT_SIGNING_KEY` | `Auth:Jwt:SigningKey` | — | Kafka trigger rejects every message → DLQ |
| Issuer / audience | `stash-auth` / `stash-app` (local: `Auth:Jwt:Issuer`/`Audience`; Vercel: `JWT_ISSUER`/`JWT_AUDIENCE`) | same | `—` (the app does not validate issuer/audience) | JWT validation fails |
| Topic names | — | `KafkaTrigger("stash.upload.request")`, DLQ handler `stash.dlq`, producer `stash.upload.*` | `Kafka.Topic*` | Messages land where nobody listens |
| Message version | — | validator accepts `1` today | client publishes `2` | v2 requests are rejected until host support lands |
| S3 bucket/region/prefix | — | needs S3 support for v2 (not implemented) | `Storage.S3.*` | Host cannot read the client's temp object |
| Mega physical naming (legacy) | — | `MegaPathMapper` | — (RN client no longer maps names) | Only affects old MEGA-era clients/bridge builds |

---

## 5. Step 1 — MongoDB

```bash
docker run -d --name stash-mongo -p 127.0.0.1:27017:27017 mongo:7
docker ps --filter name=stash-mongo --format '{{.Status}}'   # Up … (healthy)
```

Publishing on loopback only (`127.0.0.1:27017:27017`) avoids exposing an unauthenticated MongoDB on the LAN.

No initialisation needed: `MongoUserStore` creates the unique email index on startup
(`users`, `devices`, `refresh_tokens` collections in database `stash`).

Reset the database at any time:

```bash
docker exec stash-mongo mongosh stash --eval 'db.dropDatabase()'
```

---

## 6. Step 2 — Identity API

### Option A — Local .NET Identity API

```bash
cd StashHost.IdentityApi
dotnet build
```

Start it with CORS opened for the Expo web client (this is the only change the local web UI needs;
the value is an environment override, so nothing in the repository changes):

```bash
# Git Bash
Cors__AllowedOrigins__0=http://localhost:8081 \
  dotnet run --urls http://localhost:5102
```

```powershell
# PowerShell
$env:Cors__AllowedOrigins__0 = "http://localhost:8081"
dotnet run --urls http://localhost:5102
```

Without that override the browser blocks every auth call (the checked-in `appsettings.json` only
allows `http://localhost:5102` and `https://localhost:7094`). Native builds are unaffected.

Verify (this exact sequence was run against this repo):

```bash
curl -s http://localhost:5102/health
# {"status":"healthy","timestamp":"…"}

DEV=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
curl -s -X POST http://localhost:5102/api/auth/register \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"me@example.com\",\"password\":\"Password123!\",\"deviceId\":\"$DEV\"}"
```

Expected response (camelCase, no wrapper):

```json
{
  "accessToken": "eyJhbGciOi…",
  "refreshToken": "…",
  "expiresAt": "2026-11-03T09:20:11.1Z",
  "userId": "6ae9a0438b2bbf427c430320",
  "deviceId": "f28f57df0cda21f8cf3e38484ca8f4db"
}
```

The decoded access token carries exactly the claims the Kafka trigger requires:

```json
{"userId":"6ae9…","deviceId":"f28f…","device_id":"f28f…","iss":"stash-auth","aud":"stash-app","exp":…}
```

| Endpoint | Body | Notes |
|---|---|---|
| `POST /api/auth/register` | `{email,password,deviceId}` | password ≥ 8 chars, email must be valid, device ID required |
| `POST /api/auth/login` | `{email,password,deviceId}` | first login from an unknown device registers it; revoked device → 401 |
| `POST /api/auth/refresh` | `{refreshToken}` | rotates the refresh token (old one is revoked) |
| `POST /api/auth/revoke` | `{deviceId}` + `Authorization: Bearer …` | revokes device + its refresh tokens |
| `GET /health` | — | liveness |

### Option B — Vercel Identity API

The deployed Identity API is the Vercel function in `kafka_proxy_vercel/` (`api/auth/[...path].ts`), served from the same origin as the Kafka proxy. The local .NET API above remains a local/reference option, and `StashHost.Functions` is not changed.

1. Deploy `kafka_proxy_vercel` and set `MONGODB_URI` and `MONGODB_DATABASE` for the users, devices and refresh-token store.
2. Set `JWT_SIGNING_KEY`, `JWT_ISSUER` (`stash-auth`) and `JWT_AUDIENCE` (`stash-app`). Keep them identical to the Kafka proxy and any host that still validates tokens.
3. Set `CORS_ALLOWED_ORIGINS` for the Expo/web origin instead of leaving the default `*`.
4. Point the app at the deployment origin: `EXPO_PUBLIC_IDENTITY_API_BASE_URL=https://<vercel-project>.vercel.app` (no trailing slash required).

Routes: `POST /api/auth/register|login|refresh|revoke`, plus `GET /api/auth/health` as the liveness check.

Deployment and environment details: [kafka_proxy_vercel/README.md](../kafka_proxy_vercel/README.md); contract plan: [kafka_proxy_vercel/docs/IDENTITY_API_PLAN.md](../kafka_proxy_vercel/docs/IDENTITY_API_PLAN.md).

---

## 7. Step 3 — Azurite (Durable Functions storage)

`StashHost.Functions/local.settings.json` sets `AzureWebJobsStorage=UseDevelopmentStorage=true`, so
Azurite **must already be running** before the Functions host starts.

```bash
docker run -d --name stash-azurite \
  -p 10000:10000 -p 10001:10001 -p 10002:10002 \
  mcr.microsoft.com/azure-storage/azurite
```

Durable orchestration state (history, queue messages, leases) lives here, so deleting the container
also forgets in-flight orchestrations — which is usually what you want during development.

---

## 8. Step 4 — StashHost.Functions

### 8.1 Configure `local.settings.json`

Edit `StashHost.Functions/local.settings.json` (`Values` section). Everything is a plain app setting;
`:` is the configuration separator for `IConfiguration`, so keep the names as written.

| Key | Set it to | Why |
|---|---|---|
| `AzureWebJobsStorage` | `UseDevelopmentStorage=true` | Azurite |
| `FUNCTIONS_WORKER_RUNTIME` | `dotnet-isolated` | leave as is |
| `Kafka:BootstrapServers` | your Aiven `host:port` | trigger + producer |
| `Kafka:Username` / `Kafka:Password` | Aiven service user / SCRAM password | SASL_SSL + SCRAM-SHA-256 is hard-coded in the trigger |
| `Storage:Provider` | `Mega` | **Backend/legacy:** staging provider for temp uploads + thumbnails. The new RN client uploads to S3, so the host needs S3 support for that path. |
| `Storage:Mega:Email` / `Password` | your MEGA account | in-process megajs login |
| `Storage:Local:RootPath` | library directory, e.g. `%USERPROFILE%\StashLibrary` | where permanent copies are written (any writable local/network path) |
| `Auth:Jwt:SigningKey` | **same string as the Identity API** | the default value already matches; change both together |
| `Auth:Jwt:Issuer` / `Audience` | `stash-auth` / `stash-app` | must match the token |
| `STASH_FFMPEG_PATH` | `ffmpeg` (or absolute path) | MOV→MP4 |
| `STASH_FFMPEG_VIDEO_CODEC` | `libx264` | video conversion |
| `DurableTask:GrpcEndpoint` | `http://localhost:7071` | local durable endpoint |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | empty | telemetry is optional |

The checked-in values point at `kafka.dev.aivencloud.com:21753` with an empty password; until you
replace them the host logs `Failed to resolve 'kafka.dev.aivencloud.com'` and every trigger stays
offline — that is expected, not a code fault.

These settings configure the **repository backend's MEGA path**. They do not configure the RN
client; the new client's S3/version-2 contract is in §11.

### 8.2 Choose the local media library location

Permanent copies are written by `StorePermanentActivity` through
`StashHost.Shared/Services/LocalStorageProvider.cs` to `Storage:Local:RootPath`. Nothing else is
needed — the provider uses plain `File`/`Directory` APIs, so the setting accepts any path the
Functions process can write to:

| Environment | Example value |
|---|---|
| Local drive | `D:\StashLibrary` |
| User profile (portable dev default) | `%USERPROFILE%\StashLibrary` |
| Windows Storage Space / mounted volume | `S:\StashLibrary` |
| Network share (UNC) | `\\nas\photos\stash` |
| Mapped drive | `Z:\stash` |
| Home-relative (Linux/macOS or Git Bash) | `~/StashLibrary` |

Layout created under the root (one folder per user, hash-named files):

```
{Storage:Local:RootPath}
└── backups
    └── {userId}
        ├── 23eff170…bf.jpg   # converted image
        └── 77145c94…16.mp4   # converted video
```

Notes:

- The path is expanded (`%VAR%`, leading `~`) and must be absolute; a relative value fails the
  activity with a configuration error rather than writing somewhere unpredictable. Outside
  `local.settings.json`, set it as the environment variable `Storage__Local__RootPath`.
- Writes go to a `*.partial` file next to the destination and are then moved into place, so an
  interrupted copy never leaves a truncated file that deduplication would treat as complete.
- The Functions host only needs **write** access; the RN app never reads the library directly (it
  stores the logical `/backups/{userId}/{hash}.jpg` path returned by the host).
- For a network share, either run the host under an account with access to the share or grant the
  share to the host's identity. If the share is offline, the activity fails with
  `Store permanent file failed: …` and the orchestration reports `FAILED` — nothing is stored
  anywhere else.
- Two different disks are fine at the same time: thumbnails stay in the backend's MEGA account,
  permanent files live here.

### 8.3 Install `megajs` next to the built assembly (backend/legacy MEGA path)

> This step belongs to the repository backend's MEGA provider. The new RN client
> uses S3 and does not need `megajs`; skip this if you are only exercising the
> client's S3 upload.

`MegaConnectivity.Core` embeds Node (libnode ships with the NuGet package) and calls
`require('megajs')` with the **assembly directory** as the runtime's base dir
(`MegaStorageClient.InitializeAsync`). So `megajs` must be installed inside the function app output
folder:

```bash
cd StashHost.Functions/bin/Debug/net10.0
npm install megajs --no-fund --no-audit
```

Re-run that after `dotnet clean` or a fresh `dotnet build` that wipes the folder, otherwise every Mega
activity fails with *"megajs module not found. Run 'npm install megajs' in the app directory."*

### 8.4 Start the host

```bash
cd StashHost.Functions
dotnet run
```

`Azure.Functions.Sdk` starts the Functions host through Core Tools; `func start` works too. Expected
banner (verified here):

```
Core Tools Version:       4.16.0
Function Runtime Version: 4.x
Functions:
    DeadLetterHandlerFunction: kafkaTrigger
    FileProcessingOrchestration: orchestrationTrigger
    HealthCheckFunction: httpTrigger
    KafkaTriggerFunction: kafkaTrigger
    … activities …
```

Verify:

```bash
curl -s http://localhost:7071/api/health
# {"status":"healthy","timestamp":"03-11-2026 08:59:13"}
```

> Kafka trigger failures to reach the broker are logged continuously and are **non-fatal**: the health
> endpoint keeps answering. Fix the broker settings rather than restarting repeatedly.

---

## 9. Step 5 — Stash Kafka proxy

The RN client produces and polls through the **Stash Kafka proxy**; it never opens a Kafka
connection or uses a REST proxy. Deploy `kafka_proxy_vercel/` as described in
[`kafka_proxy_vercel/README.md`](../kafka_proxy_vercel/README.md), or let
`scripts/setup-and-run.mjs` start the local Node server (`http://localhost:3000`).

Point the app at it with `EXPO_PUBLIC_KAFKA_PROXY_BASE_URL` (or `Kafka.Proxy.BaseUrl` in
`appconfig.json`). The proxy's `/api/messages` routes require the Stash access token; broker
credentials stay in the proxy's environment.

---

## 10. Step 6 — Legacy Mega REST bridge (not used by the current S3 client)

The current RN client no longer talks to MEGA: it uploads to S3
(`react_native_stash/src/services/storage/`) and publishes upload requests as version 2.
**Skip this step.** It is
retained only for older MEGA-era app builds that still expect a host service with this contract;
the current client never calls `/api/mega/*`.

| Route | Request | Response |
|---|---|---|
| `POST /api/mega/upload` | `multipart/form-data`: `path` (logical path), `file` | `{"path":"/temp/uploads/…/name.ext"}` (or any JSON with `path`/`name`/`megaTempPath`) |
| `HEAD /api/mega/{fileName}` | — | `200` if present, `404` if not |
| `GET /api/mega/{fileName}` | — | file bytes |

Older MEGA-era builds also sent (and the bridge may ignore) `X-Message-Version: 1`, `X-Mega-Email`,
`X-Mega-Password` and `Authorization: Bearer <access token>` to this bridge. The current S3 client
sends no `X-Mega-*` headers and does not call the bridge at all. To Kafka, it still sends
`Authorization: Bearer <access token>` and `X-Message-Version: 2` on upload requests.

Create `tools/mega-bridge/` (or any folder outside the repo you prefer) with the two files in
**Appendix A**, then:

```bash
cd tools/mega-bridge
npm install express multer megajs --no-fund --no-audit
MEGA_EMAIL='you@example.com' MEGA_PASSWORD='…' PORT=8090 node server.js
```

```bash
curl -s http://localhost:8090/health
# {"status":"ok","megaLoggedIn":false}

# upload a real file through the same path the app uses
curl -s -X POST http://localhost:8090/api/mega/upload \
  -F 'path=/temp/uploads/dev-1/sample.txt' \
  -F 'file=@README.md'
# {"path":"/temp/uploads/dev-1/sample.txt","physicalName":"temp_uploads_dev-1_sample_3f2a91cd.txt"}
```

Log in happens lazily on the first upload; a bad MEGA password returns `502` with the megajs message.

---

## 11. Step 7 — React Native UI configuration

The app reads non-secret defaults from `react_native_stash/src/config/appconfig.json` and overlays
`EXPO_PUBLIC_*` values from `.env` (both are bundled at build time — restart Metro after editing).
The S3 keys are documented in detail in
[`react_native_stash/docs/SETUP_AND_USAGE.md` §4.4](../react_native_stash/docs/SETUP_AND_USAGE.md#44-storage-s3).

The checked-in `appconfig.json` has the shape below (set `Kafka.Proxy.BaseUrl` to the proxy origin
for this runbook); secrets are normally supplied via `.env`:

```json
{
  "Kafka": {
    "TopicUploadRequest": "stash.upload.request",
    "TopicUploadResponse": "stash.upload.response",
    "TopicDeadLetter": "stash.dlq",
    "Proxy": {
      "BaseUrl": "http://localhost:3000",
      "PollIntervalMs": 15000,
      "PollTimeoutMs": 8000,
      "MaxRecordsPerPoll": 50,
      "RequestTimeoutSeconds": 45
    }
  },
  "Storage": {
    "Provider": "S3",
    "S3": {
      "Bucket": "",
      "Region": "us-east-1",
      "AccessKeyId": "",
      "SecretAccessKey": "",
      "SessionToken": "",
      "Endpoint": "",
      "ForcePathStyle": false,
      "Prefix": "",
      "PresignExpirySeconds": 3600
    }
  },
  "IdentityApiBaseUrl": "http://localhost:5102",
  "IdentityApiTimeoutSeconds": 30,
  "UploadSettings": { "BatchSize": 10, "MaxRetries": 3, "MaxFileSizeBytes": 524288000 },
  "BackgroundUpload": { "Enabled": true, "IntervalMinutes": 15, "MaxFilesPerRun": 50 }
}
```

| Key | Local value | Notes |
|---|---|---|
| `IdentityApiBaseUrl` | `http://localhost:5102` | no trailing slash needed |
| `Kafka.Proxy.BaseUrl` | `http://localhost:3000` | Stash Kafka proxy origin; all produce/poll calls go here |
| `Storage.Provider` | `S3` | the only supported provider |
| `Storage.S3.Bucket` | your bucket | empty makes uploads fail with “Amazon S3 is not configured” |
| `Storage.S3.Region` | `us-east-1` (AWS default) | must match the bucket's region |
| `Storage.S3.AccessKeyId` / `SecretAccessKey` | your credentials | preferably via `EXPO_PUBLIC_S3_*` in `.env` |
| `Storage.S3.SessionToken` | empty | set only for STS temporary credentials |
| `Storage.S3.Endpoint` | empty for AWS | set for MinIO/R2/other S3-compatible endpoints |
| `Storage.S3.ForcePathStyle` | `false` | `true` for MinIO and servers that require path-style |
| `Storage.S3.Prefix` | empty | optional key prefix |
| `Storage.S3.PresignExpirySeconds` | `3600` | presigned URL lifetime (1–604800) |

Recommended `.env` for the local UI (the setup script writes these values into
`appconfig.json` as well; keep real credentials out of commits):

```bash
EXPO_PUBLIC_IDENTITY_API_BASE_URL=http://localhost:5102
EXPO_PUBLIC_KAFKA_PROXY_BASE_URL=http://localhost:3000
EXPO_PUBLIC_S3_BUCKET=<bucket>
EXPO_PUBLIC_S3_REGION=us-east-1
EXPO_PUBLIC_S3_ACCESS_KEY_ID=<access key>
EXPO_PUBLIC_S3_SECRET_ACCESS_KEY=<secret>
EXPO_PUBLIC_S3_ENDPOINT=
EXPO_PUBLIC_S3_PREFIX=
EXPO_PUBLIC_S3_FORCE_PATH_STYLE=false
EXPO_PUBLIC_S3_PRESIGN_EXPIRY_SECONDS=3600
```

`EXPO_PUBLIC_*` values are inlined into the bundle, so use scoped credentials.
The client writes the object at `[Prefix/]temp/uploads/{deviceId}/{fileName}` and publishes
`storageTempPath` (the logical `/temp/uploads/...` path) with `storageProvider: "S3"` and
`version: 2`. The repository host still expects `megaTempPath` and version 1, so it rejects these
requests until S3/version-2 support is added (see the warning at the top and §16, L9).

### 11.1 Install and run

```bash
cd react_native_stash
npm install
npx tsc --noEmit            # optional type check
npx expo start --web --port 8081
```

Open `http://localhost:8081`. `metro.config.js` already adds `.wasm` to `assetExts` and the
`Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` headers that `expo-sqlite` needs on web.

Native builds (device on the same LAN) need LAN URLs instead of `localhost` —
`IdentityApiBaseUrl: http://192.168.x.y:5102` and `Kafka.Proxy.BaseUrl: http://192.168.x.y:3000`, and the
proxy must be reachable from the device. Start MongoDB/Azurite/Functions/Identity with the same LAN binding
(`--urls http://0.0.0.0:5102`) and allow the Windows Firewall prompt.

For a device, the S3 bucket/endpoint must also be reachable from the phone. AWS endpoints are public;
a MinIO instance on the dev machine needs a LAN URL in `Storage.S3.Endpoint` (and `ForcePathStyle`).

---

## 12. Step 8 — End-to-end walkthrough

> **This flow is not end-to-end with the current repository host.** The new RN client publishes
> version 2 with `storageTempPath`/`storageProvider` and writes the temp object to S3, while the
> host validator accepts only version 1 with `megaTempPath` and its provider is MEGA. The steps below
> show what the client does and where the repository host stops until S3/version-2 support is added.

Read **L1** and **L2** first: two client-side quirks mean the record may reach the broker and the
work may complete on a compatible host, but the app can report the publish as failed and may not
apply the response. The walkthrough states what you should observe *concretely*.

1. **Register** — Login screen → *Create account* → email/password → *Register*.
   Identity API returns tokens; the app stores them plus a generated device ID in SecureStore
   (`stash.auth.*`, `stash.device_id`).
   *Check:* `docker exec stash-mongo mongosh stash --eval 'db.users.countDocuments()'` → `1`.
2. **Add a folder** — Folders tab → FAB → pick a folder containing media files → *Scan now*.
   Files matching the 14 media patterns are hashed (SHA-256) and inserted as `Pending`.
3. **Upload** — Files tab → *Upload files* (or wait for the 15-minute background pass).
   The app: stats the file → presigns and `PUT`s it to S3 at
   `[Prefix/]temp/uploads/{deviceId}/{name}` → keeps `/temp/uploads/{deviceId}/{name}` as the
   logical path → produces a version-2 record. Because of **L1** the record may be stored while the
   app marks the row `Failed` with
   `Kafka publish failed: Kafka REST produce returned error_code 200`.
   *Check:* the object exists in the bucket. With the repository host, the version-1 validator
   rejects the v2 message, so no orchestration starts; inspect `stash.dlq` instead.
4. **Processing (requires host S3/v2 support)** — a compatible host must read `storageTempPath` from
   S3, verify the hash equals `fileId`, check dedup, convert HEIC/PNG/RAW→JPEG and MOV→MP4, write
   thumbnails, store the permanent copy as
   `{Storage:Local:RootPath}\backups\{userId}\{hash}.jpg` on disk, delete the S3 temp object, and
   publish the response.
   The repository host instead still downloads from MEGA by physical name, writes thumbnails to the
   MEGA account, and has no S3 temp object to read — so this step cannot run for the new client.
5. **Response** — the host publishes `stash.upload.response`; the app's consumer polls it but may hit
   **L2** (hex key is not JSON) and not apply the record, so a row can stay at `Processing` on its
   own. Inspect the topic instead (Aiven console → Topics → `stash.upload.response` → Messages).
6. **Dedup** — with a compatible host, upload the same file again: it returns `COMPLETED` with
   `deduplicated: true` and no second copy is written. This step also requires the S3/v2 host work.
7. **DLQ** — produce to `stash.upload.request` with a bad key (not 64-hex) and watch the payload
   land in `stash.dlq` with header `x-dlq-reason`, logged by `DeadLetterHandlerFunction`. The
   repository host also routes the new client's version-2 messages here via validation failure.

---

## 13. Config reference (all components)

### 13.1a Identity API — local .NET (appsettings.json / env)

| Key | Default | Local note |
|---|---|---|
| `Auth:Jwt:SigningKey` | `stash-signing-key-change-in-production-min-32-chars` | must equal the Functions value |
| `Auth:Jwt:Issuer` / `Audience` | `stash-auth` / `stash-app` | must match tokens |
| `Auth:Jwt:AccessTokenExpiryMinutes` | `"15"` | string, parsed as int |
| `Auth:Jwt:RefreshTokenExpiryDays` | `"7"` | |
| `MongoDB:ConnectionString` | `mongodb://localhost:27017` | |
| `MongoDB:DatabaseName` | `stash` | |
| `Cors:AllowedOrigins` | `http://localhost:5102`, `https://localhost:7094` | add `http://localhost:8081` for web |

### 13.1b Identity API — Vercel function (environment variables)

| Variable | Default | Notes |
|---|---|---|
| `MONGODB_URI` | — (required) | Same MongoDB database/collections as the .NET API |
| `MONGODB_DATABASE` | `stash` | |
| `JWT_SIGNING_KEY` | — (required) | Must equal the Kafka proxy and any host validating tokens |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `stash-auth` / `stash-app` | Must match the proxy/host |
| `AUTH_ACCESS_TOKEN_EXPIRY_MINUTES` | `15` | Clamped 1..1440 |
| `AUTH_REFRESH_TOKEN_EXPIRY_DAYS` | `7` | Clamped 1..365 |
| `AUTH_MAX_BODY_BYTES` | `65536` | Clamped 1024..1048576 |
| `CORS_ALLOWED_ORIGINS` | `*` | Shared with the Kafka proxy |

### 13.2 Functions — `local.settings.json`

See §8.1. Trigger/binding values must be plain app settings (the Kafka extension resolves them by
name); `extensions.kafka.consumerGroup` in `host.json` is the default group, but each function
overrides it (`stash-upload-request`, `stash-dlq-handler`).

### 13.3 RN app — `appconfig.json` + `.env`

See §11. `Storage.Provider` is `S3`; `Storage.S3.*` supplies the bucket, region, credentials,
endpoint/path-style, prefix and presign expiry. `UploadSettings.MaxFileSizeBytes` (500 MB),
`BatchSize` (10) bounds each upload batch and `BackgroundUpload.MaxFilesPerRun` (50)
bounds each candidate page, which a single pass repeats until the backlog is drained.

---

## 14. Smoke test script (copy/paste)

```bash
# 1) infrastructure
curl -s http://localhost:5102/health
curl -s http://localhost:7071/api/health

# 2) auth round-trip
DEV=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
REG=$(curl -s -X POST http://localhost:5102/api/auth/register -H 'Content-Type: application/json' \
  -d "{\"email\":\"smoke-$DEV@example.com\",\"password\":\"Password123!\",\"deviceId\":\"$DEV\"}")
echo "$REG" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log('user',r.userId,'device',r.deviceId)})"

# 3) Stash Kafka proxy health
curl -s http://localhost:3000/api/health
```

The S3 step is exercised by the app itself: it presigns a `PUT` and writes to the configured bucket,
so there is no local endpoint to smoke-test. To inspect the result with the same credentials, use
the AWS CLI (or the provider console):

```bash
aws s3api head-object --bucket "$S3_BUCKET" \
  --key "${S3_PREFIX:+$S3_PREFIX/}temp/uploads/<deviceId>/<fileName>"
```

No live S3 upload is performed by this runbook, and the repository host does not yet read S3.


---

## 15. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `func: command not found` after npm install | npm 12 skipped the postinstall | install via winget/MSI, or unzip the CLI as in §2.1 |
| Identity API exits with `Auth:Jwt:SigningKey is not configured` | launched from the wrong directory / config not found | run from `StashHost.IdentityApi`, or set the env var |
| Vercel Identity API returns 500 or 401 | MongoDB/JWT env vars missing, or `JWT_SIGNING_KEY`/issuer/audience disagree with the Kafka proxy or host | set `MONGODB_URI` and the JWT variables on the Vercel project; keep the JWT values identical across the proxy and any host validating tokens |
| Browser: *blocked by CORS policy* on login/register | origin `http://localhost:8081` not allowed | start with `Cors__AllowedOrigins__0=http://localhost:8081` |
| Functions: `Failed to resolve 'kafka.dev.aivencloud.com'` | placeholder broker | set `Kafka:BootstrapServers` to your Aiven host |
| Functions: `SSL handshake failed` / `certificate verify failed` | broker uses Aiven's project CA, librdkafka trusts only the OS store | enable public CA certificates for the service, or import `ca.pem` into the Windows trusted roots |
| Functions: `Authentication failed` / SASL errors | SASL not enabled, wrong user, or Kafka 4.x with librdkafka 2.6.0 | enable `kafka_authentication_methods.sasl`, re-copy credentials, see §3.1 step 5 |
| Functions: `%Kafka:BootstrapServers%` / no trigger | setting missing or empty | keep the setting name exactly as the trigger references it |
| Orchestration fails immediately with `Download failed … not found` | the host is looking in MEGA for an object the new client wrote to S3, or the host prefix/region is wrong | This is the S3/v2 host gap (§1 warning). The legacy `MegaPathMapper` rule applies only to old MEGA-era clients/bridge builds. |
| App requests are rejected and land in `stash.dlq` | repository host validator accepts version 1 only | implement S3 + version 2 on the host (see SETUP_AND_USAGE §11) |
| `megajs module not found` in activity logs (backend MEGA path) | `npm install megajs` missing in `bin/Debug/net10.0` | install it there (§8.3); this affects the backend's legacy MEGA provider, not the S3 client |
| `Local storage is not configured. Set Storage:Local:RootPath …` | permanent-storage setting missing or empty | set `Storage:Local:RootPath` (§8.2) |
| `Store permanent file failed: Access to the path … is denied` | host account cannot write the library folder / share | grant write permission or change `Storage:Local:RootPath` |
| Re-upload always reprocesses instead of deduplicating | `Storage:Local:RootPath` changed, so the hash file lives elsewhere | expected after moving the library; keep the same root for stable dedup |
| App: *Amazon S3 is not configured…* | bucket/region/access key/secret empty | set the `EXPO_PUBLIC_S3_*` variables (§11) |
| App: S3 `403` (signature, access or expired credentials) | wrong secret/region, clock skew, missing bucket permissions, or expired STS token | check credentials/region, device clock, bucket policy and session token |
| App: S3 `404` / wrong object | bucket/key/region/prefix or endpoint mismatch | verify bucket, `Storage.S3.Prefix`, region and `Endpoint`/`ForcePathStyle` |
| App web: CORS failure on S3 | bucket has no CORS rule for the Expo origin | allow `PUT`/`GET`/`HEAD` from `http://localhost:8081` |
| App: *Kafka proxy is not configured* | `Kafka.Proxy.BaseUrl` empty | §11 |
| `docker exec … /opt/kafka/...: no such file` | Git Bash path rewrite | prefix with `//` |
| FFmpeg conversion fails | FFmpeg not on PATH | set `STASH_FFMPEG_PATH` to the exe, or add it to PATH |
| Ports already in use | another run | `netstat -ano | grep :5102` → `taskkill //PID <pid> //F` |

---

## 16. Known limitations of this local topology

**L4 — Flat Mega layout (backend/legacy).** The backend's `MegaPathMapper` encodes the whole logical
path into a single root-level file name; folders are not created in MEGA. A shared account used by
other tools may collide on the encoded prefix, and listing files shows hashed suffixes. The new RN
client no longer uses this mapping.

**L5 — The legacy bridge is a dev tool (legacy MEGA builds).** Only pre-S3/MEGA-era app builds use it
(Appendix A): it performs a fresh megajs login per process, buffers uploads in memory, has no auth of
its own, and ignores the `X-Mega-*` headers. Never expose it beyond localhost. The current client
uploads to S3 and does not call the bridge.

**L6 — Response filtering and offsets.** The Stash Kafka proxy filters `stash.upload.response`
records to the token's device/user and drops records with no usable `deviceId`. It still reads the
shared topic before filtering (read amplification), and offsets commit before the client applies a
record; an ACK/inbox protocol remains a known gap.

**L7 — Web is a development target.** Expo web works (SQLite via wasm, document picker via Blob
URIs), but file-system scanning of local folders is only meaningful on Android/iOS. Web uploads also
need a bucket CORS rule; native builds do not.

**L8 — The local library has no per-user access control of its own.** `LocalStorageProvider` writes
`{Storage:Local:RootPath}/backups/{userId}/…` on one filesystem; isolation between users is by folder
name only. Protect the library with OS/share permissions (and back it up yourself) if more than one
person can reach the host. Thumbnails still live in the MEGA account, so the library is not a
self-contained mirror until those move too. This remains a backend concern; the new client's temp
objects are in S3.

**L9 — Client/host contract mismatch (S3 vs MEGA).** The new RN client uploads to S3 and publishes
version 2 (`storageTempPath`, `storageProvider: "S3"`), while the repository host validates version 1
with `megaTempPath` and uses MEGA as its staging provider. Until the host implements S3 and accepts
version 2, uploads from the new client are rejected (DLQ) and no end-to-end S3 verification is
possible. This is the primary follow-up for this runbook.

---

## 17. Verification status

The backend checks below were performed against this repository's MEGA/version-1 path. The RN rows
reflect the S3 implementation; no live S3 upload is claimed.

| Check | Result |
|---|---|
| `dotnet build` Identity API and Functions | both succeed, 0 warnings |
| Identity API against local MongoDB | `/health` 200; register returns tokens with `userId`/`deviceId` claims |
| Identity API CORS override for `:8081` | `Access-Control-Allow-Origin: http://localhost:8081` present |
| Functions host via `dotnet run` + Azurite | starts, `/api/health` 200, Kafka & Durable extensions load |
| `dotnet test StashHost.Tests` | 143 passing: local library round-trip/overwrite/traversal, `StorePermanentActivity` writing a real photo under a temp root, dedup seeing the stored file |
| `npx tsc --noEmit` in `react_native_stash` | passed with exit 0 after the S3 migration |
| RN dependency audit | lockfile regenerated with `npm install --package-lock-only`; no `react-native-mega` reference in `package.json` or `package-lock.json`; storage dependencies remain `js-sha256` + `expo-file-system` |
| `npx expo export` (web and android) | both succeeded after the S3 migration: web 796 modules; Android 1095 modules (~2.9 MB HBC); no device testing claimed |
| S3 presign/transfer path | presigner cross-checked against AWS's published presigned-URL example (canonical-request hash and signature matched) and an independent Python `hashlib`/`hmac` reference for virtual-hosted and path-style-with-session-token cases (signatures byte-identical); native `uploadAsync`/`downloadAsync` and the Android `content://` staging branch validated at bundle/type level only, not on a device |
| S3 end-to-end upload/download/processing | **not verified**; requires real bucket credentials and a host that accepts version 2 and reads S3 |
| MEGA physical naming parity | backend-only historical check (`MegaPathMapper`); the RN client no longer maps names |
| megajs login path (legacy MEGA) | backend/legacy probe; not part of the current S3 client |

**Not verified here** — requires your credentials: Aiven connectivity from the Functions host and the
Stash Kafka proxy, a real S3 upload/download/processing, and a host that reads S3 and accepts version 2.
Therefore the full S3 upload → convert → store → response loop is not verified. The local library path
itself needs no credentials; it is covered by the test suite above (on the backend's MEGA/version-1 path).

---

## 18. Shut down / reset

```bash
docker stop stash-mongo stash-azurite stash-rest
docker rm   stash-mongo stash-azurite stash-rest
# only if you created the local broker for testing:
docker rm -f stash-kafka stash-rest stash-azurite stash-mongo
docker network rm stash-net
```

```bash
# stop the two .NET processes (Git Bash)
for p in 5102 7071; do
  PID=$(netstat -ano | grep LISTENING | grep ":$p" | awk '{print $5}' | head -1)
  [ -n "$PID" ] && taskkill //PID $PID //F
done
```

Client state lives in the app's SecureStore/SQLite; clear it from the Settings screen or by
uninstalling / clearing site data in the browser.

---

## Appendix A — Legacy Mega REST bridge (reference implementation, not used by the current S3 client)

`tools/mega-bridge/package.json`

```json
{
  "name": "stash-mega-bridge",
  "private": true,
  "type": "commonjs",
  "scripts": { "start": "node server.js" },
  "dependencies": {
    "express": "^5.3.0",
    "multer": "^2.5.0",
    "megajs": "^1.3.10"
  }
}
```

`tools/mega-bridge/server.js`

```js
/**
 * Minimal Mega REST bridge for the Stash React Native client.
 *
 *   POST /api/mega/upload   multipart: path + file  -> { path, physicalName }
 *   HEAD /api/mega/:name    -> 200 / 404
 *   GET  /api/mega/:name    -> file bytes
 *   GET  /health
 *
 * File names must match StashHost.Shared/Services/MegaPathMapper.cs exactly,
 * otherwise the Functions DownloadFileActivity cannot find the upload.
 */
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Storage } = require('megajs');

const PORT = Number(process.env.PORT || 8090);
const EMAIL = process.env.MEGA_EMAIL || '';
const PASSWORD = process.env.MEGA_PASSWORD || '';
const MAX_BYTES = positiveNumber(process.env.MAX_UPLOAD_BYTES, 512 * 1024 * 1024);

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ---- MegaPathMapper port -------------------------------------------------
function sanitize(segment) {
  return segment.replace(/[^A-Za-z0-9._-]/g, '_');
}

function physicalFileName(remotePath) {
  if (!remotePath || !remotePath.trim()) {
    throw new Error('Remote path cannot be empty.');
  }
  const normalized = remotePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) throw new Error('Remote path must contain a file name.');
  if (segments.some((s) => s === '.' || s === '..')) {
    throw new Error("Remote path cannot contain '.' or '..' segments.");
  }

  const leaf = sanitize(segments[segments.length - 1]);
  if (!leaf) throw new Error('Remote path has an invalid file name.');
  if (segments.length === 1) return leaf;

  const extension = path.extname(leaf);
  const stem = path.basename(leaf, extension);
  const prefix = segments.slice(0, -1).map(sanitize).join('_');
  let base = prefix ? `${prefix}_${stem}` : stem;
  if (base.length > 180) base = base.slice(0, 180);

  const suffix = crypto
    .createHash('sha256')
    .update(segments.join('/'))
    .digest('hex')
    .slice(0, 8);

  return `${base}_${suffix}${extension}`;
}

// ---- lazy Mega session ---------------------------------------------------
let session = null;
function getStorage() {
  if (session) return session;
  if (!EMAIL || !PASSWORD) {
    throw new Error('MEGA_EMAIL/MEGA_PASSWORD are not set for the bridge.');
  }
  session = new Storage({ email: EMAIL, password: PASSWORD, keepalive: false });
  return session;
}

const app = express();
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Mega-Email, X-Mega-Password, X-Message-Version');
  res.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const upload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: MAX_BYTES },
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', megaLoggedIn: Boolean(session) });
});

app.post('/api/mega/upload', upload.single('file'), async (req, res) => {
  const remotePath = (req.body && req.body.path) || '';
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'file part is required' });

  let physical;
  try {
    physical = physicalFileName(remotePath);
  } catch (error) {
    fs.rm(file.path, { force: true }, () => {});
    return res.status(400).json({ error: error.message });
  }

  try {
    const storage = getStorage();
    await storage.ready;
    const uploadStream = storage.upload({ name: physical, size: file.size });
    fs.createReadStream(file.path).pipe(uploadStream);
    const uploaded = await uploadStream.complete; // megajs resolves with the Mega File
    res.json({ path: remotePath, physicalName: uploaded.name, size: uploaded.size });
  } catch (error) {
    res.status(502).json({ error: `Mega upload failed: ${error.message}` });
  } finally {
    fs.rm(file.path, { force: true }, () => {});
  }
});

app.head('/api/mega/:name', async (req, res) => {
  try {
    const storage = getStorage();
    await storage.ready;
    const name = physicalFileName(req.params.name);
    const found = storage.find(name);
    return res.sendStatus(found ? 200 : 404);
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
});

app.get('/api/mega/:name', async (req, res) => {
  try {
    const storage = getStorage();
    await storage.ready;
    const name = physicalFileName(req.params.name);
    const found = storage.find(name);
    if (!found) return res.sendStatus(404);
    res.set('Content-Type', 'application/octet-stream');
    const stream = found.download();
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.use((error, _req, res, _next) => {
  res.status(400).json({ error: error.message });
});

app.listen(PORT, () => {
  console.log(`Mega bridge listening on http://localhost:${PORT}`);
  console.log(`Mega account: ${EMAIL ? EMAIL : '(not configured)'}`);
});
```

Notes:

- `physicalFileName` mirrors `MegaPathMapper.GetPhysicalFileName` for ASCII names. C# uses
  `char.IsLetterOrDigit` (Unicode-aware) — keep file names ASCII to stay byte-identical.
- `megajs` creates root-level files; `path` segments are only encoded into the name (same as the
  backend). That is intentional: the backend can only find root-level files.
- For very large files the upload is streamed from a temp file on disk (`multer` disk storage), so RAM
  usage stays flat, but the 500 MB `UploadSettings.MaxFileSizeBytes` cap still applies client-side.

## Appendix B — Message contracts

`stash.upload.request` — **new RN client (v2)** (key = SHA-256 hex, headers `Authorization`,
`X-Correlation-Id`, `X-Device-Id`, `X-User-Id`, `X-Message-Version`):

```json
{
  "messageId": "c0f5c1…",
  "timestamp": "2026-11-03T09:12:44.118Z",
  "fileId": "<64 hex sha256>",
  "fileName": "IMG_0001.HEIC",
  "fileSize": 4821004,
  "mimeType": "image/heic",
  "storageTempPath": "/temp/uploads/<deviceId>/IMG_0001.HEIC",
  "storageProvider": "S3",
  "metadata": null,
  "deviceId": "<device id>",
  "userId": "<user id>",
  "correlationId": "<uuid>",
  "version": 2
}
```

The repository host's current validator rejects this message because it expects version 1 and
`megaTempPath`; see the top warning and L9.

`stash.upload.response` (key = SHA-256 hex):

```json
{
  "messageId": "…", "timestamp": "…", "fileId": "<sha256>",
  "status": "COMPLETED",
  "permanentPath": "/backups/<userId>/<sha256>.jpg",
  "thumbnails": { "128": "/thumbs/…", "256": "/thumbs/…", "512": "/thumbs/…" },
  "convertedFormat": "image/jpeg",
  "deduplicated": false,
  "processingTimeMs": 4213,
  "error": null,
  "deviceId": "<device id>",
  "userId": "<user id>",
  "correlationId": "<uuid>",
  "version": 1
}
```

**Repository host (version 1/MEGA) validation rules** that cause a DLQ trip
(`UploadRequestValidator` + `KafkaTriggerFunction`): version ≠ 1, `fileId` not 64-hex, key ≠
`fileId`, missing/invalid JWT header, JWT `userId`/`deviceId` not matching the payload, missing
correlation id, file name containing separators, `fileSize` ≤ 0 or > 500 MB, `megaTempPath` not
under `/temp/`. The new version-2 message fails the version and `megaTempPath` checks, which is why
the host must be updated before the new client can complete the flow.

## Appendix C — Optional `docker-compose.yml` for the local infrastructure

```yaml
services:
  mongo:
    image: mongo:7
    ports: ["127.0.0.1:27017:27017"]  # loopback only, no LAN exposure

  azurite:
    image: mcr.microsoft.com/azure-storage/azurite
    ports: ["10000:10000", "10001:10001", "10002:10002"]

  kafka-rest:
    image: confluentinc/cp-kafka-rest:7.7.0
    ports: ["8082:8082"]
    environment:
      KAFKA_REST_BOOTSTRAP_SERVERS: "${KAFKA_BOOTSTRAP:-host:port}"
      KAFKA_REST_HOST_NAME: localhost
      KAFKA_REST_LISTENERS: http://0.0.0.0:8082
      KAFKA_REST_CLIENT_SECURITY_PROTOCOL: SASL_SSL
      KAFKA_REST_CLIENT_SASL_MECHANISM: SCRAM-SHA-256
      KAFKA_REST_CLIENT_SASL_JAAS_CONFIG: 'org.apache.kafka.common.security.scram.ScramLoginModule required username="${KAFKA_USER}" password="${KAFKA_PASSWORD}";'
      KAFKA_REST_ACCESS_CONTROL_ALLOW_ORIGIN: "*"
      KAFKA_REST_ACCESS_CONTROL_ALLOW_METHODS: "*"
      KAFKA_REST_ACCESS_CONTROL_ALLOW_HEADERS: "*"
      # If the Aiven service still uses its project CA:
      # KAFKA_REST_CLIENT_SSL_TRUSTSTORE_TYPE: PEM
      # KAFKA_REST_CLIENT_SSL_TRUSTSTORE_LOCATION: /certs/ca.pem
    # volumes: ["./ca.pem:/certs/ca.pem"]
```

Put `KAFKA_BOOTSTRAP`, `KAFKA_USER`, `KAFKA_PASSWORD` in a local `.env` (never commit it), then
`docker compose up -d` before starting the identity API and the Functions host.

