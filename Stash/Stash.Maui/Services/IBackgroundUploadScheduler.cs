namespace Stash.Maui.Services;

/// <summary>
/// Registers or cancels the platform background-upload worker. The scheduler
/// is platform-specific; the upload pass itself lives in
/// <see cref="IBackgroundUploadService"/>.
/// </summary>
public interface IBackgroundUploadScheduler
{
    Task ScheduleAsync(CancellationToken ct = default);

    Task CancelAsync(CancellationToken ct = default);
}
