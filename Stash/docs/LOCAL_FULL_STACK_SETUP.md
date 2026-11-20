# Stash — Local Full-Stack Setup & Run Guide (React Native UI)

This runbook takes a clean Windows machine to a **working end-to-end Stash system**:

- the **React Native (Expo) UI** in `react_native_stash/` as the only client,
- the **Identity API** (`StashHost.IdentityApi`) running locally,
- the **host backend** (`StashHost.Functions`, Durable Functions + Kafka trigger) running locally,
- **MongoDB**, **Azurite** and a **Kafka REST proxy** running locally,
- and exactly **two external services**: **MEGA** (file storage) and **Aiven for Apache Kafka** (broker).

Everything else — database, orchestration storage, broker gateway — is a local process or
container. No Azure subscription, Application Insights, Key Vault, Confluent Cloud or hosted API is
required. The RN client writes to MEGA **directly** with the `megajs` library, so no upload bridge
process is part of the stack.

> **Why a local Kafka REST proxy?**
> The React Native client produces with record headers through the **Confluent REST Proxy v3** API
> (`POST /v3/clusters/{id}/topics/{topic}/records`). Aiven's Karapace REST proxy is **v2-only**, so
> pointing the app straight at Aiven fails on the v3 route. Running the Confluent REST Proxy
> container locally against your Aiven cluster gives the app a v3 endpoint while the records still
> land in your Aiven topics.
>
> **MEGA needs no bridge.** `react_native_stash/src/services/megaHttpService.ts` logs into the
> configured MEGA account with `megajs` (https://mega.js.org/) and uploads the temporary file to the
> account root, using a TypeScript port of `MegaPathMapper`
> (`react_native_stash/src/utils/megaPathMapper.ts`) so the Functions backend finds the same physical
> name. The old `POST /api/mega/upload` bridge is only needed by pre-megajs app builds; §10 keeps a
> reference implementation for those, and it is no longer required for this guide.

---

## 1. What runs, and on which port

| # | Component | How it runs | Address | Needed for |
|---|-----------|-------------|---------|------------|
| 1 | MongoDB | Docker (`mongo:7`) | `mongodb://localhost:27017` | Identity API users/devices/refresh tokens |
| 2 | Identity API | `dotnet run` | `http://localhost:5102` | Register / login / refresh / revoke |
| 3 | Azurite (Azure Storage emulator) | Docker | `127.0.0.1:10000-10002` | Durable Functions state, `AzureWebJobsStorage` |
| 4 | StashHost.Functions | `dotnet run` (Core Tools host) | `http://localhost:7071` | Kafka trigger + Durable orchestration + `/api/health` |
| 5 | Kafka REST proxy (Confluent) | Docker | `http://localhost:8082` | RN produce (v3) and consume (v2) |
| 6 | Mega REST bridge (legacy, optional) | `node` | `http://localhost:8090` | Only for app builds that still call `/api/mega/*`; the current app talks to MEGA via `megajs` |
| 7 | React Native UI | Expo / Metro | `http://localhost:8081` | The client under test |
| 8 | **MEGA** (external) | SaaS | `mega.nz` | Staging of uploads (`/temp/...`) and thumbnail storage |
| 9 | **Aiven Kafka** (external) | SaaS | `<host>:<port>` (SASL_SSL) | `stash.upload.request`, `stash.upload.response`, `stash.dlq` |
| 10 | **Local media library** | Host filesystem (`Storage:Local:RootPath`) | e.g. `D:\StashLibrary`, `\\nas\photos\stash` | Permanent copy of every processed upload (images/JPEG, videos/MP4) |

### 1.1 Data flow (what actually happens on an upload)

```
┌────────────────────────────┐
│ React Native UI (8081)     │
│  • scan folder → SHA-256   │
│  • megajs upload           │──────────────► MEGA account (megajs, direct)
│  • produce v3 record       │                root-level file "temp_uploads_…"
│    to stash.upload.request │
└─────────┬──────────────────┘
          │ v3 produce (HTTP)
          ▼
   Kafka REST proxy (8082) ──► Aiven Kafka ──► StashHost.Functions (7071)
                                                 │ Kafka trigger validates JWT headers,
                                                 │ key == SHA-256 fileId, shapes record
                                                 ▼
                                        Durable orchestration
                                 Download → Hash → Dedup → Convert →
                                 Thumbnails(128/256/512) → Store permanent (local disk) →
                                 Delete temp → Send response
                                                 │
                                                 ▼
                                   stash.upload.response ──► REST proxy ──► RN consumer
                                   (RN sets the local file status)
```

Storage layout produced by the backend (`StashHost.Functions/Activities/StoragePathBuilder.cs`):

| Purpose | Logical path | Physical location |
|---|---|---|
| Temp upload (client → host) | `/temp/uploads/{deviceId}/{fileName}` | MEGA: `temp_uploads_{deviceId}_{name}_{hash8}{ext}` |
| Permanent copy | `/backups/{userId}/{sha256}.{ext}` (`jpg` after image conversion, `mp4` after video conversion) | **Local library disk**: `{Storage:Local:RootPath}\backups\{userId}\{sha256}.{ext}` |
| Thumbnails | `/thumbs/{userId}/{128\|256\|512}/{sha256}.jpg` | MEGA: `thumbs_{userId}_{size}_{sha256}_{hash8}.jpg` |

The permanent copy never goes to MEGA: `StorePermanentActivity` always asks the storage factory for the
`Local` provider (`StashHost.Shared/Services/LocalStorageProvider.cs`), whatever `Storage:Provider` says.
MEGA is only the staging area for the upload in flight (deleted after processing) plus the thumbnail store.

The **physical name** used for MEGA objects (temp uploads and thumbnails) is produced by
`StashHost.Shared/Services/MegaPathMapper.cs`: every path
segment except the last is sanitised (`[A-Za-z0-9._-]`, everything else → `_`), joined with `_`,
truncated to 180 chars, then suffixed with `_<first 8 hex of SHA-256 of the normalised path>` before
the extension. **Every writer must use the identical rule** or the backend will download a file that
does not exist: the RN app ports it to `react_native_stash/src/utils/megaPathMapper.ts`, and the
legacy bridge in Appendix A mirrors it as well.

---

## 2. Prerequisites

Verified on this machine (Windows 11, Git Bash):

| Tool | Version that worked | How to check | Notes |
|---|---|---|---|
| .NET SDK | **10.0.403** | `dotnet --version` | Both host projects target `net10.0` |
| Node.js | **24.16.0** | `node -v` | Functions host, Expo, (legacy bridge) |
| npm | **12.2.0** | `npm -v` | npm ≥ 12 blocks lifecycle scripts by default — see 2.1 |
| Docker Desktop | **29.9.2** | `docker --version` | MongoDB, Azurite, Kafka REST proxy |
| Azure Functions Core Tools | **4.16.0** | `func --version` | Required for Durable + Kafka extensions; **≥ 4.13** for .NET 10 |
| FFmpeg | **9.0.1** | `ffmpeg -version` | MOV→MP4 conversions (`STASH_FFMPEG_PATH`) |
| Git Bash / PowerShell | — | — | Examples use Git Bash |

Accounts you must own:

- **Aiven for Apache Kafka** service (free/starter tier is enough): bootstrap host `host:port`,
  a service user with SCRAM-SHA-256 credentials, and ACLs allowing produce/consume on the three topics.
- **MEGA** account with enough space for your test files, and its email/password.

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
   `stash.dlq`, **produce** on `stash.upload.response` and `stash.dlq`; the REST proxy user (also
   used by the app) needs **produce** on `stash.upload.request`/`stash.dlq` and **consume** on
   `stash.upload.response`. Simplest local arrangement: reuse one service user with all of those.
8. **Do not** enable Karapace's REST proxy expecting v3 — it is v2-only. We run the Confluent REST
   Proxy locally instead (§9).

### 3.2 MEGA

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
├── MegaConnectivity.Core/      # megajs via node-api-dotnet (libnode embedded)
├── Stash.Maui/, Stash.Maui.Data/, Flutter*, ...  # not used by this runbook
├── react_native_stash/         # the UI
│   ├── src/config/appconfig.json       # ← you edit this
│   └── docs/SETUP_AND_USAGE.md         # client-only guide
└── docs/LOCAL_FULL_STACK_SETUP.md      # this file
```

Shared configuration values that **must match in every component**:

| Value | Identity API | Functions | RN app | Effect if it differs |
|---|---|---|---|---|
| JWT signing key | `Auth:Jwt:SigningKey` | `Auth:Jwt:SigningKey` | — | Kafka trigger rejects every message → DLQ |
| Issuer / audience | `stash-auth` / `stash-app` | same | `Auth.Jwt.*` (informational) | JWT validation fails |
| Topic names | — | `KafkaTrigger("stash.upload.request")`, DLQ handler `stash.dlq`, producer `stash.upload.*` | `Kafka.Topic*` | Messages land where nobody listens |
| Mega physical naming | — | `MegaPathMapper` | `src/utils/megaPathMapper.ts` | Download activity gets 404 |

---

## 5. Step 1 — MongoDB

```bash
docker run -d --name stash-mongo -p 27017:27017 mongo:7
docker ps --filter name=stash-mongo --format '{{.Status}}'   # Up … (healthy)
```

No initialisation needed: `MongoUserStore` creates the unique email index on startup
(`users`, `devices`, `refresh_tokens` collections in database `stash`).

Reset the database at any time:

```bash
docker exec stash-mongo mongosh stash --eval 'db.dropDatabase()'
```

---

## 6. Step 2 — Identity API

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
| `Storage:Provider` | `Mega` | staging provider for temp uploads + thumbnails |
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
- Two different disks are fine at the same time: thumbnails stay in MEGA, permanent files live here.

### 8.3 Install `megajs` next to the built assembly

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

## 9. Step 5 — Local Kafka REST proxy in front of Aiven

The RN client produces with the **v3 records API** (record headers are mandatory — the trigger reads
the JWT from them) and consumes with the **v2 consumer API**. The Confluent REST Proxy container
provides both and connects out to Aiven over SASL_SSL.

```bash
docker run -d --name stash-rest \
  -p 8082:8082 \
  -e KAFKA_REST_BOOTSTRAP_SERVERS='<host>:<port>' \
  -e KAFKA_REST_HOST_NAME=localhost \
  -e KAFKA_REST_LISTENERS=http://0.0.0.0:8082 \
  -e KAFKA_REST_CLIENT_SECURITY_PROTOCOL=SASL_SSL \
  -e KAFKA_REST_CLIENT_SASL_MECHANISM=SCRAM-SHA-256 \
  -e KAFKA_REST_CLIENT_SASL_JAAS_CONFIG='org.apache.kafka.common.security.scram.ScramLoginModule required username="<user>" password="<pass>";' \
  -e KAFKA_REST_CLIENT_SSL_ENDPOINT_IDENTIFICATION_ALGORITHM=https \
  -e KAFKA_REST_ACCESS_CONTROL_ALLOW_ORIGIN='*' \
  -e KAFKA_REST_ACCESS_CONTROL_ALLOW_METHODS='*' \
  -e KAFKA_REST_ACCESS_CONTROL_ALLOW_HEADERS='*' \
  confluentinc/cp-kafka-rest:7.7.0
```

* `KAFKA_REST_*` → REST proxy's own settings; `KAFKA_REST_CLIENT_*` → the Kafka client it uses to
  reach Aiven. If the service still uses Aiven's **project CA** (see §3.1 step 4), mount `ca.pem` and
  point the Java client at it as a PEM truststore:

  ```bash
  -v "$PWD/ca.pem:/certs/ca.pem" \
  -e KAFKA_REST_CLIENT_SSL_TRUSTSTORE_TYPE=PEM \
  -e KAFKA_REST_CLIENT_SSL_TRUSTSTORE_LOCATION=/certs/ca.pem \
  ```

  With public CA certificates enabled, the container's normal Java truststore is enough.
* The `ACCESS_CONTROL_*` trio is what makes the **Expo web** build able to call it from
  `http://localhost:8081`. Native builds do not need it. Browser-facing credentials are visible to
  the browser — acceptable on a dev box, not in production.
* Use a dedicated port that does not clash with Karapace (8082 is the REST proxy's own default).

Verify the two routes the app uses:

```bash
# v3 cluster discovery (the app caches cluster_id, or you can pin Kafka.ClusterId)
curl -s http://localhost:8082/v3/clusters | head -c 200
# {"kind":"KafkaClusterList",…"cluster_id":"5L6g3nShT-eMCtK--X86sw"…}

# v3 produce with a base64 BINARY key and base64 headers — exactly what the app sends
curl -s -X POST "http://localhost:8082/v3/clusters/$CID/topics/stash.upload.request/records" \
  -H 'Content-Type: application/json' \
  --data '{"key":{"type":"BINARY","data":"<base64 sha256>"},
           "value":{"type":"JSON","data":{"fileId":"<sha256>","…":"…"}},
           "headers":[{"name":"Authorization","value":"<base64 Bearer …>"},
                      {"name":"X-Correlation-Id","value":"<base64 …>"}]}'
# {"error_code":200,…}   ← 200 means success; the client treats non-zero as failure
```

A successful v3 produce returns `error_code: 200` (Confluent uses HTTP-style codes here). The RN
transport only accepts `0`, so it treats this success as a failure — see limitation **L1**.

---

## 10. Step 6 — Legacy Mega REST bridge (not needed by the current app)

The current RN client talks to MEGA itself with `megajs`
(`react_native_stash/src/services/megaHttpService.ts`), so **skip this step** unless you are running
an older app build that still expects a host service with this contract:

| Route | Request | Response |
|---|---|---|
| `POST /api/mega/upload` | `multipart/form-data`: `path` (logical path), `file` | `{"path":"/temp/uploads/…/name.ext"}` (or any JSON with `path`/`name`/`megaTempPath`) |
| `HEAD /api/mega/{fileName}` | — | `200` if present, `404` if not |
| `GET /api/mega/{fileName}` | — | file bytes |

It also sends (and the bridge may ignore) `X-Message-Version: 1`, `X-Mega-Email`, `X-Mega-Password`
and `Authorization: Bearer <access token>`. The app no longer sends any of these: the modern
`MegaHttpService` logs in with the account from `Storage.Mega.Email/Password`.

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

All runtime configuration is one file: `react_native_stash/src/config/appconfig.json`
(it is bundled at build time — restart Metro after editing).

```json
{
  "Kafka": {
    "BootstrapServers": "",
    "Username": "",
    "Password": "",
    "RestUrl": "http://localhost:8082",
    "RestUsername": "",
    "RestPassword": "",
    "RestTimeoutSeconds": 30,
    "ClusterId": "",
    "TopicUploadRequest": "stash.upload.request",
    "TopicUploadResponse": "stash.upload.response",
    "TopicDeadLetter": "stash.dlq"
  },
  "Storage": {
    "Provider": "Mega",
    "Mega": {
      "Email": "you@example.com",
      "Password": "…"
    }
  },
  "Auth": { "Jwt": { "Issuer": "stash-auth", "Audience": "stash-app" } },
  "IdentityApiBaseUrl": "http://localhost:5102",
  "IdentityApiTimeoutSeconds": 30,
  "UploadSettings": { "BatchSize": 10, "MaxRetries": 3, "MaxFileSizeBytes": 524288000 },
  "BackgroundUpload": { "Enabled": true, "IntervalMinutes": 15, "MaxFilesPerRun": 50 },
  "ApplicationInsights": { "Enabled": false, "ConnectionString": "" }
}
```

| Key | Local value | Notes |
|---|---|---|
| `IdentityApiBaseUrl` | `http://localhost:5102` | no trailing slash needed |
| `Kafka.RestUrl` | `http://localhost:8082` | the app appends `/v3/...` and `/consumers/...` |
| `Kafka.RestUsername/Password` | empty | the local proxy has no Basic auth; only set if you add one |
| `Kafka.ClusterId` | empty | discovered from `GET /v3/clusters`; pin it to skip discovery |
| `Storage.Mega.Email/Password` | your MEGA account | used directly by `megajs` on the device; blank values make uploads fail with “MEGA account is not configured” |
| `BootstrapServers`/`Username`/`Password` | empty | the app never opens a native Kafka connection |

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
`IdentityApiBaseUrl: http://192.168.x.y:5102` and `Kafka.RestUrl: http://192.168.x.y:8082`, and the
REST proxy must listen on `0.0.0.0`
(it does; just publish the port). Start MongoDB/Azurite/Functions/Identity with the same LAN binding
(`--urls http://0.0.0.0:5102`) and allow the Windows Firewall prompt.

---

## 12. Step 8 — End-to-end walkthrough

Read **L1** and **L2** first: two client-side quirks mean the record does reach the backend and the
work does complete, but the app reports the publish as failed and never applies the response. The
walkthrough below states what you should observe *concretely*, including those two symptoms.

1. **Register** — Login screen → *Create account* → email/password → *Register*.
   Identity API returns tokens; the app stores them plus a generated device ID in SecureStore
   (`stash.auth.*`, `stash.device_id`).
   *Check:* `docker exec stash-mongo mongosh stash --eval 'db.users.countDocuments()'` → `1`.
2. **Add a folder** — Folders tab → FAB → pick a folder containing media files → *Scan now*.
   Files matching the 14 media patterns are hashed (SHA-256) and inserted as `Pending`.
3. **Upload** — Files tab → *Upload files* (or wait for the 15-minute background pass).
   The app: stats the file → logs into MEGA with `megajs` and uploads it there → keeps
   `/temp/uploads/{deviceId}/{name}` as the logical path → produces a v3 record. Because of **L1** the record is stored but the app marks the row `Failed`
   with `Kafka publish failed: Kafka REST produce returned error_code 200`. The backend nevertheless
   picks it up.
   *Check:* Function log shows `Started orchestration <correlationId> for file <sha256>`.
4. **Processing** — the Durable orchestration downloads from Mega (physical name!), verifies the
   hash equals `fileId`, checks dedup, converts HEIC/PNG/RAW→JPEG and MOV→MP4, writes three
   thumbnails, stores the permanent copy as `{Storage:Local:RootPath}\backups\{userId}\{hash}.jpg`
   on disk, deletes the temp file, publishes the response.
   *Check:* the Functions log lists each activity, the configured library root contains one
   `backups\{userId}\{sha256}.jpg` (or `.mp4`), the MEGA account shows the three
   `thumbs_{userId}_{128|256|512}_…` files and **no** `backups_…` file, and the `temp_uploads_…`
   file disappears after the cleanup step.
5. **Response** — the host publishes `stash.upload.response`; the app's consumer polls it but hits
   **L2** (hex key is not JSON) and never applies the record, so the row does not reach `Completed`
   on its own. Inspect the topic instead (Aiven console → Topics → `stash.upload.response` → Messages).
6. **Dedup** — upload the same file again: the backend returns `COMPLETED` with
   `deduplicated: true` and no second copy is written.
7. **DLQ** — produce to `stash.upload.request` with a bad key (not 64-hex) and watch the payload
   land in `stash.dlq` with header `x-dlq-reason`, logged by `DeadLetterHandlerFunction`.

---

## 13. Config reference (all components)

### 13.1 Identity API — `appsettings.json` / env

| Key | Default | Local note |
|---|---|---|
| `Auth:Jwt:SigningKey` | `stash-signing-key-change-in-production-min-32-chars` | must equal the Functions value |
| `Auth:Jwt:Issuer` / `Audience` | `stash-auth` / `stash-app` | must match tokens |
| `Auth:Jwt:AccessTokenExpiryMinutes` | `"15"` | string, parsed as int |
| `Auth:Jwt:RefreshTokenExpiryDays` | `"7"` | |
| `MongoDB:ConnectionString` | `mongodb://localhost:27017` | |
| `MongoDB:DatabaseName` | `stash` | |
| `Cors:AllowedOrigins` | `http://localhost:5102`, `https://localhost:7094` | add `http://localhost:8081` for web |

### 13.2 Functions — `local.settings.json`

See §8.1. Trigger/binding values must be plain app settings (the Kafka extension resolves them by
name); `extensions.kafka.consumerGroup` in `host.json` is the default group, but each function
overrides it (`stash-upload-request`, `stash-dlq-handler`).

### 13.3 RN app — `appconfig.json`

See §11. `UploadSettings.MaxFileSizeBytes` (500 MB), `BatchSize` (10) and
`BackgroundUpload.MaxFilesPerRun` (50) bound the work per pass.

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

# 3) REST proxy reachability (v3 discovery + v2 consumer create)
CID=$(curl -s http://localhost:8082/v3/clusters | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).data[0].cluster_id))")
echo "cluster $CID"
curl -s -o /dev/null -w 'consumer-create=%{http_code}\n' -X POST http://localhost:8082/consumers/smoke-group \
  -H 'Content-Type: application/vnd.kafka.v2+json' \
  -d '{"name":"smoke","format":"json","auto.offset.reset":"earliest","auto.commit.enable":"true"}'
```

The MEGA step is exercised by the app itself (megajs); there is no local endpoint to smoke-test.


---

## 15. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `func: command not found` after npm install | npm 12 skipped the postinstall | install via winget/MSI, or unzip the CLI as in §2.1 |
| Identity API exits with `Auth:Jwt:SigningKey is not configured` | launched from the wrong directory / config not found | run from `StashHost.IdentityApi`, or set the env var |
| Browser: *blocked by CORS policy* on login/register | origin `http://localhost:8081` not allowed | start with `Cors__AllowedOrigins__0=http://localhost:8081` |
| Functions: `Failed to resolve 'kafka.dev.aivencloud.com'` | placeholder broker | set `Kafka:BootstrapServers` to your Aiven host |
| Functions: `SSL handshake failed` / `certificate verify failed` | broker uses Aiven's project CA, librdkafka trusts only the OS store | enable public CA certificates for the service, or import `ca.pem` into the Windows trusted roots |
| Functions: `Authentication failed` / SASL errors | SASL not enabled, wrong user, or Kafka 4.x with librdkafka 2.6.0 | enable `kafka_authentication_methods.sasl`, re-copy credentials, see §3.1 step 5 |
| REST proxy: `Connection to node -1 … failed authentication` | same SASL/CA problem on the Java client side | check `KAFKA_REST_CLIENT_SASL_JAAS_CONFIG` and the PEM truststore |
| Functions: `%Kafka:BootstrapServers%` / no trigger | setting missing or empty | keep the setting name exactly as the trigger references it |
| Orchestration fails immediately with `Download failed … not found` | the app and host disagree on the physical file name (or the upload went to a sub-folder) | keep `src/utils/megaPathMapper.ts` identical to `MegaPathMapper.cs`; the bridge (Appendix A) is only for legacy builds |
| `megajs module not found` in activity logs | `npm install megajs` missing in `bin/Debug/net10.0` | install it there (§8.3) |
| `Local storage is not configured. Set Storage:Local:RootPath …` | permanent-storage setting missing or empty | set `Storage:Local:RootPath` (§8.2) |
| `Store permanent file failed: Access to the path … is denied` | host account cannot write the library folder / share | grant write permission or change `Storage:Local:RootPath` |
| Re-upload always reprocesses instead of deduplicating | `Storage:Local:RootPath` changed, so the hash file lives elsewhere | expected after moving the library; keep the same root for stable dedup |
| App: *MEGA account is not configured* | `Storage.Mega.Email` or `Password` empty | fill both in `appconfig.json` (§11) |
| App: *MEGA login failed … Wrong password?* | MEGA rejected the credentials (or the account has 2FA) | correct the account in `appconfig.json` |
| App: *Kafka REST proxy is not configured* | `Kafka.RestUrl` empty | §11 |
| App: `Kafka REST cluster discovery returned no cluster_id` | talking to Karapace (v2-only) | use the local Confluent proxy (§9) |
| App upload 404 on `/v3/clusters/...` | same as above | same |
| `docker exec … /opt/kafka/...: no such file` | Git Bash path rewrite | prefix with `//` |
| Durable runs but no response in the app | v2 JSON consumer fails parsing the hex key | see L2 |
| FFmpeg conversion fails | FFmpeg not on PATH | set `STASH_FFMPEG_PATH` to the exe, or add it to PATH |
| Ports already in use | another run | `netstat -ano | grep :5102` → `taskkill //PID <pid> //F` |

---

## 16. Known limitations of this local topology

**L1 — The RN transport rejects a successful v3 produce.** `ensureNoRecordError`
(`react_native_stash/src/services/kafkaRestTransport.ts`) throws whenever the response body has a
numeric `error_code` that is not `0`, but Confluent returns `{"error_code":200,…}` for success, so
every successful produce is reported as `Kafka REST produce returned error_code 200`. Records do
reach Kafka; the app marks the file `Failed` with that message. One-line fix: treat `0` and `200` as
success. (The MAUI transport has the same shape.)

**L2 — The response consumer cannot parse the host's key.** The v2 consumer is created with
`format: "json"`, so the REST proxy decodes **both** key and value as JSON. Host responses are keyed
by the raw 64-character SHA-256, which is not valid JSON, so polling returns
`{"error_code":40801,"message":"…Unrecognized token 'aaaa…'"}`. The consumer loop recreates the
consumer every 5 s and never applies a response. Verified against Confluent REST Proxy 7.7.0; with a
JSON-quoted key (`"abc123"`) the same call succeeds, which isolates the cause to the key format.
Until the transport consumes with `format: "binary"` (or the host key is JSON-quoted), the app's file
status stops at `Processing` even though the backend completed the work.

**L3 — Aiven's own REST proxy is not usable.** Karapace implements Confluent REST Proxy v1/v2 only;
the v3 records API (needed for record headers) is not available there. Hence the local proxy.

**L4 — Flat Mega layout.** `MegaPathMapper` encodes the whole logical path into a single root-level
file name; folders are not created in MEGA. A shared account used by other tools may collide on the
encoded prefix, and listing files shows hashed suffixes.

**L5 — The legacy bridge is a dev tool.** Only pre-megajs app builds use it (Appendix A): it performs
a fresh megajs login per process, buffers uploads in memory, has no auth of its own, and ignores the
`X-Mega-*` headers. Never expose it beyond localhost. The current app logs into MEGA on the device,
so its MEGA credentials are bundled with the app.

**L6 — Response topic has no per-user filter.** Every app instance consumes all `stash.upload.response`
records and matches by `fileId`; the REST proxy retains messages for other devices' files. Acceptable
for a single-user dev box.

**L7 — Web is a development target.** Expo web works (SQLite via wasm, document picker via Blob
URIs), but file-system scanning of local folders is only meaningful on Android/iOS.

**L8 — The local library has no per-user access control of its own.** `LocalStorageProvider` writes
`{Storage:Local:RootPath}/backups/{userId}/…` on one filesystem; isolation between users is by folder
name only. Protect the library with OS/share permissions (and back it up yourself) if more than one
person can reach the host. Thumbnails still live in the MEGA account, so the library is not a
self-contained mirror until those move too.

---

## 17. Verification status

Performed on this machine while writing this guide:

| Check | Result |
|---|---|
| `dotnet build` Identity API and Functions | both succeed, 0 warnings |
| Identity API against local MongoDB | `/health` 200; register returns tokens with `userId`/`deviceId` claims |
| Identity API CORS override for `:8081` | `Access-Control-Allow-Origin: http://localhost:8081` present |
| Functions host via `dotnet run` + Azurite | starts, `/api/health` 200, Kafka & Durable extensions load |
| Confluent REST proxy v3 discovery/produce | `200` (`error_code: 200`), record persisted |
| REST proxy v2 consume | works with JSON keys; fails on hex keys (L2) |
| REST proxy CORS for Expo web | `Access-Control-Allow-Origin` echoed |
| `dotnet test StashHost.Tests` | 143 passing: local library round-trip/overwrite/traversal, `StorePermanentActivity` writing a real photo under a temp root, dedup seeing the stored file |
| `npx tsc --noEmit` in `react_native_stash` | exit 0 with the megajs client |
| `npx expo export` (web and android) | both bundle `megajs` (browser build) with no Node built-ins |
| MEGA physical naming parity | `toMegaPhysicalName` produced byte-identical names to `MegaPathMapper.GetPhysicalFileName` for temp/thumb/backup paths |
| megajs login path with the app's crypto shim | MEGA answered `Wrong password?` for a probe account, i.e. PBKDF2/SHA-256 were computed and the login request was accepted |

**Not verified here** — requires your credentials: Aiven connectivity from the Functions host and the
REST proxy, plus a real MEGA upload/download, therefore the full upload → convert → store → response
loop.
The local library path itself needs no credentials; it is covered by the test suite above.

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

## Appendix A — Legacy Mega REST bridge (reference implementation, not used by the current app)

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

`stash.upload.request` (key = SHA-256 hex, headers `Authorization`, `X-Correlation-Id`,
`X-Device-Id`, `X-User-Id`, `X-Message-Version`):

```json
{
  "messageId": "c0f5c1…",
  "timestamp": "2026-11-03T09:12:44.118Z",
  "fileId": "<64 hex sha256>",
  "fileName": "IMG_0001.HEIC",
  "fileSize": 4821004,
  "mimeType": "image/heic",
  "megaTempPath": "/temp/uploads/<deviceId>/IMG_0001.HEIC",
  "metadata": null,
  "deviceId": "<device id>",
  "userId": "<user id>",
  "correlationId": "<uuid>",
  "version": 1
}
```

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
  "correlationId": "<uuid>",
  "version": 1
}
```

Validation rules that cause a DLQ trip (`UploadRequestValidator` + `KafkaTriggerFunction`): version
≠ 1, `fileId` not 64-hex, key ≠ `fileId`, missing/invalid JWT header, JWT `userId`/`deviceId` not
matching the payload, missing correlation id, file name containing separators, `fileSize` ≤ 0 or
> 500 MB, `megaTempPath` not under `/temp/`.

## Appendix C — Optional `docker-compose.yml` for the local infrastructure

```yaml
services:
  mongo:
    image: mongo:7
    ports: ["27017:27017"]

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
