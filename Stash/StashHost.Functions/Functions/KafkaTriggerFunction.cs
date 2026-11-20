using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Extensions.DurableTask;
using Microsoft.Azure.Functions.Worker.Extensions.Kafka;
using Microsoft.DurableTask;
using Microsoft.DurableTask.Client;
using Microsoft.Extensions.Logging;
using StashHost.Functions.Middleware;
using StashHost.Functions.Orchestrations;
using StashHost.Functions.Services;
using StashHost.Functions.Validation;
using StashHost.Shared.Contracts;
using StashHost.Shared.Messages;

namespace StashHost.Functions.Functions;

/// <summary>
/// Kafka trigger function that processes upload requests from the mobile app.
/// Validates the JWT carried in the Kafka message headers, enforces the file hash as
/// the message key, and starts a Durable Functions orchestration.
/// Invalid messages are republished to <c>stash.dlq</c> with an <c>x-dlq-reason</c> header.
/// </summary>
public class KafkaTriggerFunction
{
    private readonly ILogger<KafkaTriggerFunction> _logger;
    private readonly IJwtValidator _jwtValidator;
    private readonly IKafkaProducer _kafkaProducer;

    public KafkaTriggerFunction(
        ILogger<KafkaTriggerFunction> logger,
        IJwtValidator jwtValidator,
        IKafkaProducer kafkaProducer)
    {
        _logger = logger;
        _jwtValidator = jwtValidator;
        _kafkaProducer = kafkaProducer;
    }

    [Function(nameof(KafkaTriggerFunction))]
    public async Task Run(
        [KafkaTrigger(
            "Kafka:BootstrapServers",
            "stash.upload.request",
            ConsumerGroup = "stash-upload-request",
            Username = "Kafka:Username",
            Password = "Kafka:Password",
            Protocol = BrokerProtocol.SaslSsl,
            AuthenticationMode = BrokerAuthenticationMode.ScramSha256,
            IsBatched = true)]
        KafkaRecord[] events,
        [DurableClient] DurableTaskClient durableClient,
        FunctionContext executionContext,
        CancellationToken cancellationToken)
    {
        foreach (var record in events)
        {
            var payload = DecodePayload(record);

            try
            {
                await ProcessRecordAsync(record, payload, durableClient, cancellationToken);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to process Kafka message at offset {Offset}", record.Offset);
                await SendToDeadLetterAsync(record, payload, ex.Message, cancellationToken);
            }
        }
    }

