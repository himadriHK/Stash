using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;
using StashHost.Shared.Messages;
using StashHost.Shared.Validation;

namespace StashHost.Functions.Activities;

/// <summary>
/// Activity function that computes the SHA-256 hash of a local file.
/// </summary>
public class ComputeHashActivity
{
    [Function(nameof(ComputeHashActivity))]
    public async Task<ActivityResult> Run(
        [ActivityTrigger] string localFilePath,
        ILogger log)
    {
        try
        {
            var hashString = await FileHashValidator.ComputeSha256Async(localFilePath);
            return ActivityResult.Success(hashString);
        }
        catch (Exception ex)
        {
            return ActivityResult.Failure($"Hash computation failed: {ex.Message}");
        }
    }
}
