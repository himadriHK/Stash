# Stash - High-Level Architecture Document (v2 - Verified)

**Version:** 2.1  
**Date:** 2026-10-23  
**Last verified against code:** 2026-10-23  
**Status:** Target architecture verified against the HLD/LLD; implementation is **partial**. The backend core exists, but mobile, IaC, CI/CD, production monitoring, live Kafka/Mega verification, and several conversion paths are not implemented. This document marks those boundaries explicitly.

## 1. Executive Summary

**Stash** is a self-hosted backup solution consisting of three primary components:
- **Stash (Mobile App)**: .NET 10 MAUI application for Android/iOS/Windows that scans, uploads, and manages photo/video backups
- **StashHost (Backend)**: .NET 10 Isolated Azure Functions (Durable Functions) orchestrating file processing pipelines
- **Identity API**: ASP.NET Core Minimal API for authentication (register, login, token refresh)

Communication flows through **Aiven-managed Kafka** with **Mega.io** as the primary storage provider. The system follows a local-first, privacy-focused architecture with custom JWT authentication.

### 1.1 Implementation Status (2026-10-23)

| Area | Status |
|------|--------|
| Solution/build | Builds with .NET SDK 10.0.402; 0 errors, 1 ImageSharp license warning |
| Tests | 47 `StashHost.Tests` + 1 template `Stash.Maui.Tests` pass |
| Identity API | Implemented and tested; not deployed |
| StashHost Kafka/Durable pipeline | Implemented; activities partially unit-tested; orchestration/trigger not unit-tested; live `func start` + Kafka + Mega E2E unverified |
| Conversions | PNG→JPEG is tested; WebP→JPEG uses the same path but is untested; HEIC/AVIF/RAW decode and MOV→MP4 do not work |
| Mega paths | Logical paths are flattened to root file names; thumbnail sizes collide |
| Mobile app | Not started; `Stash.Maui` is the template |
| IaC / CI/CD / monitoring | Not present; IaC owner-managed |
| Hosting | Must be Flex Consumption/Premium/Dedicated; classic Consumption cannot run Kafka and .NET 10 on Linux Consumption is unsupported |

---

## 2. System Context Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              EXTERNAL SYSTEMS                               │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐  │
│  │   Mega.io   │    │   Aiven     │    │   FCM/APNs  │    │  Identity   │  │
│  │  (Storage)  │    │  (Kafka)    │    │ (Push Notif)│    │    API      │  │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘    └──────┬──────┘  │
└─────────┼──────────────────┼──────────────────┼──────────────────┼──────────┘
          │                  │                  │                  │
          ▼                  ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              STASH ECOSYSTEM                                │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        STASH MOBILE APP (.NET 10 MAUI)              │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │   │
│  │  │  Folder  │  │  Upload  │  │  Local   │  │  Kafka   │            │   │
│  │  │ Scanner  │──│  Manager │──│   DB     │──│ Producer │            │   │
│  │  │          │  │ (Batching)│  │(SQLite)  │  │+Consumer │            │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └────┬─────┘            │   │
│  │         │                │              │        │                  │   │
│  │         ▼                ▼              ▼        ▼                  │   │
│  │  ┌──────────────────────────────────────────────────────────────┐  │   │
│  │  │                    UI Layer (Google Photos-like)             │  │   │
│  │  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────────────┐   │  │   │
│  │  │  │ Gallery │ │ Settings│ │ Notifs  │ │ Folder Config   │   │  │   │
│  │  │  │  View   │ │         │ │         │ │                 │   │  │   │
│  │  │  └─────────┘ └─────────┘ └─────────┘ └─────────────────┘   │  │   │
│  │  └──────────────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      IDENTITY API (Minimal API)                     │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │   │
│  │  │  Register  │  │    Login     │  │  Refresh     │              │   │
│  │  │  Endpoint  │  │  Endpoint    │  │  Endpoint    │              │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘              │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      STASHHOST (Azure Functions)                    │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │   │
│  │  │  Kafka       │  │  Durable     │  │  Activity    │              │   │
│  │  │  Trigger     │──│  Orchestrator│──│  Functions   │              │   │
│  │  │  Function    │  │  (Fan-out)   │  │  (Processing)│              │   │
│  │  └──────────────┘  └──────────────┘  └──────┬───────┘              │   │
│  │         │                  │                 │                      │   │
│  │         ▼                  ▼                 ▼                      │   │
│  │  ┌──────────────────────────────────────────────────────────────┐  │   │
│  │  │                  Processing Pipeline                          │  │   │
│  │  │  Download → Hash/Dedup → Convert → Thumbnail → Store → Ack   │  │   │
│  │  └──────────────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Status:** this is a target context diagram. The mobile, local DB, scanner, upload manager, Kafka producer/consumer, and push path are design-only. **FCM/APNs is future-only**; v1 uses polling (ADR-007), so it is not a dependency. The Identity API is a separate deployable service; it appears both as an external system and inside the ecosystem. The high-level pipeline omits the temp-delete and response-producer steps; the actual 8-step flow is in section 4.1.

