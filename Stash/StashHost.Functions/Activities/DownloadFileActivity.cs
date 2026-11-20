using System.IO;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;
using StashHost.Shared.Contracts;
using StashHost.Shared.Messages;
using StashHost.Shared.Services;

namespace StashHost.Functions.Activities;

/// <summary>
/// Activity function that downloads a file from Mega.io temporary storage to local temp storage.
/// </summary>
public class DownloadFileActivity
{
    private readonly IStorageProviderFactory _storageProviderFactory;

    public DownloadFileActivity(IStorageProviderFactory storageProviderFactory)
    {
        _storageProviderFactory = storageProviderFactory;
    }

    [Function(nameof(DownloadFileActivity))]
    public Task<ActivityResult> Run(
        [ActivityTrigger] ProcessingContext context,
        FunctionContext executionContext)
    {
        return RunCore(
            context,
            executionContext.GetLogger("DownloadFileActivity"),
            executionContext.CancellationToken);
    }

    /// <summary>
    /// Testable activity body. FunctionContext is only used for logging/cancellation.
    /// </summary>
    public async Task<ActivityResult> RunCore(
        ProcessingContext context,
        ILogger log,
        CancellationToken cancellationToken = default)
    {
        string? localDirectory = null;
        try
        {
            var storageProvider = _storageProviderFactory.Create();
            using var stream = await storageProvider.DownloadFileAsync(context.MegaTempPath, cancellationToken);

            // Never let a remote file name escape the temp directory.
            var safeFileName = Path.GetFileName(context.FileName);
            if (string.IsNullOrWhiteSpace(safeFileName))
                safeFileName = "download";

            localDirectory = Path.Combine(Path.GetTempPath(), "stash", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(localDirectory);
            var localPath = Path.Combine(localDirectory, safeFileName);

            long actualLength;
            using (var fileStream = File.Create(localPath))
            {
                await stream.CopyToAsync(fileStream, cancellationToken);
                actualLength = fileStream.Length;
            }

            if (actualLength != context.FileSize)
            {
                TryDeleteDirectory(localDirectory);
                return ActivityResult.Failure(
                    $"Downloaded file size {actualLength} does not match the declared size {context.FileSize}.");
            }

            return ActivityResult.Success(localPath);
        }
        catch (Exception ex)
        {
            if (localDirectory is not null)
                TryDeleteDirectory(localDirectory);

            log.LogError(ex, "Failed to download file {FileId}", context.FileId);
            return ActivityResult.Failure($"Download failed: {ex.Message}");
        }
    }

    private static void TryDeleteDirectory(string directory)
    {
        try
        {
            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
        }
        catch
        {
            // Best effort: the orchestration's cleanup activity will try again.
        }
    }
}
