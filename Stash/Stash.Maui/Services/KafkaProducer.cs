using Microsoft.Extensions.Logging;
using Stash.Maui.Auth;
using Stash.Maui.Configuration;
using StashHost.Shared.Contracts;
using StashHost.Shared.Messages;

namespace Stash.Maui.Services;

/// <summary>
/// Mobile Kafka producer built on <see cref="IKafkaTransport"/>. The transport
/// is HTTP-based on devices, so no native Kafka runtime is shipped.
/// </summary>
public sealed class KafkaProducer : IKafkaProducer
{
    private readonly IKafkaTransport _transport;
    private readonly IAuthenticationService _authenticationService;
    private readonly StashConfig _config;
    private readonly ILogger<KafkaProducer> _logger;

    public KafkaProducer(
        IKafkaTransport transport,
        IAuthenticationService authenticationService,
        StashConfig config,
        ILogger<KafkaProducer> logger)
    {
        _transport = transport ?? throw new ArgumentNullException(nameof(transport));
        _authenticationService = authenticationService
            ?? throw new ArgumentNullException(nameof(authenticationService));
        _config = config ?? throw new ArgumentNullException(nameof(config));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async Task ProduceUploadRequestAsync(
        UploadRequestMessage message,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(message);

        if (string.IsNullOrWhiteSpace(message.FileId))
            throw new ArgumentException("Upload requests require a file hash key.", nameof(message));

        var authenticated = await _authenticationService
            .EnsureValidAccessTokenAsync(ct)
            .ConfigureAwait(false);
        var accessToken = authenticated
            ? await _authenticationService.GetAccessTokenAsync(ct).ConfigureAwait(false)
            : string.Empty;
        if (string.IsNullOrWhiteSpace(accessToken))
        {
            throw new InvalidOperationException(
                "Cannot produce an upload request without an authenticated access token.");
        }

        var deviceId = string.IsNullOrWhiteSpace(message.DeviceId)
            ? await _authenticationService.GetOrCreateDeviceIdAsync(ct).ConfigureAwait(false)
            : message.DeviceId;
        var userId = string.IsNullOrWhiteSpace(message.UserId)
            ? await _authenticationService.GetUserIdAsync(ct).ConfigureAwait(false)
            : message.UserId;
        var correlationId = string.IsNullOrWhiteSpace(message.CorrelationId)
            ? Guid.NewGuid().ToString()
            : message.CorrelationId;

        message.DeviceId = deviceId;
        message.UserId = userId;
        message.CorrelationId = correlationId;

        var headers = CreateHeaders();
        headers["Authorization"] = $"Bearer {accessToken}";
        headers["X-Correlation-Id"] = correlationId;
        if (!string.IsNullOrWhiteSpace(deviceId))
            headers["X-Device-Id"] = deviceId;
        if (!string.IsNullOrWhiteSpace(userId))
            headers["X-User-Id"] = userId;

        var json = MobileKafkaJson.Serialize(message);
        _logger.LogDebug(
            "Producing upload request for file {FileId} with correlation {CorrelationId}.",
            message.FileId,
            correlationId);

        await _transport.ProduceAsync(
            new KafkaTransportMessage(
                _config.Kafka.TopicUploadRequest,
                message.FileId,
                json,
                headers),
            ct).ConfigureAwait(false);
    }

    public async Task ProduceUploadResponseAsync(
        UploadResponseMessage message,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(message);

        if (string.IsNullOrWhiteSpace(message.FileId))
            throw new ArgumentException("Upload responses require a file hash key.", nameof(message));

        var headers = CreateHeaders();
        if (!string.IsNullOrWhiteSpace(message.CorrelationId))
            headers["X-Correlation-Id"] = message.CorrelationId;

        await _transport.ProduceAsync(
            new KafkaTransportMessage(
                _config.Kafka.TopicUploadResponse,
                message.FileId,
                MobileKafkaJson.Serialize(message),
                headers),
            ct).ConfigureAwait(false);
    }

    public async Task ProduceDeadLetterAsync(
        string key,
        string payload,
        string reason,
        CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        ArgumentNullException.ThrowIfNull(payload);

        var headers = CreateHeaders();
        headers["x-dlq-reason"] = reason ?? string.Empty;

        await _transport.ProduceAsync(
            new KafkaTransportMessage(
                _config.Kafka.TopicDeadLetter,
                key,
                payload,
                headers),
            ct).ConfigureAwait(false);
    }

    private static Dictionary<string, string> CreateHeaders()
    {
        return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["X-Message-Version"] = "1"
        };
    }
}