---

## 3. Component Architecture

### 3.1 Stash Mobile Application (.NET 10 MAUI)

> **Implementation status: design only.** `Stash.Maui` is the .NET 10 MAUI template. It has no folder scanner, upload manager, SQLite/EF Core context, Kafka producer/consumer, background upload, SecureStorage, authentication UI, gallery, settings, folder configuration, or notification center. The layers and characteristics below are the target design.

| Layer | Components | Responsibilities |
|-------|------------|------------------|
| **UI Layer** | GalleryView, SettingsPage, FolderConfigPage, NotificationCenter, LoginPage, RegisterPage | Google Photos-like UI, thumbnail grid, folder selection, backup status, auth screens |
| **Application Layer** | BackupOrchestrator, FolderScanner, UploadQueueManager, AuthManager | Coordinate backup jobs, manage upload batches, offline queue, authentication |
| **Domain Layer** | FileEntity, BackupJob, FolderConfig, UploadBatch | Core entities, value objects, domain events |
| **Infrastructure Layer** | SQLiteDbContext, KafkaProducer, KafkaConsumer, MegaStorageProvider (MegaConnectivity.Core), SecureStorage | Data persistence, messaging, storage, credentials |
| **Cross-Cutting** | Logging, Metrics, ErrorHandling, RetryPolicies | Observability, resilience |

**Key Characteristics:**
- Local-first: All metadata in SQLite (EF Core)
- Offline-capable: Persistent queue with background sync
- Batch uploads: 10 files per batch (configurable via `UploadSettings:BatchSize`)
- Polling-based status: No push notifications (v1)
- Consumes `stash.upload.response` topic for completion notifications

### 3.2 Identity API (.NET 10 Minimal API)

| Endpoint | Method | Actual behavior |
|----------|--------|-----------------|
| `/api/auth/register` | POST | Validates email/password/deviceId; PBKDF2-SHA256; returns access + refresh tokens; `409` on duplicate email |
| `/api/auth/login` | POST | Verifies password; `401` on invalid/revoked device; auto-registers a new device ID for an existing user |
| `/api/auth/refresh` | POST | Rotates the refresh token; `401` on invalid/expired/revoked token |
| `/api/auth/revoke` | POST | Revokes all device rows and refresh tokens for a `deviceId`; returns `200` |
| `/health` | GET | Returns a basic health payload |

**Actual project:** `StashHost.IdentityApi` is an ASP.NET Core `Microsoft.NET.Sdk.Web` project, not an Azure Functions project. It is not deployed. If hosted in Azure, use App Service or Container Apps.

**Security gap:** `/api/auth/revoke` has no `RequireAuthorization()` and revokes by `deviceId` across all users. It must be authenticated and scoped to the caller's `userId` before production.

### 3.3 StashHost - Azure Functions (.NET 10 Isolated)

