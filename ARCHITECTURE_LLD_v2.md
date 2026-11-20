# Stash - Low-Level Architecture Document (LLD v2 - Verified)

**Version:** 1.2  
**Date:** 2026-10-23  
**Last verified against code:** 2026-10-23  
**Status:** Design verified against HLD v2; implementation status is tracked below and is **not** uniformly complete  
**Based on:** ARCHITECTURE_HLD_v2.md + ARCHITECTURE_VERIFICATION_REPORT.md + stakeholder clarifications

> **Scope note:** This LLD describes the target design and the currently implemented backend. Sections that are design-only are marked explicitly. The mobile app, Terraform, CI/CD, production monitoring, and several conversion paths are **not implemented**. Do not read an unmarked code sample as proof that the feature exists; use the implementation snapshot and verification documents for status.

---

## 1. Executive Summary

This Low-Level Design (LLD v2) document provides detailed technical specifications for building the Stash backup solution. It expands on ARCHITECTURE_HLD_v2.md with concrete class designs, data schemas, interface contracts, processing pipeline details, infrastructure requirements, and implementation guidance. It also distinguishes verified implementation from target design. Not every item from the verification report is resolved; open gaps are listed in section 12.

### 1.1 Solution Overview

| Component | Technology | Responsibility |
|-----------|-----------|----------------|
| Stash Mobile App | .NET 10 MAUI | Scan, upload, local tracking, UI, auth — **Phases 4.1–4.7 code complete; UI and physical background verification outstanding** |
| StashHost Backend | .NET 10 Azure Functions Isolated (Durable) | Orchestrate file processing pipeline — **core implemented, live E2E unverified** |
| Identity API | .NET 10 Minimal API | Register, login, token refresh, JWT issuance — **implemented and unit/integration tested** |
| Storage Provider | Mega.io (abstraction layer) | Object storage for uploaded files — **implemented with root-path limitation** |
| Message Bus | Aiven Kafka (host: direct Confluent.Kafka; mobile: Confluent REST Proxy) | Async communication between mobile and host — **host and mobile implemented; live mobile Kafka unverified** |
| Local Database | SQLite (EF Core) | Mobile app file tracking & metadata (no encryption) — implemented in `Stash.Maui.Data` |
| StashHost Database | None | The old MongoDB metadata/state design is **not implemented**; Durable Task storage holds orchestration state |
| Secrets | Azure Key Vault / SecureStorage | Credentials and JWT signing keys — **Key Vault integration not implemented; mobile tokens use SecureStorage** |
| Monitoring | App Insights + Log Analytics | Logging, metrics, tracing — **basic worker logging only; custom events/alerts not implemented** |
| IaC | Terraform | Infrastructure provisioning (dev/staging/prod) — **not present; owner will handle** |
| CI/CD | GitHub Actions | Build, test, deploy — **not present** |

### 1.2 Verified Decisions (aligned HLD/LLD)

| Decision | Value |
|----------|-------|
| .NET Version | .NET 10 (LTS, supported until 2028-11-14) |
| Authentication | Custom JWT via Identity API — implemented |
| Push Notifications | Polling only (v1) — design only |
| Deduplication | SHA-256 content hash (ADR-008 updated) — implemented |
| Multi-Device | Single device per user (v1) — design only |
| Thumbnail Generation | Both (mobile for UI, host for storage) — **host image thumbnails implemented; mobile thumbnails and video thumbnails not implemented** |
| Background Upload | Yes (WorkManager Android, BackgroundTasks iOS/Windows) — **implemented; physical-device execution unverified** |
| Target Platforms | Android, Windows, iOS, Mac Catalyst (build targets) — app features not implemented |
| Kafka Client | Confluent.Kafka 2.6.0 (host); mobile uses `IKafkaTransport` + Confluent REST Proxy (v3 produce / v2 consume); no native mobile Kafka runtime |
| Kafka Message Key | `FileId` (intended SHA-256 `file_hash`); the trigger enforces key == `FileId` but does not compare it to the computed hash |
| Local DB | SQLite (EF Core) - no encryption — implemented in `Stash.Maui.Data` |
| StashHost DB | **None** — old MongoDB design not implemented; Identity API uses MongoDB (ADR-015 corrected) |
| DI Container | Microsoft.Extensions.DependencyInjection |
| Conversion Formats | Intended: HEIC→JPEG, RAW→JPEG, MOV→MP4, AVIF→JPEG, WEBP→JPEG, PNG→JPEG. **PNG→JPEG is tested; WebP uses the same path but is untested. HEIC/AVIF/RAW decode and MOV→MP4 are not implemented.** |
| Thumbnail Sizes | 128x128, 256x256, 512x512 (ImageSharp resize, aspect ratio not preserved) |
| Compression | Lossless only — not explicitly enforced by current converters |
| Max File Size | 500 MB — design target; current Mega client buffers the whole file in memory |
| Orchestration Instance ID | = correlationId — implemented |
| Concurrent Orchestrations | 10 per instance (host.json) |
| Batch Size | 10 files (configurable via UploadSettings:BatchSize) — implemented in mobile `UploadManager` |
| Environments | Dev, Staging, Prod — Terraform/IaC not present |
| Message Versioning | v1 field added |
| Health Checks | `/api/health` endpoint added — implemented (live host unverified) |
| Kafka Topic Creation | Manual via Aiven Console/CLI (ADR-016) |
| Local Kafka Setup | Not required; Aiven dev cluster used directly (ADR-017) |
| Hosting Plan | **Flex Consumption, Elastic Premium, or Dedicated only** — Kafka bindings are not supported on classic Consumption; .NET 10 is not supported on Linux Consumption |

### 1.3 Implementation Snapshot (2026-10-29)

| Area | Status | Evidence / limitation |
|------|--------|-----------------------|
| Solution | Builds | `dotnet build Stash/Stash.slnx` → 0 errors; 1 Android `XA0141` native page-size warning (`Microsoft.JavaScript.LibNode`) |
| Tests | Pass | `dotnet test Stash/Stash.slnx --no-build` → `StashHost.Tests` 110/110, `Stash.Maui.Tests` 52/52 |
| SDK / TFM | .NET 10 | SDK `10.0.402`; every project targets `net10.0` or `net10.0-<platform>` |
| Functions worker | Compliant for .NET 10 | `Microsoft.Azure.Functions.Worker` `2.52.0` (requires ≥ 2.50.0); `Azure.Functions.Sdk/1.0.0` (requires ≥ 1.0.0); `FUNCTIONS_WORKER_RUNTIME=dotnet-isolated` |
| Durable extension | Floating | `Microsoft.Azure.Functions.Worker.Extensions.DurableTask` is `1.*`; NuGet currently resolves to `1.20.0`. Pin it for reproducible builds. |
| Kafka extension | Risk | `Microsoft.Azure.Functions.Worker.Extensions.Kafka` `4.3.3`; `KafkaRecord[]` compiles, but the deployed host extension bundle must include Kafka extension ≥ 4.3.x. Live binding is unverified. |
| Identity API | Implemented | Register/login/refresh/revoke, PBKDF2-SHA256, Mongo unique email index, `userId`/`deviceId` claims, 17 tests |
| Host pipeline | Implemented, partially unit-tested | Kafka trigger, Durable orchestration, activities, DLQ, health check; activities partially tested; orchestration/trigger have no unit tests; live Kafka/Mega/Azure checks blocked |
| Conversions | Partial | PNG→JPEG tested; WebP path untested; HEIC/AVIF/RAW decode and MOV→MP4 do not work |
| Mega hierarchy | Not honored | Client uploads/finds/deletes by root file name only; logical `/backups`, `/thumbs`, `/temp` paths are flattened |
| Mobile app | Phases 4.1–4.7 code complete | `Stash.Maui` loads embedded `appsettings.json`, binds `StashConfig`, registers shared services, resolves the shell/pages through DI, implements authentication with SecureStorage-backed tokens plus login/register pages, uses a standard SQLite/EF Core database through `Stash.Maui.Data`, implements folder discovery with SHA-256 hashing, uploads files to temp storage with batch/status/retry tracking, produces/consumes upload messages through an injectable REST-proxy Kafka transport, and schedules background uploads with WorkManager/BGTaskScheduler/BackgroundTaskBuilder; the remaining UI features are not implemented |
| IaC / CI/CD / monitoring | Not present | No `terraform/` or `.github/`; Key Vault, alerts, and custom telemetry are design-only |
| ImageSharp | License blocker | `4.1.3` emits a license warning during builds; Release builds require a valid license, and a commercial license or compliant community key is required for production |

**Hosting consequence:** the HLD/LLD's original "Consumption plan" is not a valid target for this design. Kafka bindings are supported only on **Flex Consumption, Elastic Premium, and Dedicated** plans, and .NET 10 is not supported on **Linux Consumption**. See the [Kafka bindings documentation](https://learn.microsoft.com/azure/azure-functions/functions-bindings-kafka) and [.NET isolated guide](https://learn.microsoft.com/azure/azure-functions/dotnet-isolated-process-guide). IaC is intentionally out of scope for this pass and remains the owner's responsibility.

---

## 2. Detailed Component Architecture

### 2.1 Stash Mobile App (.NET 10 MAUI)

> **Implementation status: Phases 4.1–4.7 code complete; Phase 4.8 next.** `Stash/Stash.Maui` now has `StashConfig`, embedded `appsettings.json`, DI registration, DI-created `AppShell`/`MainPage`, an Identity API authentication client, SecureStorage-backed token persistence, login/register pages, a standard SQLite database, a folder scanner with include/exclude filtering and SHA-256 hashing, an upload manager with streamed temp-path uploads, batching, status persistence, retry/error tracking, and in-progress detection, a mobile Kafka producer/consumer over an injectable REST-proxy transport, and a single-flight background upload pass scheduled by Android WorkManager, iOS `BGTaskScheduler`, or Windows `BackgroundTaskBuilder`. The EF Core context, entities, repositories, and migration live in the separate `Stash.Maui.Data` (`net10.0`) project so they can be tested without MAUI; scanner defaults live there too. The gallery, settings, folder configuration, and notification center are still outstanding. Section 2.1.8 documents the actual Phase 4.7 implementation. The project compiles for `net10.0-android`, `net10.0-ios`, `net10.0-maccatalyst`, and `net10.0-windows10.0.19041.0` with `MauiXamlInflator=SourceGen`; the MAUI project emits `NU1608` dependency-range warnings for WorkManager's Lifecycle versions on all target builds, and Android adds one `XA0141` warning for `Microsoft.JavaScript.LibNode` native assets. `Confluent.Kafka` was removed from `Stash.Maui` because it has no supported Android/iOS native runtime. Physical Android/iOS background execution has not been verified.

#### 2.1.1 Project Structure

```
Stash/
├── Stash.Maui/                    # MAUI application project
│   ├── Platforms/
│   │   ├── Android/
│   │   │   ├── MainActivity.cs
│   │   │   ├── MainApplication.cs          # WorkManager initialization
│   │   │   ├── AndroidBackgroundUploadScheduler.cs
│   │   │   └── AndroidManifest.xml
│   │   ├── iOS/
│   │   │   ├── AppDelegate.cs
│   │   │   ├── IosBackgroundUploadScheduler.cs
│   │   │   └── Info.plist
│   │   └── Windows/
│   │       ├── App.xaml.cs
│   │       ├── WindowsBackgroundUploadScheduler.cs
│   │       └── Package.appxmanifest
│   ├── Auth/
│   │   ├── AuthModels.cs
│   │   ├── AuthenticationService.cs
│   │   ├── IAuthenticationService.cs
│   │   ├── ISecureStorageService.cs
│   │   └── MauiSecureStorage.cs
│   ├── Configuration/
│   │   ├── ServiceRegistration.cs
│   │   ├── StashConfig.cs
│   │   └── StashConfiguration.cs
│   ├── Navigation/
│   │   ├── ServiceProviderRouteFactory.cs
│   │   └── StashRoutes.cs
│   ├── ViewModels/
│   │   ├── LoginViewModel.cs
│   │   └── RegisterViewModel.cs
│   ├── Views/
│   │   ├── LoginPage.xaml
│   │   └── RegisterPage.xaml
│   ├── Services/
│   │   ├── IFolderScannerService.cs
│   │   ├── FolderScannerService.cs
│   │   ├── IUploadManager.cs
│   │   ├── UploadManager.cs
│   │   ├── UploadResults.cs
│   │   ├── IKafkaTransport.cs
│   │   ├── KafkaTransportModels.cs
│   │   ├── KafkaRestTransport.cs
│   │   ├── MobileKafkaJson.cs
│   │   ├── KafkaProducer.cs
│   │   ├── KafkaConsumer.cs
│   │   ├── IBackgroundUploadService.cs
│   │   ├── BackgroundUploadService.cs
│   │   ├── BackgroundUploadResult.cs
│   │   ├── IBackgroundUploadScheduler.cs
│   │   ├── NoOpBackgroundUploadScheduler.cs
│   │   └── (thumbnail services planned)
│   ├── Messaging/                       # planned request/response messages
│   ├── App.xaml.cs
│   ├── MauiProgram.cs
│   ├── appsettings.json
│   └── Stash.Maui.csproj
├── Stash.Maui.Data/                     # net10.0 EF Core + SQLite library (Phase 4.3)
│   ├── Entities/
│   │   ├── FileEntity.cs
│   │   ├── FolderConfig.cs
│   │   └── UploadStatus.cs
│   ├── Repositories/
│   │   ├── IFileRepository.cs
│   │   ├── FileRepository.cs
│   │   ├── IFolderRepository.cs
│   │   └── FolderRepository.cs
│   ├── Migrations/
│   │   ├── 20261029064802_InitialCreate.cs
│   │   └── StashDbContextModelSnapshot.cs
│   ├── StashDbContext.cs
│   ├── StashDbContextFactory.cs
│   ├── StashDatabase.cs
│   └── Stash.Maui.Data.csproj
├── Stash.Maui.Tests/
│   ├── Phase4MauiConfigurationTests.cs
│   ├── Phase4AuthenticationTests.cs
│   ├── Phase4LocalDatabaseTests.cs
│   ├── Phase4FolderScannerTests.cs
│   ├── Phase4UploadManagerTests.cs
│   ├── Phase4KafkaTests.cs
│   ├── Phase4BackgroundUploadTests.cs
│   └── (UI tests planned)
└── Stash.slnx
```

#### 2.1.2 Core Service Interfaces

