using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;
using StashHost.Shared.Contracts;
using StashHost.Shared.Messages;
using StashHost.Shared.Services;

namespace StashHost.Functions.Activities;

/// <summary>
/// Activity function that checks if a file with the same hash already exists in permanent
/// storage. Path: /backups/{userId}/{contentHash}.jpg under the local library root.
/// </summary>
public class CheckDeduplicationActivity
{
    private readonly IStorageProviderFactory _storageProviderFactory;

    public CheckDeduplicationActivity(IStorageProviderFactory storageProviderFactory)
    {
        _storageProviderFactory = storageProviderFactory;
    }

    [Function(nameof(CheckDeduplicationActivity))]
    public async Task<ActivityResult> Run(
        [ActivityTrigger] ProcessingContext context,
        ILogger log)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(context.UserId) || string.IsNullOrWhiteSpace(context.FileHash))
                return ActivityResult.Failure("Deduplication check requires userId and file hash.");

            var permanentPath = StoragePathBuilder.GetPermanentPath(
                context.UserId, context.FileHash, context.FileName, context.MimeType);

            // Permanent files live on the local library disk, so deduplication must look there
            // and not at the MEGA temp store.
            var storageProvider = _storageProviderFactory.Create(LocalStorageProvider.ProviderName);
            var exists = await storageProvider.FileExistsAsync(permanentPath, CancellationToken.None);

            return ActivityResult.Success(exists);
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Deduplication check failed for file {FileId}", context.FileId);
            return ActivityResult.Failure($"Deduplication check failed: {ex.Message}");
        }
    }
}
