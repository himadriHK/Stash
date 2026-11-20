using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Extensions.DurableTask;
using Microsoft.DurableTask;
using Microsoft.Extensions.Logging;
using StashHost.Functions.Activities;
using StashHost.Shared.Messages;
using StashHost.Shared.Validation;

namespace StashHost.Functions.Orchestrations;

/// <summary>
/// Durable Functions orchestration that processes file uploads from Mega.io.
/// Flow: Download → Hash → Dedup → Convert → Thumbnail → Store → Delete → Response
/// </summary>
public class FileProcessingOrchestration
{
    [Function(nameof(FileProcessingOrchestration))]
    public async Task RunOrchestration(
        [OrchestrationTrigger] TaskOrchestrationContext context)
    {
        var request = context.GetInput<UploadRequestMessage>()
            ?? throw new InvalidOperationException(
                $"Orchestration '{context.Name}' requires a non-null {nameof(UploadRequestMessage)} input.");

        var processingContext = new ProcessingContext
        {
            MessageId = request.MessageId,
            FileId = request.FileId,
            FileName = request.FileName,
            FileSize = request.FileSize,
            MimeType = request.MimeType,
            MegaTempPath = request.MegaTempPath,
            UserId = request.UserId,
            DeviceId = request.DeviceId,
            CorrelationId = request.CorrelationId,
            StartTime = context.CurrentUtcDateTime
        };

        try
        {
            // Step 1: Download file from Mega.io temp storage
            var downloadResult = await context.CallActivityAsync<ActivityResult>("DownloadFileActivity", processingContext);
            if (!downloadResult.IsSuccess)
            {
                await HandleFailureAsync(context, processingContext, downloadResult.Error);
                return;
            }
            processingContext.LocalFilePath = downloadResult.GetData<string>() ?? string.Empty;

            // Step 2: Compute SHA-256 hash
            var hashResult = await context.CallActivityAsync<ActivityResult>("ComputeHashActivity", processingContext.LocalFilePath);
            if (!hashResult.IsSuccess)
            {
                await HandleFailureAsync(context, processingContext, hashResult.Error);
                return;
            }
            processingContext.FileHash = hashResult.GetData<string>() ?? string.Empty;
            if (string.IsNullOrWhiteSpace(processingContext.FileHash))
            {
                await HandleFailureAsync(context, processingContext, "Hash computation returned an empty result.");
                return;
            }

            if (!FileHashValidator.Matches(processingContext.FileId, processingContext.FileHash))
            {
                await HandleFailureAsync(
                    context,
                    processingContext,
                    "Computed SHA-256 hash does not match the supplied fileId.");
                return;
            }

            // The computed hash is canonical: storage, thumbnails, and the response must
            // all use the same value, even if the client supplied different hex casing.
            processingContext.FileId = processingContext.FileHash;

            // Step 3: Check deduplication (hash-based path)
            var dedupResult = await context.CallActivityAsync<ActivityResult>("CheckDeduplicationActivity", processingContext);
            if (!dedupResult.IsSuccess)
            {
                await HandleFailureAsync(context, processingContext, dedupResult.Error);
                return;
            }

            if (dedupResult.GetData<bool>())
            {
                processingContext.IsDeduplicated = true;
                processingContext.PermanentPath = StoragePathBuilder.GetPermanentPath(
                    processingContext.UserId,
                    processingContext.FileHash,
                    processingContext.FileName,
                    processingContext.MimeType);
                processingContext.ConvertedFormat = GetConvertedFormat(processingContext.MimeType);
                await SendResponseAsync(context, processingContext, status: "COMPLETED", deduplicated: true);
                return;
            }

            // Step 4: Convert format if needed
            var convertResult = await context.CallActivityAsync<ActivityResult>("ConvertFormatActivity", processingContext.LocalFilePath);
            if (!convertResult.IsSuccess)
            {
                await HandleFailureAsync(context, processingContext, convertResult.Error);
                return;
            }
            processingContext.ConvertedFilePath = convertResult.GetData<string>() ?? string.Empty;
            processingContext.ConvertedFormat = GetConvertedFormat(processingContext.MimeType);

            // Step 5: Generate thumbnails (fan-out)
            var thumbnailTasks = new List<Task<ActivityResult>>();
            foreach (var size in new[] { 128, 256, 512 })
            {
                thumbnailTasks.Add(context.CallActivityAsync<ActivityResult>("GenerateThumbnailActivity", new ThumbnailRequest
                {
                    FilePath = processingContext.ConvertedFilePath,
                    Size = size,
                    FileId = processingContext.FileHash,
                    UserId = processingContext.UserId
                }));
            }
            await Task.WhenAll(thumbnailTasks);

            var thumbnails = new Dictionary<string, string>();
            foreach (var task in thumbnailTasks)
            {
                var result = await task;
                if (result.IsSuccess)
                {
                    var thumbData = result.GetData<Dictionary<string, string>>();
                    if (thumbData is null) continue;

                    foreach (var kvp in thumbData)
                        thumbnails[kvp.Key] = kvp.Value;
                }
            }
            processingContext.Thumbnails = thumbnails;

            // Step 6: Store the permanent file on the local library disk (hash-based path)
            var storeResult = await context.CallActivityAsync<ActivityResult>("StorePermanentActivity", processingContext);
            if (!storeResult.IsSuccess)
            {
                await HandleFailureAsync(context, processingContext, storeResult.Error);
                return;
            }
            processingContext.PermanentPath = storeResult.GetData<string>() ?? string.Empty;

            // Step 7: Delete temp file from Mega.io. Cleanup failure is non-fatal because the
            // permanent copy is already stored, but it must not be silently ignored.
            var deleteResult = await context.CallActivityAsync<ActivityResult>(
                "DeleteTempFileActivity", processingContext.MegaTempPath);
            if (!deleteResult.IsSuccess)
            {
                // One replay-safe retry for transient Mega.io failures.
                deleteResult = await context.CallActivityAsync<ActivityResult>(
                    "DeleteTempFileActivity", processingContext.MegaTempPath);
            }
            if (!deleteResult.IsSuccess)
            {
                var logger = context.CreateReplaySafeLogger(nameof(FileProcessingOrchestration));
                logger.LogWarning(
                    "Temporary file cleanup failed for {MegaTempPath}: {Error}",
                    processingContext.MegaTempPath, deleteResult.Error);
            }

            // Step 8: Send response to mobile via Kafka
            await SendResponseAsync(context, processingContext, status: "COMPLETED", deduplicated: false);
        }
        finally
        {
            await CleanupLocalFileAsync(context, processingContext);
        }
    }

