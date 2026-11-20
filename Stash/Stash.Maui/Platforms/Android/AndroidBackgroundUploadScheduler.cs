using Android.App;
using Android.Content;
using AndroidX.Work;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Maui;
using Microsoft.Extensions.Logging;
using Stash.Maui.Configuration;
using Stash.Maui.Services;

namespace Stash.Maui;

/// <summary>
/// Schedules the upload pass with Android WorkManager. Periodic work is clamped
/// to WorkManager's 15-minute minimum; the worker requires network access.
/// </summary>
public sealed class AndroidBackgroundUploadScheduler : IBackgroundUploadScheduler
{
    public const string WorkName = "stash-background-upload";

    private readonly StashConfig _config;
    private readonly ILogger<AndroidBackgroundUploadScheduler> _logger;

    public AndroidBackgroundUploadScheduler(
        StashConfig config,
        ILogger<AndroidBackgroundUploadScheduler> logger)
    {
        _config = config ?? throw new ArgumentNullException(nameof(config));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public Task ScheduleAsync(CancellationToken ct = default)
    {
        var workManager = WorkManager.GetInstance(Android.App.Application.Context);
        if (!_config.BackgroundUpload.Enabled)
        {
            workManager.CancelUniqueWork(WorkName);
            return Task.CompletedTask;
        }

        var intervalMinutes = Math.Max(15, _config.BackgroundUpload.IntervalMinutes);
        var constraints = new Constraints.Builder()
            .SetRequiredNetworkType(NetworkType.Connected!)
            .Build();

        var request = PeriodicWorkRequest.Builder
            .From<BackgroundUploadWorker>(intervalMinutes, Java.Util.Concurrent.TimeUnit.Minutes!)
            .SetConstraints(constraints)
            .AddTag(WorkName)
            .Build();

        workManager.EnqueueUniquePeriodicWork(
            WorkName,
            ExistingPeriodicWorkPolicy.Keep!,
            request);

        _logger.LogInformation(
            "Scheduled Android background upload every {IntervalMinutes} minutes.",
            intervalMinutes);
        return Task.CompletedTask;
    }

    public Task CancelAsync(CancellationToken ct = default)
    {
        WorkManager.GetInstance(Android.App.Application.Context).CancelUniqueWork(WorkName);
        return Task.CompletedTask;
    }
}

/// <summary>
/// WorkManager entry point. The MAUI service provider is used because Android
/// constructs workers, not the DI container.
/// </summary>
public sealed class BackgroundUploadWorker : Worker
{
    public BackgroundUploadWorker(Context context, WorkerParameters workerParameters)
        : base(context, workerParameters)
    {
    }

    public override Result? DoWork()
    {
        var services = IPlatformApplication.Current?.Services;
        var service = services?.GetService<IBackgroundUploadService>();
        if (service is null)
            return Result.InvokeFailure();

        try
        {
            var result = service.RunOnceAsync(CancellationToken.None).GetAwaiter().GetResult();
            return result.Success ? Result.InvokeSuccess() : Result.InvokeRetry();
        }
        catch (Exception)
        {
            return Result.InvokeRetry();
        }
    }
}