```csharp
// StashConfig.cs - MAUI configuration wrapper
public class StashConfig
{
    public KafkaConfig Kafka { get; set; } = new();       // REST proxy settings + topics
    public StorageConfig Storage { get; set; } = new();
    public AuthConfig Auth { get; set; } = new();         // issuer/audience only; no signing key
    public UploadSettings UploadSettings { get; set; } = new();
    public BackgroundUploadConfig BackgroundUpload { get; set; } = new();
    public string IdentityApiBaseUrl { get; set; } = string.Empty;
    public int IdentityApiTimeoutSeconds { get; set; } = 30;
}

public sealed class KafkaConfig
{
    public string RestUrl { get; set; } = string.Empty;       // required for mobile Kafka
    public string RestUsername { get; set; } = string.Empty;  // optional HTTP basic auth
    public string RestPassword { get; set; } = string.Empty;
    public int RestTimeoutSeconds { get; set; } = 30;
    public string ClusterId { get; set; } = string.Empty;     // optional; discover via /v3/clusters
    public string TopicUploadRequest { get; set; } = "stash.upload.request";
    public string TopicUploadResponse { get; set; } = "stash.upload.response";
    public string TopicDeadLetter { get; set; } = "stash.dlq";
}

// IFolderScannerService.cs
public interface IFolderScannerService
{
    Task<IReadOnlyList<FileInfo>> ScanFolderAsync(
        string folderPath, CancellationToken ct = default);

    Task<IReadOnlyList<FileInfo>> ScanFolderAsync(
        string folderPath,
        IReadOnlyCollection<string>? includePatterns,
        IReadOnlyCollection<string>? excludePatterns,
        bool includeSubfolders,
        CancellationToken ct = default);

    Task<IReadOnlyList<FileInfo>> ScanFolderAsync(
        FolderConfig folder, CancellationToken ct = default);

    Task<string> ComputeFileHashAsync(
        string filePath, CancellationToken ct = default);

    Task<bool> IsFolderAccessibleAsync(string folderPath);
}

// IUploadManager.cs
public interface IUploadManager
{
    Task<UploadResult> UploadFileAsync(
        FileEntity file, string megaTempPath, CancellationToken ct = default);
    Task<UploadResult> UploadFileAsync(
        FileEntity file, CancellationToken ct = default);
    Task<UploadBatchResult> UploadBatchAsync(
        IEnumerable<FileEntity> files, CancellationToken ct = default);
    Task<bool> IsUploadInProgressAsync(Guid fileId);
}

// UploadResults.cs
public sealed record UploadResult(
    Guid FileId, bool Success, string? MegaTempPath, string? ErrorMessage);

public sealed record UploadBatchResult(
    IReadOnlyList<UploadResult> Results, int BatchSize, int BatchCount)
{
    public int TotalCount { get; }
    public int SuccessCount { get; }
    public int FailureCount { get; }
    public bool AllSucceeded { get; }
}

// IKafkaProducer.cs (shared) - Uses string key (file_hash)
public interface IKafkaProducer
{
    Task ProduceUploadRequestAsync(UploadRequestMessage message, CancellationToken ct);
    Task ProduceUploadResponseAsync(UploadResponseMessage message, CancellationToken ct);
}

// Mobile-only transport contract. Implementations must be safe on Android/iOS.
public interface IKafkaTransport
{
    Task ProduceAsync(KafkaTransportMessage message, CancellationToken ct = default);
    Task ConsumeAsync(
        string topic,
        string groupId,
        Func<KafkaTransportRecord, CancellationToken, Task> onRecord,
        CancellationToken ct = default);
}

// Mobile-only consumer lifecycle (implemented by KafkaConsumer).
public interface IKafkaConsumer
{
    Task ConsumeUploadResponsesAsync(CancellationToken ct = default);
    Task StartAsync(CancellationToken ct = default);
    Task StopAsync(CancellationToken ct = default);
}

// IStorageProvider.cs (shared between mobile and host)
public interface IStorageProvider
{
    Task<string> UploadFileAsync(Stream fileStream, string remotePath, CancellationToken ct);
    Task<bool> DeleteFileAsync(string remotePath, CancellationToken ct);
    Task<Stream> DownloadFileAsync(string remotePath, CancellationToken ct);
    Task<bool> FileExistsAsync(string remotePath, CancellationToken ct);
    Task<long> GetFileSizeAsync(string remotePath, CancellationToken ct);
}

// IAuthenticationService.cs
public interface IAuthenticationService
{
    Task<AuthResult> RegisterAsync(string email, string password, string deviceId, CancellationToken ct);
    Task<AuthResult> LoginAsync(string email, string password, string deviceId, CancellationToken ct);
    Task<string> GetAccessTokenAsync(CancellationToken ct = default);
    Task<bool> EnsureValidAccessTokenAsync(CancellationToken ct = default); // refresh when expired
    Task<string> GetUserIdAsync(CancellationToken ct = default);   // used for X-User-Id
    Task<bool> RefreshTokenAsync(CancellationToken ct = default);
    Task LogoutAsync(CancellationToken ct = default);
    Task<bool> RevokeDeviceAsync(string deviceId, CancellationToken ct = default);
    Task<string> GetOrCreateDeviceIdAsync(CancellationToken ct = default);
}

// IThumbnailService.cs
public interface IThumbnailService
{
    Task<Stream> GenerateThumbnailAsync(string filePath, int size, CancellationToken ct);
    Task<string> SaveThumbnailAsync(Stream thumbnail, string fileId, int size, CancellationToken ct);
}

// IBackgroundUploadService.cs
public interface IBackgroundUploadService
{
    Task<BackgroundUploadResult> RunOnceAsync(CancellationToken ct = default);
}

// IBackgroundUploadScheduler.cs
public interface IBackgroundUploadScheduler
{
    Task ScheduleAsync(CancellationToken ct = default);
    Task CancelAsync(CancellationToken ct = default);
}

// ISecureStorageService.cs - MAUI SecureStorage wrapper (implemented)
public interface ISecureStorageService
{
    Task SetAsync(string key, string value, CancellationToken ct);
    Task<string?> GetAsync(string key, CancellationToken ct);
    Task RemoveAsync(string key, CancellationToken ct);
}
```

#### 2.1.3 Domain Models

```csharp
// FileEntity.cs
public class FileEntity
{
    public Guid Id { get; set; }
    public string FileName { get; set; } = string.Empty;
    public string FilePath { get; set; } = string.Empty;
    public long FileSize { get; set; }
    public string ContentHash { get; set; } = string.Empty; // SHA-256 (renamed from FileHash)
    public string MimeType { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; }
    public DateTime ModifiedAt { get; set; }
    public DateTime DiscoveredAt { get; set; }
    public UploadStatus Status { get; set; } = UploadStatus.Pending;
    public string? MegaTempPath { get; set; }
    public string? PermanentPath { get; set; }
    public string? ErrorMessage { get; set; }
    public int RetryCount { get; set; }
    public DateTime? LastAttemptAt { get; set; }
    public string DeviceId { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
    public Dictionary<string, string> Thumbnails { get; set; } = new();
    public string? ConvertedFormat { get; set; }
    public bool IsDeduplicated { get; set; }
}

// UploadSettings.cs
public class UploadSettings
{
    public int BatchSize { get; set; } = 10;
    public int MaxRetries { get; set; } = 3;
    public long MaxFileSizeBytes { get; set; } = 500 * 1024 * 1024; // 500 MB
}

// BackgroundUploadConfig.cs
public sealed class BackgroundUploadConfig
{
    public bool Enabled { get; set; } = true;
    public int IntervalMinutes { get; set; } = 15;
    public int MaxFilesPerRun { get; set; } = 50; // <= 0 means unlimited
}

// FolderConfig.cs
public class FolderConfig
{
    public Guid Id { get; set; }
    public string FolderPath { get; set; } = string.Empty;
    public string FolderName { get; set; } = string.Empty;
    public bool IsEnabled { get; set; } = true;
    public DateTime AddedAt { get; set; }
    public DateTime? LastScannedAt { get; set; }
    // MediaFilePatterns.DefaultIncludePatterns: JPG/JPEG/PNG/HEIC/HEIF/RAW/DNG/CR2/NEF/ARW/MOV/MP4/AVIF/WebP
    public List<string> IncludePatterns { get; set; } = MediaFilePatterns.CreateDefaultIncludePatterns();
    public List<string> ExcludePatterns { get; set; } = new();
    public bool IncludeSubfolders { get; set; } = true;
}

// UploadStatus enum
public enum UploadStatus
{
    Pending,
    Scanning,
    Hashing,
    Uploading,
    Uploaded,
    Processing,
    Completed,
    Failed,
    Retrying,
    Deduplicated
}

// JwtToken.cs
public class JwtToken
{
    public string AccessToken { get; set; } = string.Empty;
    public string RefreshToken { get; set; } = string.Empty;
    public DateTime ExpiresAt { get; set; }
    public string UserId { get; set; } = string.Empty;
    public string DeviceId { get; set; } = string.Empty;
}

// AuthResult.cs - mobile result wrapper. The Identity API returns raw JwtToken
// objects on success and { "error": "..." } on failure.
public class AuthResult
{
    public bool IsSuccess { get; set; }
    public JwtToken? Token { get; set; }
    public string? Error { get; set; }
}
```

#### 2.1.4 DbContext Design (Standard SQLite, no encryption)

`Stash.Maui.Data` owns the EF Core model, repositories, design-time factory, and migration. The context receives `DbContextOptions<StashDbContext>`; it does not call `FileSystem` itself, so the plain test project can use a temporary database. The MAUI app supplies the platform AppDataDirectory path.

```csharp
// Stash.Maui.Data/StashDbContext.cs
public sealed class StashDbContext : DbContext
{
    public StashDbContext(DbContextOptions<StashDbContext> options) : base(options) { }

    public DbSet<FileEntity> Files => Set<FileEntity>();
    public DbSet<FolderConfig> FolderConfigs => Set<FolderConfig>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<FileEntity>(entity =>
        {
            entity.ToTable("Files");
            entity.HasKey(e => e.Id).HasName("PK_Files");

            entity.Property(e => e.ContentHash).IsRequired().HasMaxLength(64);
            entity.Property(e => e.Status).HasConversion<string>().HasMaxLength(32);
            entity.Property(e => e.Thumbnails)
                .HasConversion(/* Dictionary<string,string> <-> JSON TEXT */)
                .HasColumnType("TEXT");

            entity.HasIndex(e => e.ContentHash).IsUnique().HasDatabaseName("IX_Files_ContentHash");
            entity.HasIndex(e => e.Status).HasDatabaseName("IX_Files_Status");
            entity.HasIndex(e => e.DeviceId).HasDatabaseName("IX_Files_DeviceId");
            entity.HasIndex(e => e.UserId).HasDatabaseName("IX_Files_UserId");
        });

        modelBuilder.Entity<FolderConfig>(entity =>
        {
            entity.ToTable("FolderConfigs");
            entity.HasKey(e => e.Id).HasName("PK_FolderConfigs");
            entity.Property(e => e.IncludePatterns)
                .HasConversion(/* List<string> <-> JSON TEXT */)
                .HasColumnType("TEXT");
            entity.Property(e => e.ExcludePatterns)
                .HasConversion(/* List<string> <-> JSON TEXT */)
                .HasColumnType("TEXT");
            entity.HasIndex(e => e.FolderPath).IsUnique().HasDatabaseName("IX_FolderConfigs_FolderPath");
        });
    }
}
```

`Status` is stored as text; `Thumbnails`, `IncludePatterns`, and `ExcludePatterns` are serialized JSON TEXT so standard SQLite tools can read the database. `AddStashData(databasePath)` registers `IDbContextFactory<StashDbContext>` and transient repositories; each repository operation creates a fresh context, avoiding a shared singleton `DbContext`.

#### 2.1.5 MauiProgram.cs (DI Registration)

```csharp
var configuration = StashConfiguration.LoadEmbedded(typeof(MauiProgram).Assembly);

builder.Services.AddSingleton<ISecureStorageService, MauiSecureStorage>();
builder.Services.AddStashServices(configuration);

var databasePath = Path.Combine(FileSystem.AppDataDirectory, StashDatabase.FileName);
builder.Services.AddStashData(databasePath);

builder.Services.AddTransient<LoginViewModel>();
builder.Services.AddTransient<RegisterViewModel>();
builder.Services.AddTransient<LoginPage>();
builder.Services.AddTransient<RegisterPage>();

var app = builder.Build();

// Apply the EF Core migration before repositories are used.
app.Services.InitializeStashDatabase();

return app;
```

`StashDatabase.FileName` is `stash.db`; on Windows the unpackaged app created it under `%LOCALAPPDATA%\User Name\com.companyname.stash.maui\Data\stash.db`. The `Stash.Maui.Data` project is part of `Stash.slnx`. Future scanner/upload/Kafka services will be registered alongside the existing auth/data registrations.

#### 2.1.6 MegaStorageProvider Implementation (Unified)

```csharp
// MegaStorageProvider.cs - Wrapper around MegaConnectivity.Core
public class MegaStorageOptions
{
    public string Email { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;
}

public class MegaStorageProvider : IStorageProvider, IAsyncDisposable
{
    private readonly MegaStorageOptions _options;
    private readonly ILogger<MegaStorageProvider> _logger;
    private MegaStorageClient? _client;
    private readonly object _initLock = new();
    private bool _disposed;

    public MegaStorageProvider(IOptions<MegaStorageOptions> options, ILogger<MegaStorageProvider> logger)
    {
        _options = options.Value;
        _logger = logger;
    }

    private MegaStorageClient EnsureClient()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(MegaStorageProvider));
        if (_client is not null) return _client;
        lock (_initLock)
        {
            if (_client is not null) return _client;
            _client = new MegaStorageClient(_options.Email, _options.Password);
            _ = _client.InitializeAsync(); // fire-and-forget; operations await EnsureInitializedAsync
            return _client;
        }
    }

    private async Task EnsureInitializedAsync(CancellationToken ct)
    {
        var client = EnsureClient();
        await client.InitializeAsync(ct);
    }

    private static string GetFileName(string remotePath)
    {
        if (string.IsNullOrEmpty(remotePath))
            throw new ArgumentException("Remote path cannot be empty.", nameof(remotePath));
        var trimmed = remotePath.TrimEnd('/');
        var lastSlash = trimmed.LastIndexOf('/');
        return lastSlash >= 0 ? trimmed[(lastSlash + 1)..] : trimmed;
    }

    public async Task<string> UploadFileAsync(Stream fileStream, string remotePath, CancellationToken ct)
    {
        if (fileStream is null) throw new ArgumentNullException(nameof(fileStream));
        if (!fileStream.CanRead) throw new ArgumentException("Source stream must be readable.", nameof(fileStream));
        await EnsureInitializedAsync(ct);

        var fileName = GetFileName(remotePath);
        long fileSize = fileStream.CanSeek ? fileStream.Length : 0;

        var info = await _client!.UploadFileAsync(fileName, fileStream, fileSize, ct);
        _logger.LogInformation("Uploaded {FileName} ({Size} bytes) to {RemotePath}", fileName, info.Size, remotePath);
        return remotePath;
    }

    public async Task<bool> DeleteFileAsync(string remotePath, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(remotePath)) throw new ArgumentException("Remote path cannot be empty.", nameof(remotePath));
        await EnsureInitializedAsync(ct);

        var fileName = GetFileName(remotePath);
        if (!await _client!.FileExistsAsync(fileName, ct)) return false;
        await _client!.DeleteFileAsync(fileName, permanent: true, ct);
        _logger.LogInformation("Deleted {FileName} from {RemotePath}", fileName, remotePath);
        return true;
    }

    public async Task<Stream> DownloadFileAsync(string remotePath, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(remotePath)) throw new ArgumentException("Remote path cannot be empty.", nameof(remotePath));
        await EnsureInitializedAsync(ct);

        var fileName = GetFileName(remotePath);
        if (!await _client!.FileExistsAsync(fileName, ct))
            throw new FileNotFoundException($"File not found: {fileName}", fileName);

        var destination = new MemoryStream();
        await _client!.DownloadFileAsync(fileName, destination, ct);
        destination.Position = 0;
        _logger.LogInformation("Downloaded {FileName} ({Size} bytes) from {RemotePath}", fileName, destination.Length, remotePath);
        return destination;
    }

    public async Task<bool> FileExistsAsync(string remotePath, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(remotePath)) throw new ArgumentException("Remote path cannot be empty.", nameof(remotePath));
        await EnsureInitializedAsync(ct);
        return await _client!.FileExistsAsync(GetFileName(remotePath), ct);
    }

    public async Task<long> GetFileSizeAsync(string remotePath, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(remotePath)) throw new ArgumentException("Remote path cannot be empty.", nameof(remotePath));
        await EnsureInitializedAsync(ct);
        return await _client!.GetFileSizeAsync(GetFileName(remotePath), ct);
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        if (_client is not null)
        {
            try { await _client.CloseAsync(); } catch { }
            _client.Dispose();
            _client = null;
        }
    }
}
```

