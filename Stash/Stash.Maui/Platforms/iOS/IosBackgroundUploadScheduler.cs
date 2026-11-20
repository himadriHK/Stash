using BackgroundTasks;
using Foundation;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Stash.Maui.Configuration;
using Stash.Maui.Services;

namespace Stash.Maui;

/// <summary>
/// Registers a BGProcessingTask launch handler and asks iOS to run the upload
/// pass when network access is available.
/// </summary>
public sealed class IosBackgroundUploadScheduler : IBackgroundUploadScheduler
{
    public const string TaskIdentifier = "com.companyname.stash.maui.upload";

    private readonly IBackgroundUploadService _uploadService;
    private readonly StashConfig _config;
    private readonly ILogger<IosBackgroundUploadScheduler> _logger;
    private readonly object _gate = new();

    private bool _registered;

    public IosBackgroundUploadScheduler(
        IBackgroundUploadService uploadService,
        StashConfig config,
        ILogger<IosBackgroundUploadScheduler> logger)
    {
        _uploadService = uploadService ?? throw new ArgumentNullException(nameof(uploadService));
        _config = config ?? throw new ArgumentNullException(nameof(config));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public Task ScheduleAsync(CancellationToken ct = default)
    {
        if (!_config.BackgroundUpload.Enabled)
        {
            BGTaskScheduler.Shared.Cancel(TaskIdentifier);
            return Task.CompletedTask;
        }

        RegisterHandler();

        var intervalMinutes = Math.Max(15, _config.BackgroundUpload.IntervalMinutes);
        var request = new BGProcessingTaskRequest(TaskIdentifier)
        {
            RequiresNetworkConnectivity = true,
            RequiresExternalPower = false,
            EarliestBeginDate = NSDate.FromTimeIntervalSinceNow(intervalMinutes * 60)
        };

        try
        {
            if (!BGTaskScheduler.Shared.Submit(request, out var error))
            {
                _logger.LogWarning(
                    "BGTaskScheduler rejected the background upload request: {Error}",
                    error?.LocalizedDescription ?? "unknown error");
            }
            else
            {
                _logger.LogInformation(
                    "Scheduled iOS background upload no earlier than {IntervalMinutes} minutes.",
                    intervalMinutes);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to submit the iOS background upload request.");
        }

        return Task.CompletedTask;
    }

    public Task CancelAsync(CancellationToken ct = default)
    {
        BGTaskScheduler.Shared.Cancel(TaskIdentifier);
        return Task.CompletedTask;
    }

    private void RegisterHandler()
    {
        lock (_gate)
        {
            if (_registered)
                return;

            BGTaskScheduler.Shared.Register(TaskIdentifier, null, task =>
            {
                if (task is not BGProcessingTask processingTask)
                    return;

                using var cts = new CancellationTokenSource();
                processingTask.ExpirationHandler = () => cts.Cancel();

                _ = Task.Run(async () =>
                {
                    var success = false;
                    try
                    {
                        var result = await _uploadService.RunOnceAsync(cts.Token)
                            .ConfigureAwait(false);
                        success = result.Success;
                    }
                    catch (OperationCanceledException)
                    {
                        _logger.LogInformation("iOS background upload expired.");
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "iOS background upload failed.");
                    }
                    finally
                    {
                        processingTask.SetTaskCompleted(success);
                        await ScheduleAsync().ConfigureAwait(false);
                    }
                });
            });

            _registered = true;
        }
    }
}
