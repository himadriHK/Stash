using System.Text.Json;

namespace StashHost.Functions.Services;

/// <summary>
/// Shared JSON settings for Kafka payloads. The mobile contract uses camelCase;
/// deserialization remains case-insensitive for compatibility with older producers.
/// </summary>
public static class KafkaJson
{
    public static JsonSerializerOptions Options { get; } = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true
    };

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);

    public static T? Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json, Options);
}
