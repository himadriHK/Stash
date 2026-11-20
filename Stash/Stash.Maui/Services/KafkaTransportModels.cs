namespace Stash.Maui.Services;

/// <summary>
/// A message the mobile app wants to publish to Kafka. The transport is
/// responsible for mapping this to a concrete protocol (for example, the
/// Confluent REST Proxy).
/// </summary>
public sealed record KafkaTransportMessage(
    string Topic,
    string Key,
    string Value,
    IReadOnlyDictionary<string, string> Headers);

/// <summary>
/// A message received from Kafka. Values are JSON strings; headers are exposed
/// as text so the mobile code does not depend on a native Kafka client.
/// </summary>
public sealed record KafkaTransportRecord(
    string Topic,
    string Key,
    string Value,
    IReadOnlyDictionary<string, string> Headers);
