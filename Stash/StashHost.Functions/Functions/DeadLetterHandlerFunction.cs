using System.Text;
using System.Text.Json;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Extensions.Kafka;
using Microsoft.Extensions.Logging;
using StashHost.Shared.Messages;

namespace StashHost.Functions.Functions;

/// <summary>
/// Dead letter handler function that processes failed messages from the DLQ topic.
/// Logs the original FileId and the failure reason, and raises a critical log entry when
/// a single batch contains more than the alert threshold (10) of messages.
/// </summary>
public class DeadLetterHandlerFunction
{
    private const int AlertThreshold = 10;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private readonly ILogger<DeadLetterHandlerFunction> _logger;

    public DeadLetterHandlerFunction(ILogger<DeadLetterHandlerFunction> logger)
    {
        _logger = logger;
    }

    [Function(nameof(DeadLetterHandlerFunction))]
    public Task Run(
        [KafkaTrigger(
            "Kafka:BootstrapServers",
            "stash.dlq",
            ConsumerGroup = "stash-dlq-handler",
            Username = "Kafka:Username",
            Password = "Kafka:Password",
            Protocol = BrokerProtocol.SaslSsl,
            AuthenticationMode = BrokerAuthenticationMode.ScramSha256,
            IsBatched = true)]
        KafkaRecord[] events)
    {
        if (events.Length > AlertThreshold)
        {
            _logger.LogCritical(
                "DLQ alert: received {Count} messages in a single batch (threshold {Threshold})",
                events.Length, AlertThreshold);
        }

        foreach (var record in events)
        {
            var payload = record.Value is { Length: > 0 }
                ? Encoding.UTF8.GetString(record.Value)
                : string.Empty;
            var reason = GetHeader(record.Headers, "x-dlq-reason") ?? "unknown";

            try
            {
                var message = JsonSerializer.Deserialize<UploadRequestMessage>(payload, JsonOptions);
                if (message is null)
                {
                    _logger.LogWarning(
                        "DLQ message at offset {Offset} has no FileId; Reason={Reason}; Key={Key}",
                        record.Offset, reason, GetKey(record));
                    continue;
                }

                _logger.LogWarning(
                    "DLQ message received: FileId={FileId}, Reason={Reason}, Offset={Offset}, Key={Key}",
                    message.FileId, reason, record.Offset, GetKey(record));

                // Store for manual replay UI
                // Alert on-call if DLQ count exceeds threshold
            }
            catch (Exception ex)
            {
                _logger.LogError(
                    ex,
                    "Failed to process DLQ message at offset {Offset}; Reason={Reason}; Key={Key}",
                    record.Offset, reason, GetKey(record));
            }
        }

        return Task.CompletedTask;
    }

    private static string? GetHeader(KafkaHeader[]? headers, string name) =>
        headers?
            .FirstOrDefault(h => string.Equals(h.Key, name, StringComparison.OrdinalIgnoreCase))?
            .GetValueAsString();

    private static string GetKey(KafkaRecord record) =>
        record.Key is { Length: > 0 }
            ? Encoding.UTF8.GetString(record.Key)
            : string.Empty;
}
