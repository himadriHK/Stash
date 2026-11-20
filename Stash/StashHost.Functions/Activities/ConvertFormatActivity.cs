using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;
using StashHost.Shared.Messages;

namespace StashHost.Functions.Activities;

/// <summary>
/// Activity function that converts file format (HEIC→JPEG, RAW→JPEG, MOV→MP4, etc.).
/// </summary>
public class ConvertFormatActivity
{
    private readonly IConverterFactory _converterFactory;

    public ConvertFormatActivity(IConverterFactory converterFactory)
    {
        _converterFactory = converterFactory;
    }

    [Function(nameof(ConvertFormatActivity))]
    public async Task<ActivityResult> Run(
        [ActivityTrigger] string localFilePath,
        ILogger log)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(localFilePath) || !File.Exists(localFilePath))
                return ActivityResult.Failure("Conversion source file does not exist.");

            var converter = _converterFactory.GetConverter(Path.GetExtension(localFilePath));
            if (converter == null)
            {
                // No conversion needed (already JPEG/MP4)
                return ActivityResult.Success(localFilePath);
            }

            var convertedPath = await converter.ConvertAsync(localFilePath, CancellationToken.None);
            return ActivityResult.Success(convertedPath);
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Format conversion failed for {LocalFilePath}", localFilePath);
            return ActivityResult.Failure($"Format conversion failed: {ex.Message}");
        }
    }
}
