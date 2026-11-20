using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;
using StashHost.Shared.Contracts;
using StashHost.Shared.Messages;
using StashHost.Shared.Services;

namespace StashHost.Functions.Activities;

/// <summary>
/// Activity function that deletes the temporary file from Mega.io.
/// </summary>
public class DeleteTempFileActivity
{
    private readonly IStorageProviderFactory _storageProviderFactory;

    public DeleteTempFileActivity(IStorageProviderFactory storageProviderFactory)
    {
        _storageProviderFactory = storageProviderFactory;
    }

    [Function(nameof(DeleteTempFileActivity))]
    public async Task<ActivityResult> Run(
        [ActivityTrigger] string megaTempPath,
        ILogger log)
    {
        try
        {
            await _storageProviderFactory.Create().DeleteFileAsync(megaTempPath, CancellationToken.None);
            return ActivityResult.Success();
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Failed to delete temp file {MegaTempPath}", megaTempPath);
            return ActivityResult.Failure($"Delete temp file failed: {ex.Message}");
        }
    }
}