#### 2.1.7 Kafka Producer/Consumer (REST Proxy Transport)

**Transport decision.** Mobile builds do **not** reference `Confluent.Kafka`. `librdkafka.redist` has no supported Android/iOS runtime, and the package previously leaked Linux native assets into the Android build. The mobile app instead depends on `IKafkaTransport`, implemented by `KafkaRestTransport` over a Confluent REST Proxy.

**Produce uses REST Proxy v3, consume uses v2.** The v2 JSON produce API can only carry `key`, `value`, and `partition`; it cannot set Kafka record headers. The host trigger requires `Authorization`, `X-Device-Id`, `X-User-Id`, `X-Correlation-Id`, and `X-Message-Version`, so produce uses:

```
POST {RestUrl}/v3/clusters/{clusterId}/topics/{topic}/records
Content-Type: application/json
```

with a base64 `BINARY` key, base64 header values, and a JSON value:

```json
{
  "key":   { "type": "BINARY", "data": "<base64 sha256>" },
  "value": { "type": "JSON",   "data": { "fileId": "...", "...": "..." } },
  "headers": [
    { "name": "Authorization",    "value": "<base64 Bearer token>" },
    { "name": "X-Device-Id",      "value": "<base64 device id>" },
    { "name": "X-User-Id",        "value": "<base64 user id>" },
    { "name": "X-Correlation-Id", "value": "<base64 correlation id>" },
    { "name": "X-Message-Version","value": "<base64 1>" }
  ]
}
```

`Kafka:ClusterId` is used when configured; otherwise the transport calls `GET /v3/clusters` once and caches the first `cluster_id`. A path prefix such as `/kafka` in `RestUrl` is preserved for both APIs.

Responses are consumed through the v2 consumer API:

```
POST {RestUrl}/consumers/{groupId}                     -> { base_uri, instance_id }
POST {base_uri}/subscription                          -> 204
GET  {base_uri}/records?timeout=10000&max_bytes=...    -> JSON records
DELETE {base_uri}                                     -> 204
```

The consumer instance name is unique per start, while the group ID stays stable at `stash-mobile-{deviceId}`. `format=json`, `auto.offset.reset=earliest`, and `auto.commit.enable=true` are set. The loop recreates the consumer if the proxy returns `404`, and deletes the instance on shutdown.

**Required headers and key.** `UploadRequestMessage.FileId` (lowercase SHA-256) is always the Kafka key. Missing user/device IDs fall back to `IAuthenticationService.GetUserIdAsync` / `GetOrCreateDeviceIdAsync`. The producer calls `EnsureValidAccessTokenAsync`, refreshes a missing/near-expiry token, and rejects the produce if no usable token is available instead of sending an unauthenticated request.

**Failure mode.** `Kafka:RestUrl` is empty in the checked-in `appsettings.json`. `KafkaRestTransport` throws a clear `InvalidOperationException` on first use:

```
Kafka REST proxy is not configured. Set Kafka:RestUrl in appsettings.json.
```

Startup is not blocked. Optional `Kafka:RestUsername` / `Kafka:RestPassword` add HTTP Basic authentication; they are placeholders and must be replaced by a per-device/proxy secret design before production.

```csharp
// IKafkaTransport.cs (mobile)
public interface IKafkaTransport
{
    Task ProduceAsync(KafkaTransportMessage message, CancellationToken ct = default);
    Task ConsumeAsync(
        string topic,
        string groupId,
        Func<KafkaTransportRecord, CancellationToken, Task> onRecord,
        CancellationToken ct = default);
}

// KafkaProducer.cs (mobile) - key = file_hash, required headers
public sealed class KafkaProducer : IKafkaProducer
{
    private readonly IKafkaTransport _transport;
    private readonly IAuthenticationService _auth;
    private readonly StashConfig _config;

    public async Task ProduceUploadRequestAsync(
        UploadRequestMessage message, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(message.FileId))
            throw new ArgumentException("Upload requests require a file hash key.");

        var authenticated = await _auth.EnsureValidAccessTokenAsync(ct);
        var token = authenticated ? await _auth.GetAccessTokenAsync(ct) : string.Empty;
        if (string.IsNullOrWhiteSpace(token))
            throw new InvalidOperationException("No authenticated access token is available.");

        message.DeviceId = string.IsNullOrWhiteSpace(message.DeviceId)
            ? await _auth.GetOrCreateDeviceIdAsync(ct) : message.DeviceId;
        message.UserId = string.IsNullOrWhiteSpace(message.UserId)
            ? await _auth.GetUserIdAsync(ct) : message.UserId;
        message.CorrelationId = string.IsNullOrWhiteSpace(message.CorrelationId)
            ? Guid.NewGuid().ToString() : message.CorrelationId;

        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["Authorization"] = $"Bearer {token}",
            ["X-Device-Id"] = message.DeviceId,
            ["X-User-Id"] = message.UserId,
            ["X-Correlation-Id"] = message.CorrelationId,
            ["X-Message-Version"] = "1"
        };

        await _transport.ProduceAsync(new KafkaTransportMessage(
            _config.Kafka.TopicUploadRequest,
            message.FileId,
            MobileKafkaJson.Serialize(message),
            headers), ct);
    }
}

// KafkaConsumer.cs (mobile) - stable per-installation group
public sealed class KafkaConsumer : IKafkaConsumer, IAsyncDisposable
{
    public async Task ConsumeUploadResponsesAsync(CancellationToken ct = default)
    {
        var deviceId = await _auth.GetOrCreateDeviceIdAsync(ct);
        await _transport.ConsumeAsync(
            _config.Kafka.TopicUploadResponse,
            $"stash-mobile-{deviceId}",
            HandleRecordAsync,
            ct);
    }

    private async Task HandleRecordAsync(KafkaTransportRecord record, CancellationToken ct)
    {
        var response = MobileKafkaJson.Deserialize<UploadResponseMessage>(record.Value);
        if (response is null || string.IsNullOrWhiteSpace(response.FileId)) return;

        var file = await _repository.GetByContentHashAsync(response.FileId, ct);
        if (file is null) return;

        file.Status = string.Equals(response.Status, "COMPLETED", StringComparison.OrdinalIgnoreCase)
            ? UploadStatus.Completed : UploadStatus.Failed;
        file.PermanentPath = response.PermanentPath;
        file.Thumbnails = response.Thumbnails ?? new Dictionary<string, string>();
        file.ConvertedFormat = response.ConvertedFormat;
        file.IsDeduplicated = response.Deduplicated;
        file.ErrorMessage = response.Error;
        file.LastAttemptAt = DateTime.UtcNow;

        await _repository.UpdateAsync(file, ct);
    }
}
```

`MobileKafkaJson` uses `JsonSerializerDefaults.Web` with `PropertyNameCaseInsensitive = true`, so mobile requests are camelCase and the host's PascalCase responses still map. Status parsing is case-insensitive.

> **Verification status:** request key/headers, v3 REST mapping, v2 consumer flow, response status updates, and DI registration are covered by 8 mocked tests. No live REST proxy or Kafka cluster is configured; live produce/consume, proxy authentication, and end-to-end host responses remain unverified.

#### 2.1.8 Background Upload Service

**Actual design (Phase 4.7).** Background execution is split into one platform-independent upload pass and a platform-specific scheduler. The pass is idempotent, single-flight, and bounded by `BackgroundUpload:MaxFilesPerRun`.

```csharp
// IBackgroundUploadService.cs (shared)
public interface IBackgroundUploadService
{
    Task<BackgroundUploadResult> RunOnceAsync(CancellationToken ct = default);
}

// IBackgroundUploadScheduler.cs (platform-specific implementation)
public interface IBackgroundUploadScheduler
{
    Task ScheduleAsync(CancellationToken ct = default);
    Task CancelAsync(CancellationToken ct = default);
}
```

`BackgroundUploadService.RunOnceAsync`:

1. Ensures a usable access token through `EnsureValidAccessTokenAsync`, refreshing when the stored token is missing or within one minute of expiry.
2. Loads enabled folders and scans each one through `IFolderScannerService`.
3. SHA-256 hashes each file, skips content already present by hash, and inserts new `FileEntity` rows as `Pending`.
4. Uploads `Pending`, `Retrying`, `Uploaded`, and retryable `Failed` files through `IUploadManager.UploadBatchAsync`.
5. Publishes an `UploadRequestMessage` through `IKafkaProducer` for each successful upload, then sets the local status to `Processing`.
6. Persists `Failed` plus `RetryCount`/`ErrorMessage` when the Kafka publish fails, and `Retrying` when the background window expires between upload and publish.
7. Updates each folder's `LastScannedAt` after a successful scan.

A `SemaphoreSlim(1,1)` guard returns `AlreadyRunning` instead of starting a second pass. Per-folder scan failures are logged and do not abort the other folders. The service returns `BackgroundUploadResult` with scanned/discovered/uploaded/queued/failed counts.

```csharp
// BackgroundUploadResult.cs (shared)
public sealed record BackgroundUploadResult(
    bool Success,
    bool AlreadyRunning,
    bool Canceled,
    int Scanned,
    int Discovered,
    int Uploaded,
    int Queued,
    int Failed,
    string? ErrorMessage);
```

**Platform schedulers:**

| Target | Implementation | Behavior |
|--------|----------------|----------|
| Android | `AndroidBackgroundUploadScheduler` + `BackgroundUploadWorker` | WorkManager `PeriodicWorkRequest` with network-connected constraint; interval clamped to 15 minutes; unique work name `stash-background-upload`; worker resolves `IBackgroundUploadService` from `IPlatformApplication.Current.Services` |
| iOS | `IosBackgroundUploadScheduler` | `BGTaskScheduler` registers `com.companyname.stash.maui.upload`, submits a `BGProcessingTaskRequest` with network requirement, and reschedules after completion; `Info.plist` contains `UIBackgroundModes=processing` and `BGTaskSchedulerPermittedIdentifiers` |
| Windows | `WindowsBackgroundUploadScheduler` + `WindowsBackgroundUploadTask` | `BackgroundTaskBuilder` with `TimeTrigger(15)` and `InternetAvailable` condition; `Package.appxmanifest` declares the `windows.backgroundTasks` timer extension and `internetClient` capability; registration is expected to fail while `WindowsPackageType=None` and is logged rather than crashing |
| Mac Catalyst / unknown | `NoOpBackgroundUploadScheduler` | Logs that no background scheduler is registered |

The Android scheduler uses `ExistingPeriodicWorkPolicy.Keep` so reopening the app does not reset the 15-minute period; disable/enable re-registers the work. If the interval changes while work is already enqueued, call `CancelAsync`/`ScheduleAsync` (or clear app data) to apply it.

`AddStashBackgroundUploadServices()` selects the scheduler at compile time (`ANDROID`, `IOS`, `WINDOWS`, else no-op). `MauiProgram` invokes `ScheduleAsync()` during startup so the iOS launch handler is registered before `FinishedLaunching` returns.

```json
"BackgroundUpload": {
  "Enabled": true,
  "IntervalMinutes": 15,
  "MaxFilesPerRun": 50
}
```

Android's minimum supported OS is now **API 23**, because WorkManager requires it. WorkManager 2.10.5 resolves against the MAUI AndroidX set but emits `NU1608` warnings for Lifecycle 2.9.4 vs 2.9.2.1 constraints; these are dependency-range warnings, not build errors.

> **Verification status:** 9 Phase 4.7 service/DI unit tests pass, and all four MAUI targets compile. **No physical Android/iOS device or packaged Windows deployment was available**, so actual background wake-up, WorkManager execution, `BGProcessingTask` execution, and upload continuation while backgrounded remain unverified. The Windows task cannot register in the current unpackaged configuration.

---

### 2.2 StashHost (Azure Functions - Durable)

#### 2.2.1 Project Structure (actual)

```text
Stash/
├── Stash.slnx                         # solution (MegaConnectivity.Core is built transitively, not listed)
├── StashHost.Functions/
│   ├── Activities/
│   │   ├── StoragePathBuilder.cs
│   │   ├── DownloadFileActivity.cs
│   │   ├── ComputeHashActivity.cs
│   │   ├── CheckDeduplicationActivity.cs
│   │   ├── ConvertFormatActivity.cs
│   │   ├── ConverterInterfaces.cs
│   │   ├── ConverterFactory.cs
│   │   ├── GenerateThumbnailActivity.cs
│   │   ├── ThumbnailGenerator.cs
│   │   ├── StorePermanentActivity.cs
│   │   ├── DeleteTempFileActivity.cs
│   │   └── SendResponseActivity.cs
│   ├── Functions/
│   │   ├── KafkaTriggerFunction.cs
│   │   ├── DeadLetterHandlerFunction.cs
│   │   └── HealthCheckFunction.cs
│   ├── Middleware/
│   │   ├── IJwtValidator.cs           # IJwtValidator + JwtValidator
│   │   └── JwtValidationMiddleware.cs # thin bool wrapper around JwtValidator
│   ├── Orchestrations/
│   │   └── FileProcessingOrchestration.cs
│   ├── Services/
│   │   └── KafkaProducer.cs
│   ├── Program.cs
│   ├── ServiceCollectionExtensions.cs
│   ├── host.json
│   ├── local.settings.json
│   └── StashHost.Functions.csproj
├── StashHost.Shared/
│   ├── Contracts/
│   │   ├── IKafkaProducer.cs
│   │   ├── IStorageProvider.cs
│   │   └── IStorageProviderFactory.cs
│   ├── Messages/
│   │   └── Messages.cs                # all message, context, result, options types
│   └── Services/
│       ├── MegaStorageProvider.cs
│       └── StorageProviderFactory.cs
├── StashHost.IdentityApi/
│   ├── Models/                        # User, Device, RefreshToken, JwtToken, requests
│   ├── Services/
│   │   ├── IJwtService.cs
│   │   ├── JwtService.cs
│   │   ├── IUserStore.cs
│   │   ├── MongoUserStore.cs
│   │   ├── IPasswordHasher.cs
│   │   ├── PasswordHasher.cs
│   │   └── AuthExceptions.cs
│   ├── Program.cs
│   └── StashHost.IdentityApi.csproj
├── MegaConnectivity.Core/             # NodeApi + libnode Mega client
├── Stash.Maui/                        # Phase 4.1–4.2 config/auth + DI; remaining feature code pending
├── StashHost.Tests/
│   ├── Phase2IdentityApiTests.cs
│   └── Phase3BackendTests.cs
└── Stash.Maui.Tests/
```