| Function Type | Name | Trigger | Responsibility |
|---------------|------|---------|----------------|
| **Trigger** | `KafkaTriggerFunction` | Kafka `stash.upload.request` (`KafkaRecord[]`, `stash-upload-request` group) | Validates JWT/claims/key, DLQs invalid records, starts orchestration |
| **Orchestrator** | `FileProcessingOrchestration` | Durable Function (`TaskOrchestrationContext`) | Fan-out/fan-in, state management, idempotency; **no configured retry policy** |
| **Activity** | `DownloadFileActivity` | Orchestrator call | Download from Mega.io temp to local temp (whole-file buffering) |
| **Activity** | `ComputeHashActivity` | Orchestrator call | SHA-256 hash computation |
| **Activity** | `CheckDeduplicationActivity` | Orchestrator call | Check if file hash exists in permanent storage |
| **Activity** | `ConvertFormatActivity` | Orchestrator call | **PNG→JPEG tested; WebP uses the same path.** HEIC/AVIF/RAW decode and MOV→MP4 are not implemented |
| **Activity** | `GenerateThumbnailActivity` | Orchestrator call | 128/256/512 fan-out; square resize; image-only (video fails non-fatally) |
| **Activity** | `StorePermanentActivity` | Orchestrator call | Save to Mega.io permanent location (hash-based path) |
| **Activity** | `DeleteTempFileActivity` | Orchestrator call | Delete temp file from Mega.io |
| **Activity** | `SendResponseActivity` | Orchestrator call | Send response to `stash.upload.response` |
| **Trigger** | `DeadLetterHandlerFunction` | Kafka `stash.dlq` (`stash-dlq-handler` group) | Consume/log, critical log for batches >10; **no replay UI/persistence** |
| **HTTP** | `HealthCheckFunction` | HTTP GET `/api/health` | Static health payload; no dependency checks |

**Orchestration Flow:**
```
Kafka Message → Orchestrator Start (instanceId = correlationId)
    │
    ├─► DownloadFileActivity (Activity)
    │
    ├─► ComputeHashActivity (Activity)
    │
    ├─► CheckDeduplicationActivity (Activity) ──► [Exists?] ──Yes──► Skip to SendResponseActivity
    │                                              │
    │                                              No
    │                                              ▼
    ├─► ConvertFormatActivity (Activity) ────────►│
    │                                              │
    ├─► GenerateThumbnails (Activity x3) ────────►│  (fan-out: 128, 256, 512)
    │                                              │
    ├─► StorePermanentActivity (Activity) ───────►│
    │                                              │
    ├─► DeleteTempFileActivity (Activity) ───────►│
    │                                              │
    └─► SendResponseActivity (Activity) ─────────► Kafka Response (stash.upload.response)
```

### 3.4 Infrastructure Components

| Component | Target technology | Actual status |
|-----------|-------------------|---------------|
| **Kafka** | Aiven Managed | Credentials/endpoint in local settings; topic creation manual; broker count/retention not managed in repo |
| **Storage** | Mega.io via `MegaConnectivity.Core` | Partial; root-filename flattening, whole-file buffering, no disposal, live Mega unverified |
| **Functions** | **Flex Consumption** (or Elastic Premium/Dedicated), .NET 10 isolated | Not provisioned. Classic Consumption is invalid for Kafka; .NET 10 on Linux Consumption is unsupported |
| **StashHost Database** | None | Not implemented. Identity API uses MongoDB (`users`, `devices`, `refresh_tokens`) |
| **Monitoring** | App Insights + Log Analytics | Package reference only; no telemetry wiring or alerts |
| **IaC** | Terraform | Not present; owner-managed |
| **CI/CD** | GitHub Actions | Not present |

---

## 4. Data Flow & Communication Patterns

### 4.1 Primary Flow: Mobile → Backend → Storage

> The mobile-side scan/upload/queue portions of this diagram are design-only. The host-side download → hash/dedup → convert → thumbnail → store → respond path exists, with the conversion and Mega path caveats noted above.