    private static async Task CleanupLocalFileAsync(
        TaskOrchestrationContext context,
        ProcessingContext processingContext)
    {
        if (string.IsNullOrWhiteSpace(processingContext.LocalFilePath))
            return;

        var cleanupResult = await context.CallActivityAsync<ActivityResult>(
            "DeleteLocalTempActivity", processingContext.LocalFilePath);
        if (!cleanupResult.IsSuccess)
        {
            var logger = context.CreateReplaySafeLogger(nameof(FileProcessingOrchestration));
            logger.LogWarning(
                "Local temp cleanup failed for {LocalFilePath}: {Error}",
                processingContext.LocalFilePath, cleanupResult.Error);
        }
    }

    private static string GetConvertedFormat(string mimeType) => mimeType switch
    {
        "image/heic" or "image/heif" or "image/avif" or "image/webp" or "image/png"
            or "image/x-canon-cr2" or "image/x-nikon-nef" or "image/x-sony-arw"
            or "image/x-adobe-dng" or "image/x-raw" => "image/jpeg",
        "video/quicktime" => "video/mp4",
        _ => mimeType
    };

    private async Task SendResponseAsync(TaskOrchestrationContext context, ProcessingContext ctx, string status, bool deduplicated)
    {
        var response = new UploadResponseMessage
        {
            MessageId = context.NewGuid().ToString(),
            Timestamp = context.CurrentUtcDateTime,
            FileId = ctx.FileId,
            Status = status,
            PermanentPath = ctx.PermanentPath,
            Thumbnails = ctx.Thumbnails,
            ConvertedFormat = ctx.ConvertedFormat,
            Deduplicated = deduplicated,
            ProcessingTimeMs = (long)(context.CurrentUtcDateTime - ctx.StartTime).TotalMilliseconds,
            Error = null,
            CorrelationId = ctx.CorrelationId,
            Version = 1
        };

        await context.CallActivityAsync<ActivityResult>("SendResponseActivity", response);
    }

    private async Task HandleFailureAsync(TaskOrchestrationContext context, ProcessingContext ctx, string? error)
    {
        var response = new UploadResponseMessage
        {
            MessageId = context.NewGuid().ToString(),
            Timestamp = context.CurrentUtcDateTime,
            FileId = ctx.FileId,
            Status = "FAILED",
            PermanentPath = null,
            Thumbnails = new Dictionary<string, string>(),
            ConvertedFormat = ctx.ConvertedFormat,
            Deduplicated = false,
            ProcessingTimeMs = (long)(context.CurrentUtcDateTime - ctx.StartTime).TotalMilliseconds,
            Error = error,
            CorrelationId = ctx.CorrelationId,
            Version = 1
        };

        await context.CallActivityAsync<ActivityResult>("SendResponseActivity", response);
    }
}
