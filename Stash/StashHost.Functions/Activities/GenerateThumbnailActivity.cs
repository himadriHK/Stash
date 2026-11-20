using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;
using StashHost.Shared.Contracts;
using StashHost.Shared.Messages;
using StashHost.Shared.Services;

namespace StashHost.Functions.Activities;

/// <summary>
/// Activity function that generates thumbnails in multiple sizes (128, 256, 512).
/// </summary>
public class GenerateThumbnailActivity
{
    private readonly IThumbnailGenerator _thumbnailGenerator;
    private readonly IStorageProviderFactory _storageProviderFactory;

    public GenerateThumbnailActivity(
        IThumbnailGenerator thumbnailGenerator,
        IStorageProviderFactory storageProviderFactory)
    {
        _thumbnailGenerator = thumbnailGenerator;
        _storageProviderFactory = storageProviderFactory;
    }

    [Function(nameof(GenerateThumbnailActivity))]
    public async Task<ActivityResult> Run(
        [ActivityTrigger] ThumbnailRequest request,
        ILogger log)
    {
        try
        {
            var thumbnail = await _thumbnailGenerator.GenerateAsync(request.FilePath, request.Size, CancellationToken.None);
            var thumbPath = await _storageProviderFactory.Create().UploadFileAsync(
                thumbnail,
                StoragePathBuilder.GetThumbnailPath(request.UserId, request.FileId, request.Size),
                CancellationToken.None);

            return ActivityResult.Success(new Dictionary<string, string>
            {
                [request.Size.ToString()] = thumbPath
            });
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Thumbnail generation failed for file {FileId} size {Size}", request.FileId, request.Size);
            return ActivityResult.Failure($"Thumbnail generation failed: {ex.Message}");
        }
    }
}