```
┌─────────┐    1. Scan & Hash     ┌──────────┐    2. Batch Upload      ┌─────────┐
│ Mobile  │ ─────────────────────► │  Local   │ ──────────────────────► │  Mega   │
│  App    │    (SHA-256 + size)   │   DB     │    (Confluent.Kafka)    │  .io    │
└─────────┘                       └──────────┘        (stash.upload.request)   │  (temp) │
                                    │                                       └────┬────┘
                                    │                                                │
                                    │              3. Process & Store              │
                                    │         ┌──────────────────────────────────┘
                                    ▼         ▼
                              ┌─────────────────────┐
                              │   StashHost         │
                              │ (Durable Functions) │
                              └──────────┬──────────┘
                                         │
                      ┌──────────────────┼──────────────────┐
                      ▼                  ▼                  ▼
                 ┌─────────┐        ┌─────────┐        ┌─────────┐
                 │ Download│        │ Convert │        │Thumbnai │
                 │  File   │        │ Format  │        │   ls    │
                 └────┬────┘        └────┬────┘        └────┬────┘
                      │                  │                  │
                      └──────────────────┼──────────────────┘
                                         ▼
                                  ┌─────────────┐
                                  │   Store     │──► Mega.io (permanent)
                                  │  Permanent  │    /backups/{userId}/{hash}{ext}
                                  └──────┬──────┘
                                         │
                                         ▼
                                  ┌─────────────┐
                                  │  Respond    │──► Kafka (stash.upload.response)
                                  │  to Mobile  │
                                  └─────────────┘
```

### 4.2 Kafka Topic Design

| Topic | Partitions | Retention | Key | Purpose |
|-------|------------|-----------|-----|---------|
| `stash.upload.request` | 10 | 7 days | `file_hash` | Mobile → Host: New file to process |
| `stash.upload.response` | 10 | 7 days | `file_hash` | Host → Mobile: Processing complete |
| `stash.status.events` | 5 | 7 days | `user_id` | Audit trail, debugging (optional - publish from orchestrator) |
| `stash.dlq` | 3 | 30 days | `file_hash` (or `FileId` fallback) | Invalid auth/key/parse messages for manual replay (replay tooling is not implemented) |

**All producers MUST use `file_hash` as message key for proper partitioning.** The host trigger enforces this: a missing key or a key that does not match `fileId` is sent to the DLQ.

**Key caveat:** the trigger compares the key to the client-supplied `FileId`; it does **not** recompute the SHA-256. A client can send an arbitrary `FileId` that matches its own key. Use the computed hash consistently and reject mismatches (see LLD section 2.2.5).

**Actual status:** topic names are hard-coded in the host (`stash.upload.request`, `stash.upload.response`, `stash.dlq`); `stash.status.events` is not implemented. Partition counts and retention are **not managed by this repository**; they are Aiven operational settings. Topics are created manually via the Aiven Console/CLI. Local Kafka setup is not required; development uses the Aiven dev cluster directly.

**Serialization caveat:** the host's `KafkaProducer` uses default `System.Text.Json` options, so responses are PascalCase (`FileId`, `Status`, ...), not the camelCase shown below. The host trigger reads requests case-insensitively. A mobile consumer using default case-sensitive options will not map responses correctly.

### 4.3 Message Contracts

**Upload Request (Mobile → Host):**
```json
{
  "messageId": "uuid",
  "timestamp": "ISO8601",
  "fileId": "sha256_hash",
  "fileName": "IMG_1234.heic",
  "fileSize": 2457600,
  "mimeType": "image/heic",
  "megaTempPath": "/temp/uploads/device123/IMG_1234.heic",
  "metadata": {
    "createdAt": "ISO8601",
    "modifiedAt": "ISO8601",
    "gps": {"lat": 0, "lng": 0},
    "exif": {...}
  },
  "deviceId": "device-uuid",
  "userId": "user-uuid",
  "correlationId": "uuid",
  "version": 1
}
```

`fileId` is intended to be the SHA-256 content hash and is also the Kafka key; the host does not verify it against the downloaded bytes (see section 4.2).

