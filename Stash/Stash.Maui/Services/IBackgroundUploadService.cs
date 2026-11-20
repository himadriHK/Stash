namespace Stash.Maui.Services;

/// <summary>
/// Runs one background upload pass: scan configured folders, upload new files,
/// and publish upload requests to Kafka. Platform schedulers call this from
/// WorkManager, BGProcessingTask, or a Windows background task.
/// </summary>
public interface IBackgroundUploadService
{
    Task<BackgroundUploadResult> RunOnceAsync(CancellationToken ct = default);
}
