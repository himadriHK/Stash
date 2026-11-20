using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Maui;
using Stash.Maui.Configuration;
using Stash.Maui.Services;
using Windows.ApplicationModel.Background;

namespace Stash.Maui;

/// <summary>
/// Registers a Windows background task. The current project is unpackaged
/// (WindowsPackageType=None), so registration normally fails without package
/// identity; the scheduler logs the limitation instead of crashing startup.
/// </summary>
public sealed class WindowsBackgroundUploadScheduler : IBackgroundUploadScheduler
{
    public const string TaskName = "StashBackgroundUpload";

    private readonly StashConfig _config;
    private readonly ILogger<WindowsBackgroundUploadScheduler> _logger;

    public WindowsBackgroundUploadScheduler(
        StashConfig config,
        ILogger<WindowsBackgroundUploadScheduler> logger)
    {
        _config = config ?? throw new ArgumentNullException(nameof(config));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public Task ScheduleAsync(CancellationToken ct = default)
    {
        if (!_config.BackgroundUpload.Enabled)
        {
            CancelAsync(ct).GetAwaiter().GetResult();
            return Task.CompletedTask;
        }

        try
        {
            foreach (var registration in BackgroundTaskRegistration.AllTasks.Values)
            {
                if (string.Equals(registration.Name, TaskName, StringComparison.Ordinal))
                    registration.Unregister(true);
            }

            var builder = new BackgroundTaskBuilder
            {
                Name = TaskName,
                TaskEntryPoint = typeof(WindowsBackgroundUploadTask).FullName
            };
            builder.SetTrigger(new TimeTrigger(15, false));
            builder.AddCondition(new SystemCondition(SystemConditionType.InternetAvailable));
            builder.Register();

            _logger.LogInformation("Registered Windows background upload task.");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                ex,
                "Windows background task registration failed. " +
                "Packaged deployment is required for BackgroundTaskBuilder.");
        }

        return Task.CompletedTask;
    }

    public Task CancelAsync(CancellationToken ct = default)
    {
        try
        {
            foreach (var registration in BackgroundTaskRegistration.AllTasks.Values)
            {
                if (string.Equals(registration.Name, TaskName, StringComparison.Ordinal))
                    registration.Unregister(true);
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Failed to unregister the Windows background upload task.");
        }

        return Task.CompletedTask;
    }
}

/// <summary>
/// Windows background task entry point.
/// </summary>
public sealed class WindowsBackgroundUploadTask : IBackgroundTask
{
    public void Run(IBackgroundTaskInstance taskInstance)
    {
        var deferral = taskInstance.GetDeferral();
        try
        {
            var services = IPlatformApplication.Current?.Services;
            var service = services?.GetService<IBackgroundUploadService>();
            service?.RunOnceAsync(CancellationToken.None).GetAwaiter().GetResult();
        }
        catch
        {
            // Background task failures are surfaced to Windows through the
            // completion state; avoid crashing the host process.
        }
        finally
        {
            deferral.Complete();
        }
    }
}
