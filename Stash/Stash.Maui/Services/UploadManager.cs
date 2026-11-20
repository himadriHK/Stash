using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;
using Stash.Maui.Configuration;
using Stash.Maui.Data.Entities;
using Stash.Maui.Data.Repositories;
using StashHost.Shared.Contracts;

namespace Stash.Maui.Services;

/// <summary>
/// Streams local files to the configured storage provider and persists each
/// Pending -> Uploading -> Uploaded/Failed transition in the local database.
/// Batches run concurrently up to <see cref="UploadSettings.BatchSize"/> files.
/// </summary>
public sealed class UploadManager : IUploadManager
{
    private readonly IStorageProvider _storageProvider;
    private readonly IFileRepository _fileRepository;
    private readonly ILogger<UploadManager> _logger;
    private readonly int _batchSize;
    private readonly long _maxFileSizeBytes;
    private readonly ConcurrentDictionary<Guid, byte> _inProgress = new();

    public UploadManager(
        IStorageProvider storageProvider,
        IFileRepository fileRepository,
        StashConfig configuration,
        ILogger<UploadManager> logger)
    {
        _storageProvider = storageProvider ?? throw new ArgumentNullException(nameof(storageProvider));
        _fileRepository = fileRepository ?? throw new ArgumentNullException(nameof(fileRepository));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        ArgumentNullException.ThrowIfNull(configuration);

        _batchSize = Math.Max(1, configuration.UploadSettings.BatchSize);
        _maxFileSizeBytes = Math.Max(0, configuration.UploadSettings.MaxFileSizeBytes);
    }

    public Task<UploadResult> UploadFileAsync(
        FileEntity file,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(file);
        return UploadFileAsync(file, BuildMegaTempPath(file), ct);
    }

    public async Task<UploadResult> UploadFileAsync(
        FileEntity file,
        string megaTempPath,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(file);
        ct.ThrowIfCancellationRequested();

        var remotePath = string.IsNullOrWhiteSpace(megaTempPath)
            ? BuildMegaTempPath(file)
            : megaTempPath;

        if (!_inProgress.TryAdd(file.Id, 0))
        {
            return UploadResult.Failed(
                file.Id,
                remotePath,
                "An upload for this file is already in progress.");
        }

        try
        {
            if (!File.Exists(file.FilePath))
            {
                return await MarkFailedAsync(
                    file,
                    remotePath,
                    "Local file not found.",
                    incrementRetry: false,
                    ct);
            }

            file.FileSize = file.FileSize > 0
                ? file.FileSize
                : new FileInfo(file.FilePath).Length;

            if (_maxFileSizeBytes > 0 && file.FileSize > _maxFileSizeBytes)
            {
                return await MarkFailedAsync(
                    file,
                    remotePath,
                    $"File size {file.FileSize} exceeds the configured limit of {_maxFileSizeBytes} bytes.",
                    incrementRetry: false,
                    ct);
            }

            file.Status = UploadStatus.Uploading;
            file.MegaTempPath = remotePath;
            file.ErrorMessage = null;
            file.LastAttemptAt = DateTime.UtcNow;
            await _fileRepository.UpdateAsync(file, ct);

            await using var stream = new FileStream(
                file.FilePath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: 64 * 1024,
                FileOptions.Asynchronous | FileOptions.SequentialScan);

            var uploadedPath = await _storageProvider.UploadFileAsync(stream, remotePath, ct);

            file.Status = UploadStatus.Uploaded;
            file.MegaTempPath = uploadedPath;
            file.ErrorMessage = null;
            await _fileRepository.UpdateAsync(file, ct);

            _logger.LogInformation(
                "Uploaded file {FileId} to {MegaTempPath}",
                file.Id,
                uploadedPath);

            return UploadResult.Succeeded(file.Id, uploadedPath);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            await MarkCanceledAsync(file, remotePath);
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Upload failed for file {FileId}", file.Id);
            return await MarkFailedAsync(
                file,
                remotePath,
                ex.Message,
                incrementRetry: true,
                ct);
        }
        finally
        {
            _inProgress.TryRemove(file.Id, out _);
        }
    }

    public async Task<UploadBatchResult> UploadBatchAsync(
        IEnumerable<FileEntity> files,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(files);

        var pending = files.ToList();
        if (pending.Count == 0)
            return new UploadBatchResult(Array.Empty<UploadResult>(), _batchSize, 0);

        var results = new List<UploadResult>(pending.Count);
        var batchCount = 0;

        for (var offset = 0; offset < pending.Count; offset += _batchSize)
        {
            ct.ThrowIfCancellationRequested();
            batchCount++;

            var batch = pending
                .Skip(offset)
                .Take(_batchSize)
                .Select(file => UploadFileAsync(file, BuildMegaTempPath(file), ct))
                .ToArray();

            results.AddRange(await Task.WhenAll(batch));
        }

        return new UploadBatchResult(results, _batchSize, batchCount);
    }

    public Task<bool> IsUploadInProgressAsync(Guid fileId)
    {
        return Task.FromResult(_inProgress.ContainsKey(fileId));
    }

    /// <summary>
    /// Builds the documented temporary Mega path for a file:
    /// <c>/temp/uploads/{deviceId}/{fileName}</c>.
    /// </summary>
    public string BuildMegaTempPath(FileEntity file)
    {
        ArgumentNullException.ThrowIfNull(file);

        var deviceId = string.IsNullOrWhiteSpace(file.DeviceId)
            ? "unknown-device"
            : file.DeviceId.Trim();

        var fileName = Path.GetFileName(file.FileName);
        if (string.IsNullOrWhiteSpace(fileName))
            fileName = Path.GetFileName(file.FilePath);
        if (string.IsNullOrWhiteSpace(fileName))
            fileName = file.Id == Guid.Empty ? "unknown-file" : file.Id.ToString("N");

        return $"/temp/uploads/{deviceId}/{fileName}";
    }

    private async Task<UploadResult> MarkFailedAsync(
        FileEntity file,
        string remotePath,
        string errorMessage,
        bool incrementRetry,
        CancellationToken ct)
    {
        file.Status = UploadStatus.Failed;
        file.MegaTempPath = remotePath;
        file.ErrorMessage = errorMessage;
        file.LastAttemptAt = DateTime.UtcNow;
        if (incrementRetry)
            file.RetryCount++;

        try
        {
            await _fileRepository.UpdateAsync(file, ct);
        }
        catch (Exception updateException)
        {
            // Preserve the original upload error; a local persistence failure
            // should not hide why the upload failed.
            _logger.LogError(
                updateException,
                "Failed to persist failed upload state for file {FileId}",
                file.Id);
        }

        return UploadResult.Failed(file.Id, remotePath, errorMessage);
    }

    private async Task MarkCanceledAsync(FileEntity file, string remotePath)
    {
        file.Status = UploadStatus.Pending;
        file.MegaTempPath = remotePath;
        file.ErrorMessage = "Upload canceled.";
        file.LastAttemptAt = DateTime.UtcNow;

        try
        {
            // The caller's token is already canceled; persist the reset state best-effort.
            await _fileRepository.UpdateAsync(file, CancellationToken.None);
        }
        catch (Exception updateException)
        {
            _logger.LogError(
                updateException,
                "Failed to persist canceled upload state for file {FileId}",
                file.Id);
        }
    }
}
