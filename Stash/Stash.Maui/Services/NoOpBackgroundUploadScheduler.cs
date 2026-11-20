using Microsoft.Extensions.Logging;

namespace Stash.Maui.Services;

/// <summary>
/// Fallback scheduler for targets without a supported background worker
/// (currently Mac Catalyst and unknown platforms).
/// </summary>
public sealed class NoOpBackgroundUploadScheduler : IBackgroundUploadScheduler
{
    private readonly ILogger<NoOpBackgroundUploadScheduler> _logger;

    public NoOpBackgroundUploadScheduler(ILogger<NoOpBackgroundUploadScheduler> logger)
    {
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public Task ScheduleAsync(CancellationToken ct = default)
    {
        _logger.LogInformation(
            "No platform background-upload scheduler is available; skipping registration.");
        return Task.CompletedTask;
    }

    public Task CancelAsync(CancellationToken ct = default) => Task.CompletedTask;
}