**Upload Response (Host → Mobile):**
```json
{
  "messageId": "uuid",
  "timestamp": "ISO8601",
  "fileId": "sha256_hash",
  "status": "COMPLETED|FAILED",
  "permanentPath": "/backups/user123/sha256_hash.jpg",
  "thumbnails": {
    "128": "/thumbs/user123/128/sha256_hash.jpg",
    "256": "/thumbs/user123/256/sha256_hash.jpg",
    "512": "/thumbs/user123/512/sha256_hash.jpg"
  },
  "convertedFormat": "image/jpeg",
  "deduplicated": false,
  "processingTimeMs": 45230,
  "error": null,
  "correlationId": "uuid",
  "version": 1
}
```

**Kafka Headers (Mobile → Host):**
- `Authorization: Bearer <access_token>` (**required**; missing/invalid → DLQ)
- `X-Device-Id: <device_uuid>` (optional; must match JWT if present)
- `X-User-Id: <user_uuid>` (optional; must match JWT if present)
- `X-Correlation-Id: <correlation_id>` (optional; if absent, the body's `correlationId` is used and is then required)
- `X-Message-Version: 1` (not required by the trigger)

The response does **not** contain `deviceId` or `userId`. The request `userId`/`deviceId` are overwritten from the JWT claims before orchestration. See `ARCHITECTURE_LLD_v2.md` §2.2.8 and §3.2 for the exact contract and the serialization gap.

---

## 5. Security Architecture

### 5.1 Authentication & Authorization

```
┌─────────────────────────────────────────────────────────────────┐
│                      AUTHENTICATION FLOW                        │
│                                                                 │
│  Mobile App              Identity API              StashHost    │
│  ─────────────────────────────────────────────────────────────► │
│  │ 1. POST /register (email, password, deviceId)              │
│  │ 2. Server returns JWT (access + refresh tokens)            │
│  ◄──────────────────────────────────────────────────────────── │
│                                                                 │
│  3. Mobile stores tokens securely (Keychain/Keystore)          │
│                                                                 │
│  4. Each Kafka message includes:                               │
│     - Authorization: Bearer <access_token>                     │
│     - X-Device-Id: <device_uuid>                               │
│     - X-User-Id: <user_uuid>                                   │
│     - X-Correlation-Id: <correlation_id>                       │
│     - X-Message-Version: 1                                     │
│                                                                 │
│  5. StashHost validates JWT on each orchestration start        │
└─────────────────────────────────────────────────────────────────┘
```

**Status:** steps 1–4 (mobile registration, SecureStorage, and Kafka producer) are design-only; the mobile app is a template. Step 5 exists in the host trigger. StashHost validates the JWT locally; it does not call the Identity API.

### 5.2 Network Security

| Connection | Protocol | Authentication | Encryption |
|------------|----------|----------------|------------|
| Mobile → Kafka | SASL_SSL | Username/Password (per device) | TLS (design) |
| Mobile → Mega.io | HTTPS | Session token (from email/pass) | TLS (design) |
| Mobile → Identity API | HTTPS | Email/password → JWT | TLS (design) |
| StashHost → Kafka | SASL_SSL | SCRAM-SHA-256 when username is configured | TLS (negotiated) |
| StashHost → Mega.io | HTTPS | Email/password; **2FA is not implemented** | TLS (negotiated) |
| StashHost → Key Vault | HTTPS | Managed Identity | **Not implemented** |
| StashHost → Identity API | HTTPS | Internal JWT (service-to-service) | **Not used**; StashHost validates JWTs locally |

The previous table asserted TLS 1.3 and Mega 2FA as facts. Neither is verified. `MegaStorageClient` performs email/password login only. Exact TLS versions are negotiated and should not be claimed without a deployment test.

### 5.3 Data Protection

- **At Rest**: Mega.io provider encryption (do not claim a specific algorithm without confirmation)
- **In Transit**: HTTPS/SASL_SSL; exact TLS version is negotiated
- **Secrets**: Key Vault and SecureStorage are **design targets**, not implemented integrations
- **PII**: Kafka messages contain user/device UUIDs and metadata such as EXIF/GPS; do not claim "no PII"
- **Local DB**: SQLite without encryption (design only; no mobile database exists)

---

## 6. Non-Functional Requirements

| Category | Requirement | Target |
|----------|-------------|--------|
| **Availability** | Functions uptime | Target 99.9% on Flex Consumption/Premium/Dedicated; not measured |
| **Latency** | End-to-end backup (median) | Target < 5 minutes for 15MB; not measured |
| **Throughput** | Concurrent orchestrations | 10 per instance (`host.json`); live scaling not measured |
| **Durability** | Message processing | At-least-once + correlationId idempotency; no formal guarantee test |
| **Scalability** | Daily volume | Target 5 GB/day, burst to 50 GB; not load-tested |
| **Recoverability** | RPO/RTO | Target only; DR drill not performed |
| **Observability** | Trace coverage | **Target; no custom telemetry is wired** |

---

## 7. Deployment Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        AZURE SUBSCRIPTION                               │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    RESOURCE GROUP: rg-stash-{env}               │   │
│  │                                                                 │   │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌────────────────┐  │   │
│  │  │  Function App   │  │  App Insights   │  │  Log Analytics │  │   │
│  │  │  (Flex Consump.)│  │  (Workspace)    │  │  Workspace     │  │   │
│  │  │  stashhost-func │  │  stash-insights │  │  stash-logs    │  │   │
│  │  └────────┬────────┘  └────────┬────────┘  └───────┬────────┘  │   │
│  │           │                    │                    │           │   │
│  │  ┌────────┴────────────────────┴────────────────────┴────────┐  │   │
│  │  │                  KEY VAULT: kv-stash-{env}                │  │   │
│  │  │  - Mega.io credentials  - Kafka SASL secrets             │  │   │
│  │  │  - JWT signing keys    - Connection strings              │  │   │
│  │  └───────────────────────────────────────────────────────────┘  │   │
│  │                                                                 │   │
│  │  ┌─────────────────┐  ┌─────────────────┐                     │   │
│  │  │  Identity API   │  │  Storage Acct   │                     │   │
│  │  │ (App Service)   │  │  (for Functions)│                     │   │
│  │  └─────────────────┘  └─────────────────┘                     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                  EXTERNAL: Aiven Kafka (Managed)                │   │
│  │  - SASL_SSL; broker count/retention per Aiven plan              │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

> **Status:** this is a target deployment diagram, not a provisioned environment. No Terraform or CI/CD is present. The Identity API is an ASP.NET Core app, not a Function App. Flex Consumption is mandatory for the Kafka trigger; a classic Consumption plan cannot run it.

### 7.1 Environments

| Environment | Purpose | Functions Plan | Kafka | Mega.io |
|-------------|---------|----------------|-------|---------|
| **Dev** | Developer testing | Flex Consumption (or Premium/Dedicated) | Shared dev cluster | Test account |
| **Staging** | Integration testing | Flex Consumption (or Premium/Dedicated) | Dedicated cluster | Staging account |
| **Prod** | Production | Flex Consumption (or Premium/Dedicated) | Dedicated cluster | Prod account |

---

## 8. Operational Excellence

### 8.1 Monitoring & Alerting

> **Status: target only.** No Application Insights wiring, custom events, alert rules, action groups, or dashboards exist in the repository. The table is a requirements list, not a description of deployed monitoring.

| Metric | Source | Alert Threshold |
|--------|--------|-----------------|
| Orchestration duration | App Insights | > 60 min (P1) |
| Failed orchestrations | App Insights | > 5% in 5 min (P2) |
| Kafka consumer lag | Aiven metrics | > 1000 messages (P2) |
| DLQ message count | App Insights | > 10 messages (P1) |
| Function executions | App Insights | Unexpected spike (P3) |
| Mega.io API errors | App Insights | > 1% error rate (P2) |
| Identity API latency | App Insights | > 2s p99 (P2) |

### 8.2 Disaster Recovery

- **Kafka**: target 7-day retention + 30-day DLQ retention; actual Aiven settings are not managed by this repository
- **Mega.io**: versioning/trash behavior is a provider setting; not verified in this project
- **Functions**: stateless and redeployable, but there is no IaC to redeploy from
- **Mobile DB**: local only (and not implemented yet); user is responsible for device backup

---

## 9. Future Extensibility

| Feature | Architecture Impact |
|---------|---------------------|
| **Multiple storage providers** | StorageProvider abstraction + factory pattern |
| **Multiple Kafka providers** | KafkaClusterProvider abstraction |
| **AI-powered tagging** | New activity in orchestration pipeline |
| **Multi-device sync** | Conflict resolution in orchestrator |
| **Sharing/collaboration** | New Kafka topics, permission model |
| **Web dashboard** | Read model from status events topic |

---

## 10. Decision Log

| ID | Decision | Rationale | Date |
|----|----------|-----------|------|
| ADR-001 | .NET 10 MAUI for mobile | Single codebase, native performance | 2026-10 |
| ADR-002 | **Flex Consumption** (or Premium/Dedicated) for StashHost | **Superseded original "Consumption" choice.** Kafka bindings are unsupported on classic Consumption, and .NET 10 is unsupported on Linux Consumption. Cost remains a consideration, but correctness/hosting support wins. | 2026-10-23 |
| ADR-003 | Durable Functions for orchestration | Built-in reliability, state management | 2026-10 |
| ADR-004 | Aiven Kafka managed | Operational simplicity, SASL_SSL | 2026-10 |
| ADR-005 | Mega.io for storage | Generous free tier, API access; accessed via MegaConnectivity.Core (NodeApi + libnode) | 2026-10 |
| ADR-006 | Custom JWT (no Entra ID) | Self-hosted, privacy-first | 2026-10 |
| ADR-007 | Polling over push (v1) | Simplicity, no FCM dependency | 2026-10 |
| ADR-008 | SHA-256 content hash dedup | Reliable, handles renamed files | 2026-10 |
| ADR-009 | Terraform for IaC (target) | Team familiarity, Azure provider maturity; **not implemented in this repository; owner-managed** | 2026-10 |
| ADR-010 | Identity API as a separate ASP.NET Core Minimal API | **Corrected:** it is a `Microsoft.NET.Sdk.Web` app, not a Function App. It can be hosted on App Service/Container Apps and deployed independently. | 2026-10-23 |
| ADR-011 | Kafka message key = `FileId` (intended `file_hash`) | Ordering per file/partition. The trigger enforces key == client-supplied `FileId`; it does not recompute the SHA-256. **Not exactly-once**; delivery is at-least-once and idempotency is enforced only by the correlationId instance check. | 2026-10-23 |
| ADR-012 | Orchestration instanceId = correlationId | Idempotency, duplicate detection | 2026-10 |
| ADR-013 | No local DB encryption | SQLite used without encryption; **mobile DB is design-only and metadata may contain PII** | 2026-10 |
| ADR-014 | Message versioning (v1) | Forward/backward compatibility; no schema registry/compatibility policy yet | 2026-10 |
| ADR-015 | MongoDB for Identity API only | **Corrected:** StashHost does not use MongoDB; only the Identity API stores `users`, `devices`, `refresh_tokens`. Do not claim StashHost metadata/state tracking. | 2026-10-23 |
| ADR-016 | Kafka topics created manually | Aiven Kafka topics provisioned via Aiven Console/CLI, not Terraform | 2026-10 |
| ADR-017 | No local Kafka | Development uses Aiven dev cluster directly; no Docker Compose needed | 2026-10 |
| ADR-018 | .NET 10 isolated worker on Flex Consumption | Worker ≥ 2.50.0 and `Azure.Functions.Sdk` ≥ 1.0.0 are required for .NET 10; Kafka requires Flex/Premium/Dedicated. `KafkaRecord[]` requires extension 4.3.x at runtime. | 2026-10-23 |