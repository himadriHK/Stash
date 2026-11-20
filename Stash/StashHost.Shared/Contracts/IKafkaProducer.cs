using StashHost.Shared.Messages;

namespace StashHost.Shared.Contracts;

/// <summary>
/// Interface for Kafka producer operations.
/// </summary>
public interface IKafkaProducer
{
    /// <summary>
    /// Produce an upload request message to Kafka.
    /// </summary>
    Task ProduceUploadRequestAsync(UploadRequestMessage message, CancellationToken ct);

    /// <summary>
    /// Produce an upload response message to Kafka.
    /// </summary>
    Task ProduceUploadResponseAsync(UploadResponseMessage message, CancellationToken ct);

    /// <summary>
    /// Produce a failed/original message to the dead-letter topic.
    /// The original Kafka key is preserved, and the failure reason is added as a header.
    /// </summary>
    Task ProduceDeadLetterAsync(string key, string payload, string reason, CancellationToken ct);
}