**Files that do not exist:** `OrchestratorFunction.cs`, `StashHost.Functions/Models/`, `StashHost.Functions/Services/IKafkaConsumer.cs`, `StashHost/Functions/IAuthenticationService.cs`, `StashHost/IdentityApi/`, and `StashHost.sln`. The Identity API is `StashHost.IdentityApi` (ASP.NET Core web project), not an Azure Functions project. `FunctionApp1/` remains on disk but is not in `Stash.slnx`; it is stale template code.

#### 2.2.2 host.json (Durable Functions Concurrency)

The checked-in `host.json` matches the block below. Notes:

- The `durableTask` concurrency values are active.
- The Kafka triggers set explicit `ConsumerGroup` values (`stash-upload-request`, `stash-dlq-handler`); the `extensions.kafka.consumerGroup` value (`stash-host`) is not the value used by those triggers.
- No Durable retry policy is configured in `host.json`. Activity failures are handled in orchestration code (and the delete step has one manual replay-safe retry).
- The extension bundle range `[4.*, 5.0.0)` is valid for Functions v4. For `KafkaRecord[]`, verify the deployed bundle contains Kafka extension 4.3.x or newer; otherwise use the documented `KafkaEventData<string>[]`/`string[]` shape.

```json
{
  "version": "2.0",
  "logging": {
    "applicationInsights": {
      "samplingSettings": {
        "isEnabled": true,
        "maxTelemetryItemsPerSecond": 5
      }
    }
  },
  "extensionBundle": {
    "id": "Microsoft.Azure.Functions.ExtensionBundle",
    "version": "[4.*, 5.0.0)"
  },
  "extensions": {
    "durableTask": {
      "maxConcurrentActivityFunctions": 10,
      "maxConcurrentOrchestratorFunctions": 10
    },
    "kafka": {
      "consumerGroup": "stash-host"
    }
  }
}
```

#### 2.2.3 Durable Functions Orchestration (actual)

The implementation uses the isolated-worker Durable API (`Microsoft.DurableTask`), not the in-process `IDurableOrchestrationContext` / `[FunctionName]` API.

```csharp
// Orchestrations/FileProcessingOrchestration.cs (key excerpt)
public class FileProcessingOrchestration
{
    [Function(nameof(FileProcessingOrchestration))]
    public async Task RunOrchestration([OrchestrationTrigger] TaskOrchestrationContext context)
    {
        var request = context.GetInput<UploadRequestMessage>()
            ?? throw new InvalidOperationException("Orchestration requires an UploadRequestMessage input.");

        var processingContext = new ProcessingContext
        {
            MessageId = request.MessageId,
            FileId = request.FileId,
            FileName = request.FileName,
            FileSize = request.FileSize,
            MimeType = request.MimeType,
            MegaTempPath = request.MegaTempPath,
            UserId = request.UserId,
            DeviceId = request.DeviceId,
            CorrelationId = request.CorrelationId,
            // Replay-safe timestamp. Do not use DateTime.UtcNow in an orchestration.
            StartTime = context.CurrentUtcDateTime
        };

        // 1. Download
        var downloadResult = await context.CallActivityAsync<ActivityResult>(
            "DownloadFileActivity", processingContext);
        if (!downloadResult.IsSuccess)
        {
            await HandleFailureAsync(context, processingContext, downloadResult.Error);
            return;
        }
        processingContext.LocalFilePath = downloadResult.GetData<string>() ?? string.Empty;

        // 2. SHA-256
        var hashResult = await context.CallActivityAsync<ActivityResult>(
            "ComputeHashActivity", processingContext.LocalFilePath);
        if (!hashResult.IsSuccess)
        {
            await HandleFailureAsync(context, processingContext, hashResult.Error);
            return;
        }
        processingContext.FileHash = hashResult.GetData<string>() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(processingContext.FileHash))
        {
            await HandleFailureAsync(context, processingContext, "Hash computation returned an empty result.");
            return;
        }

        // 3. Dedup. A failed dedup check is fatal; it must not be treated as "not found".
        var dedupResult = await context.CallActivityAsync<ActivityResult>(
            "CheckDeduplicationActivity", processingContext);
        if (!dedupResult.IsSuccess)
        {
            await HandleFailureAsync(context, processingContext, dedupResult.Error);
            return;
        }
        if (dedupResult.GetData<bool>())
        {
            processingContext.IsDeduplicated = true;
            processingContext.PermanentPath = StoragePathBuilder.GetPermanentPath(
                processingContext.UserId, processingContext.FileHash,
                processingContext.FileName, processingContext.MimeType);
            processingContext.ConvertedFormat = GetConvertedFormat(processingContext.MimeType);
            await SendResponseAsync(context, processingContext, "COMPLETED", deduplicated: true);
            return;
        }

        // 4. Convert
        var convertResult = await context.CallActivityAsync<ActivityResult>(
            "ConvertFormatActivity", processingContext.LocalFilePath);
        if (!convertResult.IsSuccess)
        {
            await HandleFailureAsync(context, processingContext, convertResult.Error);
            return;
        }
        processingContext.ConvertedFilePath = convertResult.GetData<string>() ?? string.Empty;
        processingContext.ConvertedFormat = GetConvertedFormat(processingContext.MimeType);

        // 5. Thumbnail fan-out (128, 256, 512). Individual failures are non-fatal.
        var thumbnailTasks = new List<Task<ActivityResult>>();
        foreach (var size in new[] { 128, 256, 512 })
        {
            thumbnailTasks.Add(context.CallActivityAsync<ActivityResult>(
                "GenerateThumbnailActivity", new ThumbnailRequest
                {
                    FilePath = processingContext.ConvertedFilePath,
                    Size = size,
                    FileId = processingContext.FileHash, // hash, not the message FileId alias
                    UserId = processingContext.UserId
                }));
        }
        await Task.WhenAll(thumbnailTasks);

        var thumbnails = new Dictionary<string, string>();
        foreach (var task in thumbnailTasks)
        {
            var result = await task;
            if (!result.IsSuccess) continue;
            var thumbData = result.GetData<Dictionary<string, string>>();
            if (thumbData is null) continue;
            foreach (var kvp in thumbData) thumbnails[kvp.Key] = kvp.Value;
        }
        processingContext.Thumbnails = thumbnails;

        // 6. Permanent store (normalized extension).
        var storeResult = await context.CallActivityAsync<ActivityResult>(
            "StorePermanentActivity", processingContext);
        if (!storeResult.IsSuccess)
        {
            await HandleFailureAsync(context, processingContext, storeResult.Error);
            return;
        }
        processingContext.PermanentPath = storeResult.GetData<string>() ?? string.Empty;

        // 7. Delete temp. Cleanup failure is non-fatal, but one replay-safe retry is attempted
        // and the failure is logged with the replay-safe logger.
        var deleteResult = await context.CallActivityAsync<ActivityResult>(
            "DeleteTempFileActivity", processingContext.MegaTempPath);
        if (!deleteResult.IsSuccess)
        {
            deleteResult = await context.CallActivityAsync<ActivityResult>(
                "DeleteTempFileActivity", processingContext.MegaTempPath);
        }
        if (!deleteResult.IsSuccess)
        {
            var logger = context.CreateReplaySafeLogger(nameof(FileProcessingOrchestration));
            logger.LogWarning("Temporary file cleanup failed for {MegaTempPath}: {Error}",
                processingContext.MegaTempPath, deleteResult.Error);
        }

        // 8. Response
        await SendResponseAsync(context, processingContext, "COMPLETED", deduplicated: false);
    }
}
```

`SendResponseAsync` and `HandleFailureAsync` use `context.NewGuid()` for `MessageId` and `context.CurrentUtcDateTime` for `Timestamp`/`ProcessingTimeMs`. They call `SendResponseActivity` with an `UploadResponseMessage`. `GetConvertedFormat` maps HEIC/HEIF/AVIF/WebP/PNG/RAW MIME types to `image/jpeg`, `video/quicktime` to `video/mp4`, and otherwise echoes the MIME type. The mapping is declarative: a conversion can still fail in `ConvertFormatActivity` (see 2.2.9).

**Important:** `ActivityResult.Data` crosses the activity boundary as JSON. Read it with `GetData<T>()`; a direct cast such as `(string)result.Data` fails because the value is deserialized as `JsonElement`.

#### 2.2.4 Activity Functions (actual)

All activities are class methods with `[Function(nameof(...))]` and `[ActivityTrigger]` parameters. They return `ActivityResult`; they do **not** throw for expected failures, so the orchestration can send a `FAILED` response instead of retrying indefinitely.

| Activity | Input | Actual behavior |
|----------|-------|-----------------|
| `DownloadFileActivity` | `ProcessingContext` | Downloads from Mega.io into a new unique local directory (`%TEMP%/stash/{guid}/`), uses `Path.GetFileName(context.FileName)` to prevent traversal, returns the local path. |
| `ComputeHashActivity` | local path string | SHA-256, lowercase hex via `Convert.ToHexString(...).ToLowerInvariant()`. |
| `CheckDeduplicationActivity` | `ProcessingContext` | Requires `UserId` and `FileHash`; checks `StoragePathBuilder.GetPermanentPath(...)`. A storage exception returns failure (not `false`). |
| `ConvertFormatActivity` | local path string | Requires an existing file; resolves the first converter whose `Supports(extension)` is true; no converter means pass-through (JPEG/MP4); converter exceptions return failure. |
| `GenerateThumbnailActivity` | `ThumbnailRequest` | Uses `IThumbnailGenerator` (ImageSharp) and uploads to `StoragePathBuilder.GetThumbnailPath(UserId, FileId, Size)`; returns a one-entry dictionary keyed by size. A video file fails here and the orchestration continues with the remaining thumbnails. |
| `StorePermanentActivity` | `ProcessingContext` | Requires an existing converted file, `UserId`, and `FileHash`; uses `StoragePathBuilder.GetPermanentPath(...)`; uploads the stream. |
| `DeleteTempFileActivity` | Mega temp path string | Calls `DeleteFileAsync`; catches exceptions and returns failure. The orchestration retries once. |
| `SendResponseActivity` | `UploadResponseMessage` | Calls `IKafkaProducer.ProduceUploadResponseAsync`; the producer uses `message.FileId` as the key. |

**Canonical paths (`StoragePathBuilder`):**

```csharp
// All converted image sources normalize to .jpg; MP4/MOV normalize to .mp4.
public static string GetPermanentPath(string userId, string fileHash, string fileName, string? mimeType)
    => $"/backups/{userId}/{fileHash}{GetPermanentExtension(fileName, mimeType)}";

public static string GetThumbnailPath(string userId, string fileHash, int size)
    => $"/thumbs/{userId}/{size}/{fileHash}.jpg";
```

`DownloadFileActivity` excerpt:

```csharp
var safeFileName = Path.GetFileName(context.FileName);
if (string.IsNullOrWhiteSpace(safeFileName)) safeFileName = "download";
var localDirectory = Path.Combine(Path.GetTempPath(), "stash", Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(localDirectory);
var localPath = Path.Combine(localDirectory, safeFileName);
```

**Thumbnail caveat:** `ThumbnailGenerator` calls `image.Mutate(x => x.Resize(size, size))`. This forces a square image and does not preserve aspect ratio. It also only works for formats ImageSharp can decode; video thumbnails are not implemented.

**Mega caveat:** `StorageProviderFactory.Create()` constructs a new `MegaStorageProvider` for every activity call. Each provider lazily creates a Node.js runtime and logs in. Activities do not dispose the provider. This is a resource/latency risk and is documented as a gap, not a working feature.

#### 2.2.5 Kafka Trigger Function (InstanceId = CorrelationId)

```csharp
// Functions/KafkaTriggerFunction.cs (signature and control flow)
[Function(nameof(KafkaTriggerFunction))]
public async Task Run(
    [KafkaTrigger(
        "Kafka:BootstrapServers",
        "stash.upload.request",
        ConsumerGroup = "stash-upload-request",
        Username = "Kafka:Username",
        Password = "Kafka:Password",
        Protocol = BrokerProtocol.SaslSsl,
        AuthenticationMode = BrokerAuthenticationMode.ScramSha256,
        IsBatched = true)]
    KafkaRecord[] events,
    [DurableClient] DurableTaskClient durableClient,
    FunctionContext executionContext,
    CancellationToken cancellationToken)
{
    foreach (var record in events)
    {
        var payload = record.Value is { Length: > 0 } ? Encoding.UTF8.GetString(record.Value) : string.Empty;
        try { await ProcessRecordAsync(record, payload, durableClient, cancellationToken); }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to process Kafka message at offset {Offset}", record.Offset);
            await SendToDeadLetterAsync(record, payload, ex.Message, cancellationToken);
        }
    }
}
```

`ProcessRecordAsync` performs these checks in order and sends a DLQ message on each failure:

1. JSON deserialization (`PropertyNameCaseInsensitive = true`) and non-null request.
2. JWT validation from the `Authorization` header using `IJwtValidator`. Missing/invalid token → DLQ.
3. `userId` and `deviceId` claims must be present.
4. If the payload supplies `UserId`/`DeviceId`, they must match the JWT exactly.
5. `X-User-Id` / `X-Device-Id` headers, if present, must match the JWT.
6. `X-Correlation-Id`, if present, must match `request.CorrelationId`; otherwise it is copied into the request. A missing correlation ID → DLQ.
7. Kafka key must be present and must equal `request.FileId` (case-insensitive). `request.FileId` is intended to be the SHA-256 hash, but the trigger does not verify it against the downloaded file.
8. Idempotency: `durableClient.GetInstanceAsync(correlationId)` is checked first. An existing instance is logged and skipped. Otherwise `ScheduleNewOrchestrationInstanceAsync(nameof(FileProcessingOrchestration), request, new StartOrchestrationOptions { InstanceId = correlationId })` is called.

The JWT is authoritative: the trigger overwrites `request.UserId` and `request.DeviceId` with the claims before scheduling. `stash.dlq` messages preserve the original key when present and add an `x-dlq-reason` header; if the key was missing, the producer uses `request.FileId` as a fallback.

**Runtime dependency:** `KafkaRecord[]` is available in `Microsoft.Azure.Functions.Worker.Extensions.Kafka` 4.3.3. The deployed Functions host must also have a Kafka extension version that understands the `KafkaRecord` protobuf transport. If live verification fails, fall back to the documented `KafkaEventData<string>[]` shape and adjust the header/key helpers. This is a **live-verification gap**, not a proven working path.

