using Microsoft.Extensions.Logging;
using Stash.Maui.Auth;
using Stash.Maui.Configuration;
using Stash.Maui.Data.Entities;
using Stash.Maui.Data.Repositories;
using StashHost.Shared.Contracts;
using StashHost.Shared.Messages;

namespace Stash.Maui.Services;

/// <summary>
/// Platform-independent background upload pass. The service is intentionally
/// idempotent because mobile background schedulers may invoke it more than once
/// and may kill it without warning.
/// </summary>
public sealed class BackgroundUploadService : IBackgroundUploadService
{
    private readonly IAuthenticationService _authenticationService;
    private readonly IFolderRepository _folderRepository;
    private readonly IFolderScannerService _scanner;
    private readonly IFileRepository _fileRepository;
    private readonly IUploadManager _uploadManager;
    private readonly IKafkaProducer _kafkaProducer;
    private readonly StashConfig _config;
    private readonly ILogger<BackgroundUploadService> _logger;
    private readonly SemaphoreSlim _runGate = new(1, 1);

    public BackgroundUploadService(
        IAuthenticationService authenticationService,
        IFolderRepository folderRepository,
        IFolderScannerService scanner,
        IFileRepository fileRepository,
        IUploadManager uploadManager,
        IKafkaProducer kafkaProducer,
        StashConfig config,
        ILogger<BackgroundUploadService> logger)
    {
        _authenticationService = authenticationService
            ?? throw new ArgumentNullException(nameof(authenticationService));
        _folderRepository = folderRepository
            ?? throw new ArgumentNullException(nameof(folderRepository));
        _scanner = scanner ?? throw new ArgumentNullException(nameof(scanner));
        _fileRepository = fileRepository
            ?? throw new ArgumentNullException(nameof(fileRepository));
        _uploadManager = uploadManager ?? throw new ArgumentNullException(nameof(uploadManager));
        _kafkaProducer = kafkaProducer ?? throw new ArgumentNullException(nameof(kafkaProducer));
        _config = config ?? throw new ArgumentNullException(nameof(config));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async Task<BackgroundUploadResult> RunOnceAsync(CancellationToken ct = default)
    {
        if (!await _runGate.WaitAsync(0, ct).ConfigureAwait(false))
            return BackgroundUploadResult.AlreadyRunningResult();

        var scanned = 0;
        var discovered = 0;
        var uploaded = 0;
        var queued = 0;
        var failed = 0;

        try
        {
            var authenticated = await _authenticationService
                .EnsureValidAccessTokenAsync(ct)
                .ConfigureAwait(false);
            if (!authenticated)
            {
                return BackgroundUploadResult.Failure(
                    "Background upload requires an authenticated session.");
            }

            var deviceId = await _authenticationService.GetOrCreateDeviceIdAsync(ct)
                .ConfigureAwait(false);
            var userId = await _authenticationService.GetUserIdAsync(ct).ConfigureAwait(false);

            var folders = (await _folderRepository.GetAllAsync(ct).ConfigureAwait(false))
                .Where(folder => folder.IsEnabled)
                .ToList();

            foreach (var folder in folders)
            {
                ct.ThrowIfCancellationRequested();

                try
                {
                    var files = await _scanner.ScanFolderAsync(folder, ct).ConfigureAwait(false);
                    foreach (var fileInfo in files)
                    {
                        ct.ThrowIfCancellationRequested();
                        scanned++;

                        var hash = await _scanner
                            .ComputeFileHashAsync(fileInfo.FullName, ct)
                            .ConfigureAwait(false);
                        if (string.IsNullOrWhiteSpace(hash))
                            continue;

                        if (await _fileRepository
                            .ExistsByContentHashAsync(hash, ct)
                            .ConfigureAwait(false))
                        {
                            continue;
                        }

                        await _fileRepository.AddAsync(
                            CreateEntity(fileInfo, hash, deviceId, userId),
                            ct).ConfigureAwait(false);
                        discovered++;
                    }

                    folder.LastScannedAt = DateTime.UtcNow;
                    await _folderRepository.UpdateAsync(folder, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(
                        ex,
                        "Background scan failed for folder {FolderPath}.",
                        folder.FolderPath);
                }
            }

            var maxRetries = Math.Max(0, _config.UploadSettings.MaxRetries);
            var maxFiles = _config.BackgroundUpload.MaxFilesPerRun <= 0
                ? int.MaxValue
                : _config.BackgroundUpload.MaxFilesPerRun;

            var allFiles = await _fileRepository.GetAllAsync(ct).ConfigureAwait(false);
            var candidates = allFiles
                .Where(file => IsUploadCandidate(file, maxRetries))
                .Where(file => File.Exists(file.FilePath))
                .Take(maxFiles)
                .ToList();

            if (candidates.Count == 0)
            {
                return BackgroundUploadResult.Completed(
                    scanned,
                    discovered,
                    uploaded,
                    queued,
                    failed);
            }

            foreach (var candidate in candidates)
            {
                var changed = false;
                if (string.IsNullOrWhiteSpace(candidate.DeviceId))
                {
                    candidate.DeviceId = deviceId;
                    changed = true;
                }

                if (string.IsNullOrWhiteSpace(candidate.UserId))
                {
                    candidate.UserId = userId;
                    changed = true;
                }

                if (changed)
                    await _fileRepository.UpdateAsync(candidate, ct).ConfigureAwait(false);
            }

            var batch = await _uploadManager.UploadBatchAsync(candidates, ct).ConfigureAwait(false);
            foreach (var uploadResult in batch.Results)
            {
                ct.ThrowIfCancellationRequested();

                if (!uploadResult.Success)
                {
                    failed++;
                    continue;
                }

                uploaded++;

                var file = candidates.FirstOrDefault(candidate => candidate.Id == uploadResult.FileId);
                if (file is null)
                {
                    failed++;
                    continue;
                }

                if (string.IsNullOrWhiteSpace(file.MegaTempPath))
                {
                    failed++;
                    await MarkPublishFailedAsync(
                        file,
                        "Upload completed without a temporary Mega path.",
                        ct).ConfigureAwait(false);
                    continue;
                }

                try
                {
                    await _kafkaProducer.ProduceUploadRequestAsync(
                        CreateRequest(file, deviceId, userId),
                        ct).ConfigureAwait(false);

                    file.Status = UploadStatus.Processing;
                    file.ErrorMessage = null;
                    await _fileRepository.UpdateAsync(file, ct).ConfigureAwait(false);
                    queued++;
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    // The upload succeeded but the background window expired before
                    // Kafka accepted the request. Keep the file eligible for the next
                    // pass instead of stranding it in Uploaded.
                    file.Status = UploadStatus.Retrying;
                    file.ErrorMessage = "Background upload canceled before Kafka publish.";
                    file.LastAttemptAt = DateTime.UtcNow;
                    try
                    {
                        await _fileRepository.UpdateAsync(file, CancellationToken.None)
                            .ConfigureAwait(false);
                    }
                    catch (Exception updateException)
                    {
                        _logger.LogError(
                            updateException,
                            "Failed to persist canceled publish state for file {FileId}.",
                            file.Id);
                    }

                    throw;
                }
                catch (Exception ex)
                {
                    failed++;
                    _logger.LogWarning(
                        ex,
                        "Kafka publish failed for file {FileId}.",
                        file.Id);
                    await MarkPublishFailedAsync(
                        file,
                        $"Kafka publish failed: {ex.Message}",
                        CancellationToken.None).ConfigureAwait(false);
                }
            }

            _logger.LogInformation(
                "Background upload pass: scanned={Scanned}, discovered={Discovered}, " +
                "uploaded={Uploaded}, queued={Queued}, failed={Failed}.",
                scanned,
                discovered,
                uploaded,
                queued,
                failed);

            return BackgroundUploadResult.Completed(
                scanned,
                discovered,
                uploaded,
                queued,
                failed);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            _logger.LogInformation("Background upload pass canceled.");
            return BackgroundUploadResult.CanceledResult(
                scanned,
                discovered,
                uploaded,
                queued,
                failed);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Background upload pass failed.");
            return BackgroundUploadResult.Failure(ex.Message);
        }
        finally
        {
            _runGate.Release();
        }
    }

    private static bool IsUploadCandidate(FileEntity file, int maxRetries)
    {
        return file.Status switch
        {
            UploadStatus.Pending => true,
            UploadStatus.Retrying => true,
            UploadStatus.Uploaded => true,
            UploadStatus.Failed => file.RetryCount < maxRetries,
            _ => false
        };
    }

    private static FileEntity CreateEntity(
        FileInfo fileInfo,
        string hash,
        string deviceId,
        string userId)
    {
        return new FileEntity
        {
            Id = Guid.NewGuid(),
            FileName = fileInfo.Name,
            FilePath = fileInfo.FullName,
            FileSize = fileInfo.Length,
            ContentHash = hash.ToLowerInvariant(),
            MimeType = GetMimeType(fileInfo.Extension),
            CreatedAt = fileInfo.CreationTimeUtc,
            ModifiedAt = fileInfo.LastWriteTimeUtc,
            DiscoveredAt = DateTime.UtcNow,
            Status = UploadStatus.Pending,
            DeviceId = deviceId,
            UserId = userId
        };
    }

    private static UploadRequestMessage CreateRequest(
        FileEntity file,
        string deviceId,
        string userId)
    {
        return new UploadRequestMessage
        {
            FileId = file.ContentHash,
            FileName = file.FileName,
            FileSize = file.FileSize,
            MimeType = file.MimeType,
            MegaTempPath = file.MegaTempPath ?? string.Empty,
            DeviceId = string.IsNullOrWhiteSpace(file.DeviceId) ? deviceId : file.DeviceId,
            UserId = string.IsNullOrWhiteSpace(file.UserId) ? userId : file.UserId,
            CorrelationId = Guid.NewGuid().ToString(),
            Metadata = new FileMetadata
            {
                CreatedAt = file.CreatedAt,
                ModifiedAt = file.ModifiedAt
            }
        };
    }

    private async Task MarkPublishFailedAsync(
        FileEntity file,
        string errorMessage,
        CancellationToken ct)
    {
        file.Status = UploadStatus.Failed;
        file.ErrorMessage = errorMessage;
        file.RetryCount++;
        file.LastAttemptAt = DateTime.UtcNow;

        try
        {
            await _fileRepository.UpdateAsync(file, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogError(
                ex,
                "Failed to persist Kafka failure state for file {FileId}.",
                file.Id);
        }
    }

    private static string GetMimeType(string extension)
    {
        return extension.ToLowerInvariant() switch
        {
            ".jpg" or ".jpeg" => "image/jpeg",
            ".png" => "image/png",
            ".heic" or ".heif" => "image/heic",
            ".avif" => "image/avif",
            ".webp" => "image/webp",
            ".dng" => "image/x-adobe-dng",
            ".cr2" => "image/x-canon-cr2",
            ".nef" => "image/x-nikon-nef",
            ".arw" => "image/x-sony-arw",
            ".raw" => "image/x-raw",
            ".mov" => "video/quicktime",
            ".mp4" => "video/mp4",
            _ => "application/octet-stream"
        };
    }
}
