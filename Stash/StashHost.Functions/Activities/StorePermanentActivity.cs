using System.IO;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;
using StashHost.Shared.Contracts;
using StashHost.Shared.Messages;
using StashHost.Shared.Services;

namespace StashHost.Functions.Activities;

/// <summary>
/// Activity function that stores the permanent file on the host's own disk, under the
/// configured library root (<c>Storage:Local:RootPath</c>), at a hash-based path.
///
/// The root may be a local drive, a mounted volume, a Storage Space, or a network share
/// (UNC or mapped drive); see <see cref="LocalStorageProvider"/>. MEGA is only used to stage
/// the uploaded temp file, which is deleted after processing.
/// </summary>
public class StorePermanentActivity
{
    private readonly IStorageProviderFactory _storageProviderFactory;

    public StorePermanentActivity(IStorageProviderFactory storageProviderFactory)
    {
        _storageProviderFactory = storageProviderFactory;
    }

    [Function(nameof(StorePermanentActivity))]
    public async Task<ActivityResult> Run(
        [ActivityTrigger] ProcessingContext context,
        ILogger log)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(context.ConvertedFilePath) ||
                !File.Exists(context.ConvertedFilePath))
            {
                return ActivityResult.Failure("Converted file does not exist.");
            }

            if (string.IsNullOrWhiteSpace(context.UserId) || string.IsNullOrWhiteSpace(context.FileHash))
                return ActivityResult.Failure("Permanent storage requires userId and file hash.");

            // Hash-based path for deduplication: /backups/{userId}/{contentHash}{extension}
            // The extension is the normalized (post-conversion) format, not the original name.
            var permanentPath = StoragePathBuilder.GetPermanentPath(
                context.UserId, context.FileHash, context.FileName, context.MimeType);

            // The permanent library always lives on disk, never in MEGA, so this asks for the
            // local provider explicitly instead of the configured default.
            var storageProvider = _storageProviderFactory.Create(LocalStorageProvider.ProviderName);

            using var stream = File.OpenRead(context.ConvertedFilePath);
            var storedPath = await storageProvider.UploadFileAsync(stream, permanentPath, CancellationToken.None);

            log.LogInformation(
                "Stored permanent file {FileId} at {PermanentPath} on local storage",
                context.FileId,
                storedPath);

            return ActivityResult.Success(storedPath);
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Failed to store permanent file {FileId}", context.FileId);
            return ActivityResult.Failure($"Store permanent file failed: {ex.Message}");
        }
    }
}