**Hosting requirement:** Kafka triggers are supported only on Flex Consumption, Elastic Premium, or Dedicated plans. A classic Consumption plan will not run this function.

**Hash consistency gap:** the trigger checks the Kafka key against `request.FileId`, but it does **not** recompute the SHA-256 and compare it. The orchestration later computes `FileHash` and uses it for deduplication, permanent storage, and thumbnails, while the response's `FileId` still comes from `request.FileId`. A bad client hash that matches its own key therefore produces a response keyed to the wrong value. Compare `request.FileId` with the computed hash and reject on mismatch (or use the computed hash consistently).

#### 2.2.6 Dead Letter Handler Function

```csharp
[Function(nameof(DeadLetterHandlerFunction))]
public Task Run(
    [KafkaTrigger(
        "Kafka:BootstrapServers",
        "stash.dlq",
        ConsumerGroup = "stash-dlq-handler",
        Username = "Kafka:Username",
        Password = "Kafka:Password",
        Protocol = BrokerProtocol.SaslSsl,
        AuthenticationMode = BrokerAuthenticationMode.ScramSha256,
        IsBatched = true)]
    KafkaRecord[] events)
{
    if (events.Length > 10)
        _logger.LogCritical("DLQ alert: received {Count} messages in a single batch (threshold 10)", events.Length);

    foreach (var record in events)
    {
        var payload = record.Value is { Length: > 0 } ? Encoding.UTF8.GetString(record.Value) : string.Empty;
        var reason = GetHeader(record.Headers, "x-dlq-reason") ?? "unknown";
        // Deserialize UploadRequestMessage, log FileId/Reason/Offset/Key.
    }
    return Task.CompletedTask;
}
```

**What exists:** consumption of `stash.dlq`, `x-dlq-reason` parsing, per-message warning logging, and a critical log when one batch exceeds 10 messages.

**What does not exist:** persistence of DLQ messages, a manual replay UI, replay tooling, or an Azure Monitor alert resource. The critical log is only useful if the deployed platform forwards it to an alert; that wiring is not in the repository.

#### 2.2.7 Health Check Function

```csharp
[Function(nameof(HealthCheckFunction))]
public static async Task<HttpResponseData> Run(
    [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "health")] HttpRequestData req,
    FunctionContext executionContext)
{
    var response = req.CreateResponse(HttpStatusCode.OK);
    response.Headers.Add("Content-Type", "application/json");
    await response.WriteStringAsync("{\"status\":\"healthy\",\"timestamp\":\"" + DateTime.UtcNow + "\"}");
    return response;
}
```

The route is `/api/health` by default. The payload is a hand-built JSON string with a `DateTime.UtcNow` value; it is not a dependency health check and does not test Kafka, Mega, Mongo, or the Durable backend. The live endpoint is unverified because `func` is not installed in the development environment.

#### 2.2.8 Models and ActivityResult

All message/context types are in `StashHost.Shared/Messages/Messages.cs`. They are plain mutable classes with public setters, so Durable Functions can serialize them.

```csharp
public class ProcessingContext
{
    public string MessageId { get; set; } = string.Empty;
    public string FileId { get; set; } = string.Empty;       // payload alias for the hash
    public string FileName { get; set; } = string.Empty;
    public long FileSize { get; set; }
    public string MimeType { get; set; } = string.Empty;
    public string MegaTempPath { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
    public string DeviceId { get; set; } = string.Empty;
    public string CorrelationId { get; set; } = string.Empty;
    public string? FileHash { get; set; }                    // computed SHA-256, lowercase hex
    public string? LocalFilePath { get; set; }
    public string? ConvertedFilePath { get; set; }
    public string? ConvertedFormat { get; set; }
    public string? PermanentPath { get; set; }
    public Dictionary<string, string> Thumbnails { get; set; } = new();
    public bool IsDeduplicated { get; set; }
    public DateTime StartTime { get; set; }
}
```

`ActivityResult` is deliberately JSON-safe. The `[JsonConstructor]` is required: without it, the private constructor is not usable by the Durable serializer and `IsSuccess`/`Data` come back as defaults after an activity boundary. `GetData<T>()` is required because `object` values deserialize as `JsonElement`.

```csharp
public class ActivityResult
{
    public bool IsSuccess { get; private set; }
    public object? Data { get; private set; }
    public string? Error { get; private set; }

    [JsonConstructor]
    public ActivityResult(bool isSuccess, object? data, string? error)
    {
        IsSuccess = isSuccess;
        Data = data;
        Error = error;
    }

    public static ActivityResult Success(object? data = null) => new(true, data, null);
    public static ActivityResult Failure(string error) => new(false, null, error);

    public T? GetData<T>()
    {
        if (Data is null) return default;
        if (Data is T typed) return typed;
        if (Data is JsonElement element)
        {
            try { return element.Deserialize<T>(); }
            catch (JsonException) { return default; }
        }
        return default;
    }
}
```

`ThumbnailRequest` includes `UserId`; the old design omitted it, which made the canonical `/thumbs/{userId}/...` path impossible for the activity.

```csharp
public class ThumbnailRequest
{
    public string FilePath { get; set; } = string.Empty;
    public int Size { get; set; }
    public string FileId { get; set; } = string.Empty; // hash
    public string UserId { get; set; } = string.Empty;
}
```

`UploadRequestMessage` and `UploadResponseMessage` both carry `Version = 1`. The response contract does **not** contain `DeviceId` or `UserId`; the host uses the correlation ID and the mobile app already knows which local file it sent. Do not list `deviceId`/`userId` as required response fields.

```csharp
public class UploadResponseMessage
{
    public string MessageId { get; set; } = Guid.NewGuid().ToString();
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;
    public string FileId { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty; // COMPLETED | FAILED
    public string? PermanentPath { get; set; }
    public Dictionary<string, string> Thumbnails { get; set; } = new();
    public string? ConvertedFormat { get; set; }
    public bool Deduplicated { get; set; }
    public long ProcessingTimeMs { get; set; }
    public string? Error { get; set; }
    public string CorrelationId { get; set; } = string.Empty;
    public int Version { get; set; } = 1;
}
```

**Wire-format note (resolved on mobile):** the host `KafkaProducer` still serializes with default options, so host responses use **PascalCase** (`FileId`, `Status`, ...), while mobile requests use camelCase. The host trigger reads case-insensitively, and `MobileKafkaJson` now also deserializes case-insensitively. A Phase 4.6 test covers PascalCase responses. The host should still be normalized to camelCase for consistency, but there is no mobile interop break today.

#### 2.2.9 Image/Video Converters (actual and limitations)

Actual interfaces are `IConverter`/`IImageConverter`/`IVideoConverter`; `IConverterFactory.GetConverter(extension)` returns the first matching converter. The implementations are stateless and registered as singletons.

| Converter | `Supports` extensions | Actual capability |
|-----------|----------------------|-------------------|
| `ImageConverter` | `.heic`, `.avif`, `.webp`, `.png` | **ImageSharp 4 provides PNG and WebP decoders; only PNG is unit-tested.** Its built-in codecs do not include HEIC/HEIF or AVIF, so `Image.Load` throws for those files. |
| `RawImageConverter` | `.raw`, `.cr2`, `.nef`, `.arw`, `.dng` | **No RAW decoder.** It calls the same `Image.Load` as `ImageConverter` and fails for every listed RAW format. |
| `VideoConverter` | `.mov` | **Not implemented.** It throws `NotSupportedException`; FFmpeg.AutoGen is referenced but no transcoding path exists. It deliberately does not copy MOV bytes into a `.mp4` container. |

```csharp
public class ImageConverter : IImageConverter
{
    public bool Supports(string extension) => extension.ToLower() switch
    {
        ".heic" or ".avif" or ".webp" or ".png" => true,
        _ => false
    };

    public async Task<string> ConvertAsync(string inputPath, CancellationToken ct)
    {
        var outputPath = Path.ChangeExtension(inputPath, ".jpg");
        using var image = Image.Load(inputPath); // throws for HEIC/AVIF with ImageSharp 4
        image.Mutate(x => x.AutoOrient());
        await image.SaveAsJpegAsync(outputPath, ct);
        return outputPath;
    }
}
```

`Supports()` is only a routing predicate. It is **not** proof that the codec is installed. The unit tests currently assert the support flags, not successful HEIC/AVIF/RAW conversion. To close these gaps, add a HEIF/AVIF decoder (for example a native libheif binding) and a RAW decoder (LibRaw or Magick.NET), then add real fixture-based conversion tests. For MOV→MP4, add native FFmpeg libraries and an FFmpeg.AutoGen transcode path.

`ThumbnailGenerator` uses `image.Mutate(x => x.Resize(size, size))`. That forces a square and distorts aspect ratio; a fit/crop strategy is still a design decision. Video thumbnails are not supported: the activity fails and the orchestration continues with the remaining thumbnail results.

**ImageSharp licensing:** `SixLabors.ImageSharp` 4.1.3 is under the Six Labors Split License. Builds emit a license warning (the Debug build continues); Release builds require a valid license, and production use requires a commercial license or a compliant community key. This is a release blocker unless the license is resolved.

#### 2.2.10 Identity API (ASP.NET Core Minimal API, actual)

`StashHost.IdentityApi` is a `Microsoft.NET.Sdk.Web` project targeting `net10.0`, not an Azure Functions project. It is not deployed by any repository IaC.

**Endpoints (actual):**

| Method | Route | Behavior |
|--------|-------|----------|
| `POST` | `/api/auth/register` | Validates email, password length ≥ 8, and device ID; hashes the password with PBKDF2-SHA256 (100,000 iterations, 16-byte salt, 32-byte key); creates the user and device; returns access + refresh tokens. Duplicate email → `409`. Invalid input → `400`. |
| `POST` | `/api/auth/login` | Normalizes email, verifies the PBKDF2 hash, rejects inactive users and revoked devices (`401`); a new device ID is auto-registered for an existing user; returns tokens. |
| `POST` | `/api/auth/refresh` | Looks up the refresh token, rejects revoked/expired tokens (`401`), revokes the old token, validates the user/device, and issues a rotated pair. |
| `POST` | `/api/auth/revoke` | Requires `deviceId`; marks **all** device rows with that device ID revoked and revokes all matching refresh tokens. Returns `200`. |
| `GET` | `/health` | Returns `{"status":"healthy","timestamp":...}`. |

**JWT:** HMAC-SHA256; issuer `stash-auth`; audience `stash-app`; access token 15 minutes; refresh token 7 days; `ClockSkew = TimeSpan.Zero`. Claims include `ClaimTypes.NameIdentifier`, `userId`, `ClaimTypes.Email`, `deviceId`, `device_id`, `jti`, and `iat`.

**MongoDB:** database `stash` by default; collections `users`, `devices`, `refresh_tokens`; camelCase element names via a convention pack; unique index `ux_users_email`. A concurrent duplicate registration is converted from Mongo error 11000 to `409`.

**CORS:** only registered when `Cors:AllowedOrigins` contains at least one origin. Native mobile clients do not need CORS.

**Security gaps to fix before production:**

- `/api/auth/revoke` has **no `RequireAuthorization()`**. Anyone who knows a `deviceId` can revoke that device. It also revokes by `deviceId` across all users, not scoped to the authenticated `userId`.
- No rate limiting or lockout on register/login/refresh.
- No `ProblemDetails`; errors are anonymous `{ "error": ... }` objects.
- The development signing key is a local setting, not Key Vault.

#### 2.2.11 JWT Validation for Kafka Headers (actual)

`JwtValidator` implements `IJwtValidator.Validate(IDictionary<string, object> headers)` and returns a `ClaimsPrincipal` or `null`. It looks up `Authorization` case-insensitively, accepts `string` and `byte[]` header values, strips `Bearer ` case-insensitively, and validates issuer, audience, lifetime, and signing key with zero clock skew. `JwtValidationMiddleware` is only a boolean wrapper around `JwtValidator`; the Functions host registers `IJwtValidator`, not the wrapper.

```csharp
public ClaimsPrincipal? Validate(IDictionary<string, object> headers)
{
    if (headers is null || !TryGetHeader(headers, "Authorization", out var authHeader))
        return null;

    var headerValue = NormalizeHeaderValue(authHeader);
    if (string.IsNullOrWhiteSpace(headerValue)) return null;

    var token = headerValue.Trim();
    if (token.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        token = token["Bearer ".Length..].Trim();

    // ... TokenValidationParameters: issuer, audience, lifetime, signing key, ClockSkew = Zero
    return tokenHandler.ValidateToken(token, validationParameters, out _);
}
```

#### 2.2.12 MongoDB Usage (corrected)

**StashHost does not use MongoDB.** `StashHost.Functions.csproj` references `MongoDB.Driver` 3.12.0, but no `StashHost` collection, repository, or state store is implemented. Durable Functions state is held by the Durable Task storage provider configured by the host; processing metadata is not persisted to Mongo.

| Database | Actual use | Collections |
|----------|------------|-------------|
| `stash` (Identity API) | **Yes** | `users`, `devices`, `refresh_tokens` |
| StashHost processing state | **No** | None; the old `files`, `orchestrations`, `processing_logs` design is not implemented |

Do not describe the Identity API and StashHost as sharing a MongoDB database until a StashHost store is actually added. If one is added, give it a distinct database name or an explicit ownership boundary.

### 2.3 Storage Provider Abstraction

#### 2.3.1 Interface Definition

```csharp
// IStorageProvider.cs (shared between mobile and host)
public interface IStorageProvider
{
    Task<string> UploadFileAsync(Stream fileStream, string remotePath, CancellationToken ct);
    Task<bool> DeleteFileAsync(string remotePath, CancellationToken ct);
    Task<Stream> DownloadFileAsync(string remotePath, CancellationToken ct);
    Task<bool> FileExistsAsync(string remotePath, CancellationToken ct);
    Task<long> GetFileSizeAsync(string remotePath, CancellationToken ct);
}
```

#### 2.3.2 Mega.io Implementation (Shared, Options-based)

Implemented in `StashHost.Shared/Services/MegaStorageProvider.cs` on top of `MegaConnectivity.Core`. The provider exposes the logical paths used by the pipeline, but the current Mega client **does not create or honor directory hierarchies**. Every operation extracts the last path segment with `GetFileName(remotePath)` and calls the client with that root-level file name.

| Logical path | Actual Mega operation | Consequence |
|--------------|----------------------|-------------|
| `/temp/uploads/{deviceId}/{fileName}` | Upload/find/delete root-level `{fileName}` | Device isolation is not enforced in Mega; two devices uploading the same file name collide. |
| `/backups/{userId}/{hash}{normalizedExt}` | Upload/find/delete root-level `{hash}{normalizedExt}` | User isolation is not enforced in Mega; paths are cosmetic. Dedup still works for hash-named files because the hash is globally unique. Images use `.jpg`; videos use `.mp4`. |
| `/thumbs/{userId}/{size}/{hash}.jpg` | Upload/find/delete root-level `{hash}.jpg` | **Thumbnail sizes collide.** A 128, 256, and 512 thumbnail for the same hash all use the same root name, so later uploads overwrite earlier ones. |
| `/temp/...` cleanup | Delete root-level `{fileName}` | A cleanup for one user/device can delete another user's file with the same name. |

