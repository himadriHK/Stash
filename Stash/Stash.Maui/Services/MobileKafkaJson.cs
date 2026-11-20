using System.Text.Json;

namespace Stash.Maui.Services;

/// <summary>
/// JSON settings shared by the mobile Kafka producer and consumer. The
/// contract is camelCase, while deserialization stays case-insensitive so
/// older PascalCase host payloads remain readable.
/// </summary>
public static class MobileKafkaJson
{
    public static JsonSerializerOptions Options { get; } = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true
    };

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);

    public static T? Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json, Options);
}
