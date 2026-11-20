using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;
using StashHost.Shared.Messages;

namespace StashHost.Functions.Activities;

/// <summary>
/// Deletes the per-file local temp directory created by DownloadFileActivity.
/// The activity only deletes paths under the process temp "/stash" root.
/// </summary>
public class DeleteLocalTempActivity
{
    [Function(nameof(DeleteLocalTempActivity))]
    public Task<ActivityResult> Run(
        [ActivityTrigger] string localFilePath,
        ILogger log)
    {
        if (string.IsNullOrWhiteSpace(localFilePath))
            return Task.FromResult(ActivityResult.Success("No local temp file to delete."));

        try
        {
            var stashRoot = Path.Combine(Path.GetTempPath(), "stash");
            var fullPath = Path.GetFullPath(localFilePath);
            var rootPrefix = stashRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                + Path.DirectorySeparatorChar;

            if (!fullPath.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase))
            {
                return Task.FromResult(ActivityResult.Failure(
                    "Refusing to delete a path outside the local stash temp directory."));
            }

            var directory = Path.GetDirectoryName(fullPath);
            if (directory is null
                || string.Equals(directory, stashRoot, StringComparison.OrdinalIgnoreCase))
            {
                return Task.FromResult(ActivityResult.Failure(
                    "Refusing to delete the local stash temp root."));
            }

            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
            else if (File.Exists(fullPath))
                File.Delete(fullPath);

            return Task.FromResult(ActivityResult.Success(true));
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Failed to delete local temp path {LocalFilePath}", localFilePath);
            return Task.FromResult(ActivityResult.Failure($"Local temp cleanup failed: {ex.Message}"));
        }
    }
}