**Required fix:** either implement Mega folder creation/lookup in `MegaConnectivity.Core`, or encode the logical path into the root file name (for example `{userId}_{size}_{hash}.jpg`) and keep logical path mapping in the provider. Until then, do not claim that `/backups`, `/thumbs`, or `/temp` isolation works.

**Memory and lifetime:** `UploadFileAsync` reads the entire stream into a `byte[]`, and `DownloadFileAsync` writes the entire remote file into a `MemoryStream`. A 500 MB upload/processing job therefore needs roughly the file size in managed memory (plus the byte array copy). That is a poor fit for a 1.5 GB Flex Consumption instance when several orchestrations run concurrently. `StorageProviderFactory.Create()` constructs a new provider per activity, and each provider lazily creates a Node.js runtime and logs in. Activities never dispose the provider. This multiplies Node runtimes/logins and can exhaust resources. Use a shared, disposed-at-shutdown provider (or a small pool), and add a streaming/chunked Mega client if 500 MB files are a real requirement.

#### 2.3.3 Storage Provider Factory

The factory is implemented as follows. It selects a provider from `Storage:Provider` (default `Mega`) and constructs `MegaStorageProvider` with `Storage:Mega:Email` and `Storage:Mega:Password`.

```csharp
public class StorageProviderFactory : IStorageProviderFactory
{
    private readonly IConfiguration _config;

    public StorageProviderFactory(IConfiguration config) => _config = config;

    public IStorageProvider Create() =>
        Create(_config["Storage:Provider"] ?? "Mega");

    public IStorageProvider Create(string providerType) => providerType switch
    {
        "Mega" => new MegaStorageProvider(
            Options.Create(new MegaStorageOptions
            {
                Email = _config["Storage:Mega:Email"] ?? string.Empty,
                Password = _config["Storage:Mega:Password"] ?? string.Empty
            }),
            new Logger<MegaStorageProvider>(new LoggerFactory())),
        _ => throw new NotSupportedException($"Storage provider '{providerType}' not supported")
    };
}
```

**Factory gaps:** there is no provider reuse, no health check, no configuration validation, and no disposal. `MegaStorageProvider` implements `IAsyncDisposable`, but the factory returns `IStorageProvider` and callers never dispose it. The `new LoggerFactory()` also creates a separate logging stack per provider instead of using the host's `ILogger<T>`. These are implementation issues, not design choices.

---

### 2.4 Kafka Cluster Provider Abstraction (design only; not implemented)

**There is no `IKafkaClusterProvider` or `AivenKafkaProvider` in the repository.** The actual host uses `Confluent.Kafka` directly inside `KafkaProducer`; the Kafka trigger binding uses the Functions extension. Topic creation is manual in the Aiven console/CLI. The interface and class below are a target design, not current code.

```csharp
public interface IKafkaClusterProvider
{
    Task<IProducer<string, string>> CreateProducerAsync(CancellationToken ct);
    Task<IConsumer<string, string>> CreateConsumerAsync(string consumerGroup, CancellationToken ct);
    Task<bool> TopicExistsAsync(string topicName, CancellationToken ct);
    Task CreateTopicAsync(string topicName, int partitions, int replicationFactor, CancellationToken ct);
}
```

**Actual producer configuration (`KafkaProducer`):** `Acks.All`, idempotence enabled, 3 retries, 1 second retry backoff, `ClientId = stashhost-producer`. SASL_SSL/SCRAM-SHA-256 is applied only when `Kafka:Username` is non-empty. The producer writes `X-Message-Version: 1` on every message and adds `x-dlq-reason` on DLQ messages. Both request and response topics are hard-coded (`stash.upload.request`, `stash.upload.response`, `stash.dlq`), not read from configuration.

**Serialization gap:** `JsonSerializer.Serialize(message)` uses the default naming policy, so messages are PascalCase. See 2.2.8 for the mobile interop consequence. If the provider abstraction is implemented, standardize serialization options in one place and use them for both producer and consumer.

**Topic administration:** no admin client, topic creation, partition validation, or replication-factor validation exists. Aiven topic setup remains an operational prerequisite.

### 2.5 Authentication & JWT Design

#### 2.5.1 JWT Token Model

Already defined in section 2.1.3 (JwtToken.cs) and 2.2.10.

#### 2.5.2 JWT Validation Middleware

Already defined in section 2.2.11.

---

## 3. Data Model & Schema Design

### 3.1 Local SQLite Schema (Mobile, no encryption)

The EF Core migration `Stash.Maui.Data/Migrations/20261029064802_InitialCreate.cs` is authoritative. This is the readable SQL equivalent:

```sql
CREATE TABLE Files (
    Id TEXT PRIMARY KEY,
    FileName TEXT NOT NULL,
    FilePath TEXT NOT NULL,
    FileSize INTEGER NOT NULL,
    ContentHash TEXT NOT NULL,  -- SHA-256 (renamed from FileHash)
    MimeType TEXT NOT NULL,
    CreatedAt TEXT NOT NULL,
    ModifiedAt TEXT NOT NULL,
    DiscoveredAt TEXT NOT NULL,
    Status TEXT NOT NULL,
    MegaTempPath TEXT,
    PermanentPath TEXT,
    ErrorMessage TEXT,
    RetryCount INTEGER NOT NULL DEFAULT 0,
    LastAttemptAt TEXT,
    DeviceId TEXT NOT NULL,
    UserId TEXT NOT NULL,
    ConvertedFormat TEXT,
    IsDeduplicated INTEGER NOT NULL DEFAULT 0,
    Thumbnails TEXT -- JSON dictionary
);

CREATE TABLE FolderConfigs (
    Id TEXT PRIMARY KEY,
    FolderPath TEXT NOT NULL,
    FolderName TEXT NOT NULL,
    IsEnabled INTEGER NOT NULL DEFAULT 1,
    AddedAt TEXT NOT NULL,
    LastScannedAt TEXT,
    IncludePatterns TEXT, -- JSON array
    ExcludePatterns TEXT, -- JSON array
    IncludeSubfolders INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IX_Files_ContentHash ON Files(ContentHash);
CREATE INDEX IX_Files_Status ON Files(Status);
CREATE INDEX IX_Files_DeviceId ON Files(DeviceId);
CREATE INDEX IX_Files_UserId ON Files(UserId);
CREATE UNIQUE INDEX IX_FolderConfigs_FolderPath ON FolderConfigs(FolderPath);
```

### 3.2 Kafka Message Schemas

#### Upload Request (Mobile → Host)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["fileId", "fileName", "fileSize", "mimeType", "megaTempPath"],
  "properties": {
    "messageId": { "type": "string", "format": "uuid" },
    "timestamp": { "type": "string", "format": "date-time" },
    "fileId": { "type": "string", "description": "SHA-256 hash of file content" },
    "fileName": { "type": "string" },
    "fileSize": { "type": "integer", "minimum": 0 },
    "mimeType": { "type": "string" },
    "megaTempPath": { "type": "string" },
    "metadata": {
      "type": "object",
      "properties": {
        "createdAt": { "type": "string", "format": "date-time" },
        "modifiedAt": { "type": "string", "format": "date-time" },
        "gps": {
          "type": "object",
          "properties": { "lat": { "type": "number" }, "lng": { "type": "number" } },
          "required": ["lat", "lng"]
        },
        "exif": { "type": "object" }
      }
    },
    "deviceId": { "type": "string", "format": "uuid" },
    "userId": { "type": "string", "format": "uuid" },
    "correlationId": { "type": "string", "format": "uuid" },
    "version": { "type": "integer", "minimum": 1 }
  }
}
```

**Kafka Headers (Mobile → Host):**
- `Authorization: Bearer <access_token>` (**required**; missing/invalid → DLQ)
- `X-Device-Id: <device_uuid>` (optional; if present must match the JWT `deviceId` claim)
- `X-User-Id: <user_uuid>` (optional; if present must match the JWT `userId` claim)
- `X-Correlation-Id: <correlation_id>` (optional; if absent, `request.CorrelationId` is used, and that field then becomes required)
- `X-Message-Version: 1` (not required by the trigger)

The trigger reads case-insensitively and accepts `string`/`byte[]` header values. `messageId`, `timestamp`, `deviceId`, `userId`, and `version` have C# defaults and can be omitted by the mobile producer; the trigger overwrites `userId`/`deviceId` from the JWT. The Kafka **key** is not optional: it must be present and equal `fileId` (case-insensitive), or the message is sent to the DLQ.

**Validation gap:** the schema marks `fileName`, `fileSize`, `mimeType`, and `megaTempPath` as required by the contract, but the trigger does not validate those fields. A message with an empty or missing temp path will pass the trigger and fail later in the orchestration. Add explicit validation if malformed producers are a concern.

#### Upload Response (Host → Mobile)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["messageId", "timestamp", "fileId", "status", "correlationId", "version"],
  "properties": {
    "messageId": { "type": "string", "format": "uuid" },
    "timestamp": { "type": "string", "format": "date-time" },
    "fileId": { "type": "string" },
    "status": { "type": "string", "enum": ["COMPLETED", "FAILED"] },
    "permanentPath": { "type": "string", "nullable": true },
    "thumbnails": {
      "type": "object",
      "additionalProperties": { "type": "string" }
    },
    "convertedFormat": { "type": "string", "nullable": true },
    "deduplicated": { "type": "boolean" },
    "processingTimeMs": { "type": "integer" },
    "error": { "type": "string", "nullable": true },
    "correlationId": { "type": "string", "format": "uuid" },
    "version": { "type": "integer", "minimum": 1 }
  }
}
```

**Response contract note:** `UploadResponseMessage` does **not** contain `deviceId` or `userId`, so they are not required fields. The host serializes with default `System.Text.Json` options, which means the actual wire property names are PascalCase (`MessageId`, `Status`, ...). The schema above is shown in camelCase for readability; see 2.2.8 for the interop gap.

### 3.3 Mega.io Storage Path Structure

```
Backups (hash-based for dedup):
/backups/{userId}/{contentHash}{normalizedExtension}   # .jpg or .mp4

Thumbnails:
/thumbs/{userId}/{size}/{contentHash}.jpg

Temp:
/temp/uploads/{deviceId}/{fileName}
```

**These are logical paths, not the physical Mega layout.** `MegaStorageProvider` extracts the last path segment and calls `MegaStorageClient` with a root-level file name. There is no directory creation or path-aware lookup. In particular, all three thumbnail sizes for one hash map to the same root name (for example `{hash}.jpg`), so they overwrite each other. See 2.3.2 for the required fix.

---

## 4. Processing Pipeline Design

### 4.1 Pipeline Steps (actual)

| Step | Activity | Input | Output | Retry in code | Timeout in code |
|------|----------|-------|--------|---------------|-----------------|
| 1 | `DownloadFileActivity` | `ProcessingContext.MegaTempPath` | `LocalFilePath` | None | None |
| 2 | `ComputeHashActivity` | `LocalFilePath` | lowercase SHA-256 hex | None | None |
| 3 | `CheckDeduplicationActivity` | `ProcessingContext` | `bool` (dedup hit) | None | None |
| 4 | `ConvertFormatActivity` | `LocalFilePath` | `ConvertedFilePath` | None | None |
| 5 | `GenerateThumbnailActivity` | `ThumbnailRequest` (128/256/512) | one-entry dictionary per size | None; failures are non-fatal | None |
| 6 | `StorePermanentActivity` | `ProcessingContext` | `PermanentPath` | None | None |
| 7 | `DeleteTempFileActivity` | `MegaTempPath` | `bool` (success) | **One manual retry** in orchestration | None |
| 8 | `SendResponseActivity` | `UploadResponseMessage` | Kafka ack | None | None |

**Important correction:** the previous table's "3 retries / exponential backoff / 10 min timeout" was aspirational and is **not implemented**. There are no `TaskOptions` retry policies and no activity timeouts in `FileProcessingOrchestration`. Durable Functions may replay an activity after a host failure, but that is runtime behavior, not a configured retry policy. Add explicit `TaskOptions`/retry policies and per-activity timeouts if the reliability targets require them.

### 4.2 Fan-Out/Fan-In Pattern

The orchestration creates three `GenerateThumbnailActivity` calls (128, 256, 512) with `context.CallActivityAsync<ActivityResult>`, awaits them with `Task.WhenAll`, and merges only successful one-entry dictionaries into `ProcessingContext.Thumbnails`. A thumbnail failure does **not** fail the orchestration. Because the Mega client is root-name based, the three sizes currently overwrite each other in storage even though all three activities succeed; see 2.3.2.

### 4.3 Error Handling Strategy (actual)

| Failure | Actual handling | DLQ? |
|---------|-----------------|------|
| Invalid JSON / missing JWT / claim mismatch / missing key / duplicate instance check failure in the Kafka trigger | Caught per record; republished to `stash.dlq` with `x-dlq-reason` | Yes |
| Unhandled exception in the Kafka trigger | Caught per record; DLQ attempt; if the DLQ publish also fails, the exception is logged | Attempted |
| Download/hash/dedup/convert/store failure | Activity returns `ActivityResult.Failure`; orchestration sends a `FAILED` `UploadResponseMessage` and stops | No |
| Dedup storage check exception | Treated as a **fatal** failure, not "file not present" | No |
| Thumbnail failure (including all video thumbnails) | Logged/ignored; orchestration continues with the successful thumbnails | No |
| Temp delete failure | One retry; if it still fails, a replay-safe warning is logged and processing continues | No |
| Response publish failure | `SendResponseActivity` returns failure; the orchestration's handling is limited to the activity result (no separate DLQ for response-publish failures) | No |
| File corruption | Converter throws; `ConvertFormatActivity` returns failure; `FAILED` response | No |
| Authentication failure | DLQ in the Kafka trigger | Yes |

**There is no automatic retry with exponential backoff or jitter for Mega/Kafka activity failures.** The only retry in the pipeline is the single delete retry. Do not claim otherwise.

### 4.4 Idempotency (actual)

- The Durable instance ID is `request.CorrelationId`. The trigger calls `GetInstanceAsync(correlationId)` and skips scheduling if an instance already exists.
- `MessageId` is **not** the idempotency key. Two messages with the same `MessageId` but different correlation IDs start two orchestrations.
- Content deduplication is by SHA-256 hash and `StoragePathBuilder.GetPermanentPath(...)`, which normalizes the extension to `.jpg`/`.mp4`. Using the original extension in only one place would break dedup.
- The permanent path is `/backups/{userId}/{hash}{normalizedExt}`; the thumbnail path is `/thumbs/{userId}/{size}/{hash}.jpg` (logical only; see 2.3.2).
- A dedup hit returns `COMPLETED` with `Deduplicated = true` and the existing permanent path; it does not re-upload or regenerate thumbnails.
- The trigger trusts the client-supplied `FileId` (after matching the Kafka key) and the response reuses it, while storage uses the computed hash. Add a computed-vs-supplied hash check; see 2.2.5.

