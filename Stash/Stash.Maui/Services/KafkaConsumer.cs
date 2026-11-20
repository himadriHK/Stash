using Microsoft.Extensions.Logging;
using Stash.Maui.Auth;
using Stash.Maui.Configuration;
using Stash.Maui.Data.Entities;
using Stash.Maui.Data.Repositories;
using StashHost.Shared.Messages;

namespace Stash.Maui.Services;

/// <summary>
/// Consumes host upload responses and applies them to the local file database.
/// </summary>
public interface IKafkaConsumer
{
    Task ConsumeUploadResponsesAsync(CancellationToken ct = default);

    Task StartAsync(CancellationToken ct = default);

    Task StopAsync(CancellationToken ct = default);
}

/// <summary>
/// Mobile response consumer. The consumer group is stable per installation
/// (<c>stash-mobile-{deviceId}</c>), while the underlying transport instance is
/// recreated as needed.
/// </summary>
public sealed class KafkaConsumer : IKafkaConsumer, IAsyncDisposable
{
    private readonly IKafkaTransport _transport;
    private readonly IAuthenticationService _authenticationService;
    private readonly IFileRepository _fileRepository;
    private readonly StashConfig _config;
    private readonly ILogger<KafkaConsumer> _logger;
    private readonly SemaphoreSlim _lifecycleGate = new(1, 1);

    private CancellationTokenSource? _loopCts;
    private Task? _loopTask;

    public KafkaConsumer(
        IKafkaTransport transport,
        IAuthenticationService authenticationService,
        IFileRepository fileRepository,
        StashConfig config,
        ILogger<KafkaConsumer> logger)
    {
        _transport = transport ?? throw new ArgumentNullException(nameof(transport));
        _authenticationService = authenticationService
            ?? throw new ArgumentNullException(nameof(authenticationService));
        _fileRepository = fileRepository ?? throw new ArgumentNullException(nameof(fileRepository));
        _config = config ?? throw new ArgumentNullException(nameof(config));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async Task ConsumeUploadResponsesAsync(CancellationToken ct = default)
    {
        var deviceId = await _authenticationService.GetOrCreateDeviceIdAsync(ct)
            .ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(deviceId))
        {
            throw new InvalidOperationException(
                "Cannot consume upload responses without a stable device identifier.");
        }

        var groupId = $"stash-mobile-{deviceId}";
        _logger.LogInformation(
            "Consuming {Topic} with consumer group {GroupId}.",
            _config.Kafka.TopicUploadResponse,
            groupId);

        await _transport.ConsumeAsync(
            _config.Kafka.TopicUploadResponse,
            groupId,
            HandleRecordAsync,
            ct).ConfigureAwait(false);
    }

    public async Task StartAsync(CancellationToken ct = default)
    {
        await _lifecycleGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_loopTask is { IsCompleted: false })
                return;

            _loopCts?.Dispose();
            var loopCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            _loopCts = loopCts;
            _loopTask = Task.Run(
                () => ConsumeUploadResponsesAsync(loopCts.Token),
                CancellationToken.None);
        }
        finally
        {
            _lifecycleGate.Release();
        }
    }

    public async Task StopAsync(CancellationToken ct = default)
    {
        CancellationTokenSource? loopCts;
        Task? loopTask;

        await _lifecycleGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            loopCts = _loopCts;
            loopTask = _loopTask;
            _loopCts = null;
            _loopTask = null;
        }
        finally
        {
            _lifecycleGate.Release();
        }

        if (loopCts is null)
            return;

        await loopCts.CancelAsync().ConfigureAwait(false);

        if (loopTask is not null)
        {
            try
            {
                await loopTask.WaitAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Normal shutdown.
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Kafka consumer loop stopped with an error.");
            }
        }

        loopCts.Dispose();
    }

    private async Task HandleRecordAsync(
        KafkaTransportRecord record,
        CancellationToken ct)
    {
        try
        {
            var response = MobileKafkaJson.Deserialize<UploadResponseMessage>(record.Value);
            if (response is null || string.IsNullOrWhiteSpace(response.FileId))
            {
                _logger.LogWarning("Ignoring a malformed upload response.");
                return;
            }

            var completed = string.Equals(
                response.Status,
                "COMPLETED",
                StringComparison.OrdinalIgnoreCase);
            var failed = string.Equals(
                response.Status,
                "FAILED",
                StringComparison.OrdinalIgnoreCase);

            if (!completed && !failed)
            {
                _logger.LogWarning(
                    "Ignoring upload response {MessageId} with unsupported status {Status}.",
                    response.MessageId,
                    response.Status);
                return;
            }

            var file = await _fileRepository
                .GetByContentHashAsync(response.FileId, ct)
                .ConfigureAwait(false);
            if (file is null)
            {
                _logger.LogDebug(
                    "Ignoring response for unknown local file {FileId}.",
                    response.FileId);
                return;
            }

            file.Status = completed ? UploadStatus.Completed : UploadStatus.Failed;
            file.PermanentPath = response.PermanentPath;
            file.Thumbnails = response.Thumbnails ?? new Dictionary<string, string>(StringComparer.Ordinal);
            file.ConvertedFormat = response.ConvertedFormat;
            file.IsDeduplicated = response.Deduplicated;
            file.ErrorMessage = response.Error;
            file.LastAttemptAt = DateTime.UtcNow;

            await _fileRepository.UpdateAsync(file, ct).ConfigureAwait(false);

            _logger.LogInformation(
                "Applied upload response {MessageId} to file {FileId}: {Status}.",
                response.MessageId,
                response.FileId,
                file.Status);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                ex,
                "Failed to process an upload response from topic {Topic}.",
                record.Topic);
        }
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync().ConfigureAwait(false);
        _lifecycleGate.Dispose();
    }
}