    private async Task ProcessRecordAsync(
        KafkaRecord record,
        string payload,
        DurableTaskClient durableClient,
        CancellationToken cancellationToken)
    {
        UploadRequestMessage? request;
        try
        {
            request = KafkaJson.Deserialize<UploadRequestMessage>(payload);
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Failed to deserialize Kafka message at offset {Offset}", record.Offset);
            await SendToDeadLetterAsync(record, payload, "Invalid or empty upload request payload", cancellationToken);
            return;
        }

        if (request is null)
        {
            await SendToDeadLetterAsync(record, payload, "Invalid or empty upload request payload", cancellationToken);
            return;
        }

        var validationError = UploadRequestValidator.Validate(request);
        if (validationError is not null)
        {
            await SendToDeadLetterAsync(
                record, payload, validationError, cancellationToken, request.FileId);
            return;
        }

        var headers = ToHeaderDictionary(record.Headers);
        var principal = _jwtValidator.Validate(headers);
        if (principal is null)
        {
            await SendToDeadLetterAsync(
                record, payload, "Missing or invalid JWT", cancellationToken, request.FileId);
            return;
        }

        var userId = principal.FindFirst("userId")?.Value
            ?? principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        var deviceId = principal.FindFirst("deviceId")?.Value
            ?? principal.FindFirst("device_id")?.Value;

        if (string.IsNullOrWhiteSpace(userId) || string.IsNullOrWhiteSpace(deviceId))
        {
            await SendToDeadLetterAsync(
                record, payload, "JWT is missing userId or deviceId claims", cancellationToken, request.FileId);
            return;
        }

        // Never trust identity fields supplied in the payload when a signed JWT is present.
        if (!string.IsNullOrWhiteSpace(request.UserId) &&
            !string.Equals(request.UserId, userId, StringComparison.Ordinal))
        {
            await SendToDeadLetterAsync(
                record, payload, "JWT userId does not match the message userId", cancellationToken, request.FileId);
            return;
        }

        if (!string.IsNullOrWhiteSpace(request.DeviceId) &&
            !string.Equals(request.DeviceId, deviceId, StringComparison.Ordinal))
        {
            await SendToDeadLetterAsync(
                record, payload, "JWT deviceId does not match the message deviceId", cancellationToken, request.FileId);
            return;
        }

        request.UserId = userId;
        request.DeviceId = deviceId;

        if (TryGetHeader(headers, "X-User-Id", out var headerUserId) &&
            !string.Equals(headerUserId, userId, StringComparison.Ordinal))
        {
            await SendToDeadLetterAsync(
                record, payload, "X-User-Id header does not match the JWT", cancellationToken, request.FileId);
            return;
        }

        if (TryGetHeader(headers, "X-Device-Id", out var headerDeviceId) &&
            !string.Equals(headerDeviceId, deviceId, StringComparison.Ordinal))
        {
            await SendToDeadLetterAsync(
                record, payload, "X-Device-Id header does not match the JWT", cancellationToken, request.FileId);
            return;
        }

        if (TryGetHeader(headers, "X-Correlation-Id", out var headerCorrelationId) &&
            !string.IsNullOrWhiteSpace(headerCorrelationId))
        {
            if (!string.IsNullOrWhiteSpace(request.CorrelationId) &&
                !string.Equals(request.CorrelationId, headerCorrelationId, StringComparison.Ordinal))
            {
                await SendToDeadLetterAsync(
                    record, payload, "X-Correlation-Id header does not match the message", cancellationToken, request.FileId);
                return;
            }

            request.CorrelationId = headerCorrelationId;
        }

        if (string.IsNullOrWhiteSpace(request.CorrelationId))
        {
            await SendToDeadLetterAsync(
                record, payload, "Message has no correlation id", cancellationToken, request.FileId);
            return;
        }

        var messageKey = GetMessageKey(record);
        if (string.IsNullOrWhiteSpace(messageKey))
        {
            await SendToDeadLetterAsync(
                record, payload, "Kafka message key is missing", cancellationToken, request.FileId);
            return;
        }

        if (!string.Equals(messageKey, request.FileId, StringComparison.OrdinalIgnoreCase))
        {
            await SendToDeadLetterAsync(
                record, payload, "Kafka message key does not match the file hash", cancellationToken, request.FileId);
            return;
        }

        // Idempotency: use correlationId as the Durable Functions instance ID.
        // Check first so a Kafka redelivery does not terminate/restart a running orchestration.
        var instanceId = request.CorrelationId;
        var existingInstance = await durableClient.GetInstanceAsync(instanceId, cancellationToken);
        if (existingInstance is not null)
        {
            _logger.LogInformation(
                "Orchestration {InstanceId} already exists with status {Status}; skipping duplicate message {MessageId}",
                instanceId, existingInstance.RuntimeStatus, request.MessageId);
            return;
        }

        // FileProcessingOrchestration reads an UploadRequestMessage directly via GetInput;
        // passing a wrapper object here would deserialize into an empty request.
        await durableClient.ScheduleNewOrchestrationInstanceAsync(
            nameof(FileProcessingOrchestration),
            request,
            new StartOrchestrationOptions { InstanceId = instanceId },
            cancellationToken);

        _logger.LogInformation(
            "Started orchestration {InstanceId} for file {FileId}", instanceId, request.FileId);
    }

    private async Task SendToDeadLetterAsync(
        KafkaRecord record,
        string payload,
        string reason,
        CancellationToken cancellationToken,
        string? fallbackKey = null)
    {
        var key = GetMessageKey(record) ?? fallbackKey ?? string.Empty;

        try
        {
            await _kafkaProducer.ProduceDeadLetterAsync(key, payload, reason, cancellationToken);
            _logger.LogWarning(
                "Published Kafka message at offset {Offset} to stash.dlq: {Reason}",
                record.Offset, reason);
        }
        catch (Exception ex)
        {
            _logger.LogError(
                ex,
                "Failed to publish Kafka message at offset {Offset} to stash.dlq: {Reason}",
                record.Offset, reason);
        }
    }

    private static string DecodePayload(KafkaRecord record) =>
        record.Value is { Length: > 0 }
            ? Encoding.UTF8.GetString(record.Value)
            : string.Empty;

    private static string? GetMessageKey(KafkaRecord record) =>
        record.Key is { Length: > 0 }
            ? Encoding.UTF8.GetString(record.Key)
            : null;

    private static Dictionary<string, object> ToHeaderDictionary(KafkaHeader[]? headers)
    {
        var result = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);

        foreach (var header in headers ?? Array.Empty<KafkaHeader>())
        {
            if (string.IsNullOrWhiteSpace(header.Key))
                continue;

            result[header.Key] = header.GetValueAsString();
        }

        return result;
    }

    private static bool TryGetHeader(
        IDictionary<string, object> headers,
        string name,
        out string? value)
    {
        value = null;

        if (!headers.TryGetValue(name, out var rawValue))
            return false;

        value = rawValue switch
        {
            string text => text,
            byte[] bytes => Encoding.UTF8.GetString(bytes),
            _ => rawValue?.ToString()
        };

        return true;
    }
}