## 5. Security Design

### 5.1 Authentication Flow

```
Mobile App              Identity API              StashHost
  │                                   │                         │
  │ 1. POST /register (email, pass, deviceId)                     │
  │─────────────────────────────────────────────────────────────► │
  │                                   │ 2. Return JWT tokens    │
  │◄───────────────────────────────────────────────────────────── │
  │                                                                 │
  │ 3. Store tokens in SecureStorage (Keychain/Keystore)          │
  │                                                                 │
  │ 4. Produce Kafka message with headers:                        │
  │     - Authorization: Bearer <token>                           │
  │     - X-Device-Id, X-User-Id, X-Correlation-Id, X-Message-Version │
  │─────────────────────────────────────────────────────────────► │
  │                                   │ 5. Validate JWT         │
  │                                   │ 6. Process orchestration│
  │                                   │ 7. Produce response     │
  │◄──────────────────────────────────│---------------------------│
```

**Actual trust path:** the Identity API signs the JWT; StashHost validates it locally with the same signing key/issuer/audience. StashHost does **not** call the Identity API to validate a request. The diagram's single vertical lane is conceptual. Mobile SecureStorage token persistence is implemented; the mobile Kafka producer and consumer remain design-only.

### 5.2 Secrets Management (design; not implemented)

| Secret | Target location | Actual current state |
|--------|-----------------|----------------------|
| Mega.io email/password | Azure Key Vault | `local.settings.json` / app settings; values are empty in the dev file |
| Kafka SASL credentials | Azure Key Vault | `local.settings.json`; `Kafka:Password` is empty |
| JWT signing key | Azure Key Vault | Local configuration; development key only |
| Mobile access token | SecureStorage (Keychain/Keystore) | Implemented through `MauiSecureStorage`/`SecureStorage.Default`; physical-device Keychain/Keystore untested |
| Mobile refresh token | SecureStorage (Keychain/Keystore) | Implemented; refresh rotation and clearing are unit-tested |

`Azure.Security.KeyVault.Secrets` and `Azure.Identity` are referenced by `StashHost.Functions`, but no Key Vault client, managed-identity wiring, or secret resolution is implemented. Do not claim Key Vault is in use until it is.

### 5.3 Network Security

| Connection | Protocol | Auth | Encryption |
|------------|----------|------|------------|
| Mobile → Kafka | SASL_SSL | Username/Password | TLS (design) |
| Mobile → Mega.io | HTTPS | Session token | TLS (design) |
| Mobile → Identity API | HTTPS | Email/password → JWT | TLS (design) |
| StashHost → Kafka | SASL_SSL | SCRAM-SHA-256 (when username configured) | TLS (negotiated) |
| StashHost → Mega.io | HTTPS | Email/password; **2FA is not implemented in the client** | TLS (negotiated) |
| StashHost → Key Vault | HTTPS | Managed Identity | **Not implemented** |
| StashHost → Identity API | HTTPS | Internal JWT | **Not used**; validation is local |

The previous table asserted TLS 1.3 and Mega 2FA as facts. Neither is verified in the repository. `MegaStorageClient` only performs email/password login; there is no TOTP/2FA path. Exact TLS versions are negotiated by the runtime and should not be documented as 1.3 without a deployment test.

### 5.4 Data Protection

- **At Rest**: Mega.io provider encryption (do not claim a specific algorithm without provider confirmation)
- **In Transit**: HTTPS/SASL_SSL; exact TLS version is negotiated, not configured in this repository
- **Secrets**: Key Vault remains a design target; mobile tokens use SecureStorage
- **PII**: Kafka messages contain user/device UUIDs and file metadata; do not claim "no PII" if EXIF/GPS metadata is included
- **Local DB**: standard SQLite without encryption, implemented through EF Core in `Stash.Maui.Data` with migration `20261029064802_InitialCreate`

---

## 6. Infrastructure Design (Terraform; owner-managed, not present)

> **Status:** there is no `terraform/` directory in the repository. The original HCL in this section was never applied and contained invalid assumptions (classic Consumption plan with Kafka, and the Identity API modeled as a Function App). It has been replaced with requirements rather than executable HCL. IaC is intentionally out of scope for this documentation pass and is owned by the project owner.

### 6.1 Terraform Module Structure (target)

```text
terraform/
├── modules/
│   ├── resource_group/
│   ├── function_app_flex/
│   ├── identity_api/
│   ├── key_vault/
│   ├── app_insights/
│   └── log_analytics/
├── environments/
│   ├── dev/
│   ├── staging/
│   └── prod/
├── versions.tf
├── providers.tf
└── backend.tf
```

### 6.2 Required Resources and Constraints

| Resource | Requirement | Reason |
|----------|-------------|--------|
| StashHost Function App | **Flex Consumption** (or Elastic Premium/Dedicated) | Kafka bindings are not supported on classic Consumption. .NET 10 is not supported on Linux Consumption. |
| StashHost OS/runtime | Linux, `FUNCTIONS_WORKER_RUNTIME=dotnet-isolated`, .NET 10 | Matches the project TFM and worker package. |
| Identity API | App Service or Container App running the `Microsoft.NET.Sdk.Web` project | It is an ASP.NET Core app, not an Azure Functions project. Do not deploy it as `azurerm_function_app`. |
| Key Vault | Standard/Premium; managed identity access for the Function App | Required if Key Vault integration is implemented. |
| Application Insights + Log Analytics | Workspace-based Application Insights | Required for host telemetry and future alerts. |
| Kafka topics | Manual creation in Aiven Console/CLI | No Aiven Terraform provider or admin client is implemented. |
| Storage account | Required by Functions for internal state | Do not confuse with Mega.io user file storage. |

**Do not use the legacy `azurerm_function_app` resource from the previous revision.** It represents a classic plan and cannot host this Kafka trigger. Use the Flex Consumption resource available in your `azurerm` provider version (or `azurerm_linux_function_app` with an Elastic Premium/Dedicated plan).

**Function App settings that matter:** `AzureWebJobsStorage`, `FUNCTIONS_WORKER_RUNTIME=dotnet-isolated`, `Kafka:BootstrapServers`, `Kafka:Username`, `Kafka:Password`, `Storage:Provider`, `Storage:Mega:Email`, `Storage:Mega:Password`, `Auth:Jwt:SigningKey`, `Auth:Jwt:Issuer`, `Auth:Jwt:Audience`, and `APPLICATIONINSIGHTS_CONNECTION_STRING`. Kafka topic names are currently hard-coded, not read from `Kafka:Topics:*`.

### 6.3 Environment Configuration

| Environment | Resource Group | Function Plan | Kafka | Mega.io |
|-------------|---------------|---------------|-------|---------|
| Dev | rg-stash-dev | Flex Consumption (or Premium/Dedicated) | Shared dev cluster | Test account |
| Staging | rg-stash-staging | Flex Consumption (or Premium/Dedicated) | Dedicated cluster | Staging account |
| Prod | rg-stash-prod | Flex Consumption (or Premium/Dedicated) | Dedicated cluster | Prod account |

These are target environments. None has been provisioned from this repository.

---

## 7. CI/CD Pipeline Design (GitHub Actions; not present)

> **Status:** there is no `.github/` directory. The YAML below is a target design only. It also assumes Terraform, which is not present. Do not treat any deployment stage as implemented.

### 7.1 Pipeline Stages

```yaml
# .github/workflows/ci-cd.yml
name: CI/CD Pipeline

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  build-mobile:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '10.0.x'
      - run: dotnet build Stash/Stash.Maui/Stash.Maui.csproj -c Release
      - run: dotnet test Stash/Stash.Maui.Tests/Stash.Maui.Tests.csproj -c Release

  build-host:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '10.0.x'
      - run: dotnet build Stash/StashHost.Functions/StashHost.Functions.csproj -c Release
      - run: dotnet test Stash/StashHost.Tests/StashHost.Tests.csproj -c Release

  build-identity:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with:
          dotnet-version: '10.0.x'
      - run: dotnet build Stash/StashHost.IdentityApi/StashHost.IdentityApi.csproj -c Release
      - run: dotnet test Stash/StashHost.Tests/StashHost.Tests.csproj -c Release

  terraform-plan:
    needs: [build-mobile, build-host, build-identity]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
      - run: terraform init
        working-directory: terraform
      - run: terraform plan -var-file=environments/dev/terraform.tfvars
        working-directory: terraform

  deploy:
    needs: terraform-plan
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - uses: azure/login@v2
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS }}
      - run: terraform apply -auto-approve -var-file=environments/dev/terraform.tfvars
        working-directory: terraform
      - run: az functionapp deploy --name stashhost-func-dev --resource-group rg-stash-dev --src-path ./publish
```

---

## 8. Monitoring & Observability Design (target; mostly not implemented)

### 8.1 Application Insights Configuration

`Microsoft.ApplicationInsights.WorkerService` 3.2.0 is referenced, but the source does not call `AddApplicationInsightsTelemetryWorkerService()` or configure a connection string. The host currently emits standard `ILogger` output. Application Insights/Log Analytics resources are not provisioned by this repository.

### 8.2 Custom Events (not implemented)

The following table is a target event taxonomy. No `TelemetryClient`, `ActivitySource`, or custom event calls exist in the implementation.

| Event Name | Properties | Purpose |
|------------|------------|---------|
| FileUploadStarted | FileId, UserId, DeviceId, FileSize | Track upload initiation |
| FileProcessingCompleted | FileId, ProcessingTimeMs, Deduplicated | Track successful processing |
| FileProcessingFailed | FileId, Error, RetryCount | Track failures |
| OrchestrationStarted | InstanceId, CorrelationId | Track orchestration lifecycle |
| OrchestrationCompleted | InstanceId, DurationMs | Track orchestration completion |
| KafkaMessageConsumed | Topic, Offset, Partition | Track message consumption |
| MegaIoApiCall | Endpoint, DurationMs, StatusCode | Track storage API calls |
| IdentityApiLogin | UserId, DeviceId, Success | Track auth events |
| IdentityApiRegister | UserId, DeviceId, Success | Track registration events |

### 8.3 Alerts (not implemented)

No Azure Monitor alert resources, action groups, or alert rules exist. The DLQ handler writes a critical log for batches over 10 messages, but that log is not wired to an alert.

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| Orchestration duration > 60 min | Avg duration > 60min over 5min | P1 | Page on-call |
| Failed orchestrations > 5% | Error rate > 5% over 5min | P2 | Ticket |
| Kafka consumer lag > 1000 | Lag > 1000 messages | P2 | Ticket |
| DLQ message count > 10 | Count > 10 | P1 | Page on-call |
| Mega.io API error rate > 1% | Error rate > 1% over 5min | P2 | Ticket |
| Identity API latency > 2s p99 | Latency > 2s p99 over 5min | P2 | Ticket |

---

## 9. Error Handling & Resilience (actual state)

### 9.1 Retry Policies

- **No Durable retry policy is configured.** There are no `TaskOptions`/`RetryOptions` on activity calls and no activity timeouts.
- The only retry in the pipeline is one manual retry of `DeleteTempFileActivity`.
- Polly 8.8.0 is referenced by `StashHost.Functions`, but no Polly policy is registered or used. Mega/Kafka calls are not wrapped in retry/circuit-breaker policies.
- Kafka producer reliability relies on `Acks.All`, idempotence, and 3 producer retries.

### 9.2 Dead Letter Queue

- The Kafka trigger catches per-record failures and republishes to `stash.dlq` with `x-dlq-reason`.
- `DeadLetterHandlerFunction` consumes `stash.dlq`, logs each message, and emits a critical log when a batch exceeds 10.
- There is no persistence, replay UI, replay endpoint, or alert resource. "Manual replay" is an operational TODO, not an implemented feature.
- If the DLQ publish itself fails, the original exception is logged; there is no secondary fallback.

### 9.3 Graceful Degradation

- Thumbnail failures are non-fatal; processing continues with any successful sizes.
- Temp-file deletion failure is non-fatal after one retry and is logged.
- The temp-file deletion step removes the Mega.io temp object only; the local `%TEMP%/stash/{guid}` directory created by `DownloadFileActivity` is never deleted.
- A dedup storage failure is fatal (returns `FAILED`), which is safer than assuming "not duplicate".
- There are no circuit breakers, bulkheads, or queue-depth controls.

---

## 10. Testing Strategy (actual inventory)

### 10.1 Unit/Integration Tests

`dotnet test Stash/Stash.slnx --no-build` currently passes:

| Assembly | Result | Notes |
|----------|--------|-------|
| `StashHost.Tests` | 110 passed | Identity API endpoint tests with an in-memory `IUserStore`, JWT/claim tests, Phase 3 pipeline/activity tests, and Phase 7 orchestration/Kafka-trigger tests |
| `Stash.Maui.Tests` | 52 passed | Phase 4.1 configuration/DI (5), Phase 4.2 authentication (12), Phase 4.3 SQLite/EF Core CRUD/migration (5), Phase 4.4 folder scanner (7), Phase 4.5 upload manager (6), Phase 4.6 Kafka transport/producer/consumer (8), and Phase 4.7 background upload service/DI (9) |

Identity tests do **not** use MongoDB; a separate manual real-Mongo check passed the register/login/refresh/revoke flow and concurrent duplicate registration (`200` + `409`). It is not part of the automated suite.

### 10.2 Gaps

- No live Kafka trigger test (`func start` + Aiven).
- No live mobile REST-proxy/Kafka test; `Kafka:RestUrl` has no URL or credentials.
- No live Mega.io integration test.
- No Durable orchestration integration test.
- No HEIC/AVIF/RAW/MOV conversion tests (only support-flag assertions).
- No mobile UI tests yet (Phase 4.8+).
- No physical Android/iOS background execution test; Phase 4.7 service logic is covered by 9 mocked tests, but WorkManager/BGTaskScheduler wake-up and upload continuation are unverified.
- No Azure deployment, Key Vault, or alert tests.

### 10.3 Test Data

Use small deterministic fixtures for SHA-256/JPEG/PNG/WebP; use a licensed HEIF/AVIF decoder fixture only after the decoder is added. Do not use a 500 MB fixture in unit tests; use a stream-size guard or a dedicated load test.

---

## 11. Deployment Design (not implemented)

### 11.1 Deployment Steps (target)

1. Provision a Flex Consumption (or Premium/Dedicated) Function App on Linux with .NET 10 isolated worker settings.
2. Provision the Identity API as an App Service/Container App, not a Function App.
3. Configure app settings/Key Vault references for Kafka, Mega, JWT, Mongo, and Application Insights.
4. Create the Kafka topics in Aiven and confirm the deployed extension bundle supports `KafkaRecord[]`.
5. Deploy `StashHost.Functions` and `StashHost.IdentityApi` separately.
6. Run `/api/health` and an end-to-end Kafka upload with a real Mega test account.

No GitHub Actions workflow, Terraform, or `func`/`az` deployment script exists in the repository.

### 11.2 Rollback Plan (target)

