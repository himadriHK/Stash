namespace Stash.Maui.Services;

/// <summary>
/// Mobile-safe Kafka transport abstraction. Implementations can use an HTTP
/// proxy, a relay, or an in-memory fake; the producer/consumer logic does not
/// depend on a native Kafka runtime.
/// </summary>
public interface IKafkaTransport
{
    Task ProduceAsync(KafkaTransportMessage message, CancellationToken ct = default);

    /// <summary>
    /// Consumes records until <paramref name="ct"/> is cancelled. The callback
    /// is invoked once per record and should handle its own per-record errors.
    /// </summary>
    Task ConsumeAsync(
        string topic,
        string groupId,
        Func<KafkaTransportRecord, CancellationToken, Task> onRecord,
        CancellationToken ct = default);
}