Use deployment slots or package-version pinning; roll back the Function App package and Identity API deployment together if the JWT signing key or message contract changes. No rollback automation exists.

---

## 12. Gaps & Open Questions (accurate status)

| # | Area | Status |
|---|------|--------|
| 1 | Identity Provider | Identity API implemented and tested; `/api/auth/revoke` is unauthenticated and revokes by `deviceId` across users — fix required |
| 2 | Kafka Topics Auto-Creation | Not implemented; topics are manual in Aiven. The old "Terraform Aiven topics" claim is false |
| 3 | Mobile App Entry Point | Phases 4.1–4.7 code complete: embedded config, `StashConfig`, DI-created shell/pages, authentication client, SecureStorage, login/register UI, SQLite/EF Core persistence, folder scanning, upload manager, REST-proxy Kafka producer/consumer, and platform background schedulers; remaining feature pages pending and physical background execution unverified |
| 4 | Response Consumption | Host response publisher exists; mobile consumer is implemented over REST Proxy v2 but live unverified |
| 5 | Local DB Encryption | No encryption by design; standard SQLite schema, EF Core migration, and repositories are implemented |
| 6 | Mega.io Rate Limits | No Polly policy or rate limiting implemented |
| 7 | Large File Chunking | Not implemented; Mega upload/download buffer whole files in memory. The "10 min timeout" claim is false |
| 8 | Conflict Resolution | Revoke endpoint exists; authorization/ownership gap |
| 9 | Offline Queue Persistence | Not implemented |
| 10 | Background Task Limits | Not researched or implemented |
| 11 | Kafka Consumer Group | Mobile group not implemented; host trigger uses `stash-upload-request`, DLQ uses `stash-dlq-handler` |
| 12 | Health Checks | Host `/api/health` implemented (live unverified); Identity `/health` implemented |
| 13 | API Versioning | `Version` property exists on messages; no schema registry or compatibility policy |
| 14 | Local Development | No Docker Compose; shared Aiven dev cluster only |
| 15 | Mega path hierarchy | Not honored; root-filename flattening and thumbnail-size collisions |
| 16 | Kafka/JSON interop | Host emits PascalCase; mobile design expects camelCase |
| 17 | Conversion support | HEIC/AVIF/RAW decode and MOV→MP4 not implemented |
| 18 | ImageSharp license | Release build requires a commercial/community license |
| 19 | IaC/CI/monitoring | Not present; owner handles IaC |

---

## 13. Implementation Roadmap (status)

| Phase | Status |
|-------|--------|
| 0 Foundation | Complete |
| 1 Shared core + storage | Complete (with Mega path/memory limitations) |
| 2 Identity API | 2.1 complete/tested; 2.2 Azure deployment blocked on access |
| 3 StashHost backend | Core pipeline implemented; activities partially unit-tested; orchestration/trigger not unit-tested; live Kafka/Mega/E2E blocked; conversion gaps |
| 4 MAUI app | Phases 4.1–4.7 code complete; Phase 4.8 (UI) next; live REST-proxy/Kafka and physical background execution deferred |
| 5 Infrastructure | Intentionally deferred to owner; no Terraform |
| 6 Mobile backup workflow | Not started |
| 7 End-to-end testing | Not started; live tests blocked |
| 8 Production hardening | Not started (auth gap, licensing, monitoring, retries) |

---

## 14. Appendix

### 14.1 NuGet Packages (actual)

| Package | Version | Project | Notes |
|---------|---------|---------|-------|
| `Microsoft.Azure.Functions.Worker` | 2.52.0 | StashHost.Functions | ≥ 2.50.0 required for .NET 10 |
| `Azure.Functions.Sdk` (project SDK) | 1.0.0 | StashHost.Functions | ≥ 1.0.0 required for .NET 10 |
| `Microsoft.Azure.Functions.Worker.Extensions.Http` | 3.3.0 | StashHost.Functions | HTTP trigger |
| `Microsoft.Azure.Functions.Worker.Extensions.DurableTask` | `1.*` (resolves 1.20.0) | StashHost.Functions | Pin to `1.20.0` for reproducible builds |
| `Microsoft.Azure.Functions.Worker.Extensions.Kafka` | 4.3.3 | StashHost.Functions | `KafkaRecord[]` support; verify host bundle |
| `Confluent.Kafka` | 2.6.0 | StashHost.Functions | Host producer only; removed from `Stash.Maui` (no Android/iOS runtime) |
| `Microsoft.ApplicationInsights.WorkerService` | 3.2.0 | StashHost.Functions | Referenced; not wired |
| `Polly` | 8.8.0 | StashHost.Functions | Referenced; not used |
| `Azure.Identity` | 1.21.0 | StashHost.Functions | Referenced; Key Vault not wired |
| `Azure.Security.KeyVault.Secrets` | 4.11.2 | StashHost.Functions | Referenced; Key Vault not wired |
| `System.IdentityModel.Tokens.Jwt` | 8.23.0 | Functions, Identity | JWT |
| `SixLabors.ImageSharp` | 4.1.3 | StashHost.Functions | License warning; no HEIC/AVIF/RAW codecs |
| `FFmpeg.AutoGen` | 9.0.1.1 | StashHost.Functions | Referenced; native FFmpeg not integrated |
| `MongoDB.Driver` | 3.12.0 | Functions, Identity | Identity uses it; Functions does not |
| `Microsoft.AspNetCore.Authentication.JwtBearer` | 10.0.13 | Identity | JWT bearer |
| `Microsoft.Extensions.Configuration` | 10.0.13 | Shared | Configuration |
| `Microsoft.Extensions.Logging` | 10.0.13 | Shared | Logging |
| `Microsoft.JavaScript.NodeApi` | 0.9.27 | MegaConnectivity.Core | Node embedding |
| `Microsoft.JavaScript.LibNode` | 20.1800.203 | MegaConnectivity.Core | Native libnode |
| `Microsoft.Maui.Controls` | `$(MauiVersion)` (10.x) | Stash.Maui | Template only |
| `Xamarin.AndroidX.Work.Runtime` | 2.10.5 | Stash.Maui (Android) | WorkManager; emits NU1608 Lifecycle dependency-range warnings |
| `xunit` | 2.9.3 | Tests | Test framework |
| `Microsoft.NET.Test.Sdk` | 17.14.1 | Tests | Test host |
| `coverlet.collector` | 6.0.4 | Tests | Coverage collector |
| `xunit.runner.visualstudio` | 3.1.4 | Tests | Runner |

### 14.2 Configuration Keys (actual/used)

| Key | Description | Actual status |
|-----|-------------|---------------|
| `Kafka:BootstrapServers` | Aiven bootstrap servers | Host only; mobile does not use a native client |
| `Kafka:Username` | SASL username | Host only; if empty, SASL is not enabled by the producer (the trigger still requests SASL_SSL) |
| `Kafka:Password` | SASL password | Host only; empty in dev file |
| `Kafka:RestUrl` | Confluent REST Proxy base URL | Mobile; **empty** in checked-in `appsettings.json`; first use throws a configuration error |
| `Kafka:RestUsername` / `RestPassword` | REST Proxy HTTP basic auth | Mobile; placeholders, empty by default |
| `Kafka:RestTimeoutSeconds` | Mobile REST timeout | Mobile; default 30 |
| `Kafka:ClusterId` | v3 produce cluster ID | Mobile; optional, discovered via `/v3/clusters` when empty |
| `Kafka:TopicUploadRequest` | Request topic | Mobile producer uses it; host still hard-codes `stash.upload.request` |
| `Kafka:TopicUploadResponse` | Response topic | Mobile consumer uses it; host still hard-codes `stash.upload.response` |
| `Kafka:TopicDeadLetter` | DLQ topic | Mobile producer property; host hard-codes `stash.dlq` |
| `Storage:Provider` | Provider type | Used |
| `Storage:Mega:Email` | Mega email | Used; empty in dev file |
| `Storage:Mega:Password` | Mega password | Used; empty in dev file |
| `Auth:Jwt:SigningKey` | JWT signing key | Used |
| `Auth:Jwt:Issuer` | JWT issuer | Used/default `stash-auth` |
| `Auth:Jwt:Audience` | JWT audience | Used/default `stash-app` |
| `Auth:Jwt:AccessTokenExpiryMinutes` | Access token lifetime | Used/default 15 |
| `Auth:Jwt:RefreshTokenExpiryDays` | Refresh token lifetime | Used/default 7 |
| `MongoDB:ConnectionString` | Mongo connection | Identity API only |
| `MongoDB:DatabaseName` | Mongo database | Identity API only; default `stash` |
| `Cors:AllowedOrigins` | CORS origins | Identity API optional |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | App Insights | Present in `local.settings.json` but empty; not wired in code |
| `UploadSettings:BatchSize` | Mobile batch size | Used by `UploadManager` (default 10) |
| `UploadSettings:MaxRetries` | Mobile retry limit | Used by background upload candidate filter (default 3) |
| `UploadSettings:MaxFileSizeBytes` | Mobile max size | Used by `UploadManager` (default 500 MB) |
| `BackgroundUpload:Enabled` | Mobile scheduler toggle | Used by all schedulers (default true) |
| `BackgroundUpload:IntervalMinutes` | Background interval | Used; Android clamps to ≥15 minutes, iOS uses it as an earliest-begin hint |
| `BackgroundUpload:MaxFilesPerRun` | Per-pass upload cap | Used by `BackgroundUploadService` (default 50; ≤0 means unlimited) |

### 14.3 File Size and Conversion Matrix (actual)

| Input | Max size | Actual result |
|-------|----------|---------------|
| JPEG | 500 MB target | Stored as `.jpg`; no conversion |
| PNG | 500 MB target | Converted to JPEG (tested) |
| WebP | 500 MB target | Converted to JPEG (ImageSharp supports WebP; no dedicated test) |
| HEIC/HEIF | 500 MB target | **Fails**: ImageSharp 4 has no HEIF decoder |
| AVIF | 500 MB target | **Fails**: ImageSharp 4 has no AVIF decoder |
| RAW (CR2/NEF/ARW/DNG/RAW) | 500 MB target | **Fails**: no RAW decoder |
| MOV | 500 MB target | **Fails**: `VideoConverter` throws `NotSupportedException` |
| MP4 | 500 MB target | Stored as `.mp4`; no conversion |
| Other | 500 MB target | Stored with the original extension; no converter |

The 500 MB limit is a design target, not enforced by the host. The Mega client buffers the whole file in memory, so a 500 MB job is a memory risk.

---

## 15. Verification Checklist (accurate)

| Item | Status | Evidence / note |
|------|--------|-----------------|
| Deduplication by SHA-256 | Implemented | `ComputeHashActivity`, normalized `StoragePathBuilder`; tests |
| Kafka key = file hash | Implemented, live unverified | Host trigger validates; mobile producer uses `FileId` as key; mocked tests only |
| Identity API Minimal API | Implemented | 17 endpoint/auth tests; real Mongo manual check |
| JWT in Kafka headers | Implemented, live unverified | Host validates; mobile producer sends the five required headers via REST Proxy v3; mocked mapping test |
| MegaStorageProvider | Partial | Root-only paths, memory buffering, no disposal |
| Terraform / Flex Consumption | Not implemented | Old Consumption HCL is invalid for Kafka; IaC deferred |
| Instance ID = correlationId | Implemented, live unverified | Trigger `GetInstanceAsync` + `StartOrchestrationOptions`; no live test |
| DLQ handler | Partial | Consume/log only; no replay UI/persistence/alerts |
| RAW/HEIC/AVIF/MOV conversion | Not implemented | Support flags are misleading; see 2.2.9 |
| Environments | Design only | No Terraform or deployed environments |
| Kafka partitions | Not managed in repo | Manual Aiven setup only |
| host.json concurrency | Implemented | `durableTask` values present |
| Mobile Kafka consumer | Implemented, live unverified | Phase 4.6: group `stash-mobile-{deviceId}`, REST Proxy v2 consume, updates local status; 8 mocked tests |
| Mobile Kafka producer | Implemented, live unverified | Phase 4.6: REST Proxy v3 produce with base64 key/header values and JSON value |
| MAUI StashConfig | Implemented (Phase 4.1) | Embedded `appsettings.json`, nested binding, DI registration, 5 configuration/DI tests |
| SecureStorage | Implemented (Phase 4.2) | MAUI `SecureStorage.Default` adapter; token lifecycle tested with in-memory storage; logout retains stable device ID |
| Mobile local database | Implemented (Phase 4.3) | `Stash.Maui.Data` standard SQLite/EF Core, `InitialCreate` migration, unique `ContentHash`/`FolderPath`, CRUD and schema tests, Windows runtime DB verified |
| Mobile folder scanner | Implemented (Phase 4.4) | `FolderScannerService` discovers media types, applies include/exclude patterns and subfolder settings, streams SHA-256, checks accessibility; 7 scanner tests |
| Mobile upload manager | Implemented (Phase 4.5) | `UploadManager` streams to `/temp/uploads/{deviceId}/{fileName}`, batches by `UploadSettings:BatchSize`, persists Uploading/Uploaded/Failed state, tracks retries and in-progress IDs; 6 tests use real SQLite plus a fake provider |
| Mobile background upload | Implemented, physical execution unverified | Phase 4.7 single-flight `RunOnceAsync` scans/uploads/publishes; Android WorkManager, iOS BGTaskScheduler, Windows BackgroundTaskBuilder, Mac Catalyst no-op; 9 service/DI tests |
| Android minimum SDK | Changed to API 23 | WorkManager 2.10.5 requires API 23; `SupportedOSPlatformVersion` raised from 21.0 |
| Windows background task | Registered best-effort | `BackgroundTaskBuilder` code and `Package.appxmanifest` timer extension exist, but `WindowsPackageType=None` prevents registration; failure is logged |
| Mobile Kafka native runtime | Resolved by design | `Confluent.Kafka` removed from `Stash.Maui`; REST-proxy transport has no native Kafka dependency; Android still warns once about `libnode` from another package |
| App Insights + Log Analytics | Not wired | Package reference only |
| Mega logical paths | Not honored physically | Root-filename flattening; thumbnail collisions |
| Thumbnail paths | Partial | `StoragePathBuilder` correct; physical collision gap |
| SQLite no encryption | Implemented (Phase 4.3) | `Stash.Maui.Data` uses standard SQLite via EF Core; migration and CRUD tested; Windows runtime DB verified with `sqlite3` |
| Message versioning | Partial | `Version = 1` property exists; no compatibility policy or test |
| Health checks | Partial | Host `/api/health` + Identity `/health`; live host unverified |
| Device re-registration/revoke | Partial, security gap | `/api/auth/revoke` unauthenticated and cross-user |
| .NET 10 conformance | Mostly compliant | SDK 10.0.402; Worker 2.52.0; Functions SDK 1.0.0; pin Durable `1.*`; Flex hosting required |
| ImageSharp license | Blocker | Release builds require a license |

**End of LLD Document v2**

*This document was re-verified against the implementation on 2026-10-23. It records what exists, what is design-only, and what is still broken; it does not claim that every target feature is implemented.*
