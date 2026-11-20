using System.Text.Json;
using System.Text.Json.Serialization;

namespace StashHost.Shared.Messages;

/// <summary>
/// Upload Request message sent from Mobile to Host via Kafka.
/// Key: file_hash (SHA-256)
/// </summary>
public class UploadRequestMessage
{
    public string MessageId { get; set; } = Guid.NewGuid().ToString();
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;
    public string FileId { get; set; } = string.Empty; // SHA-256 hash
    public string FileName { get; set; } = string.Empty;
    public long FileSize { get; set; }
    public string MimeType { get; set; } = string.Empty;
    public string MegaTempPath { get; set; } = string.Empty;
    public FileMetadata? Metadata { get; set; }
    public string DeviceId { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
    public string CorrelationId { get; set; } = Guid.NewGuid().ToString();
    public int Version { get; set; } = 1;
}

public class FileMetadata
{
    public DateTime CreatedAt { get; set; }
    public DateTime ModifiedAt { get; set; }
    public GpsData? Gps { get; set; }
    public Dictionary<string, object>? Exif { get; set; }
}

public class GpsData
{
    public double Lat { get; set; }
    public double Lng { get; set; }
}

/// <summary>
/// Upload Response message sent from Host to Mobile via Kafka.
/// Key: file_hash (SHA-256)
/// </summary>
public class UploadResponseMessage
{
    public string MessageId { get; set; } = Guid.NewGuid().ToString();
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;
    public string FileId { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty; // COMPLETED|FAILED
    public string? PermanentPath { get; set; }
    public Dictionary<string, string> Thumbnails { get; set; } = new();
    public string? ConvertedFormat { get; set; }
    public bool Deduplicated { get; set; }
    public long ProcessingTimeMs { get; set; }
    public string? Error { get; set; }
    public string CorrelationId { get; set; } = string.Empty;
    public int Version { get; set; } = 1;
}

/// <summary>
/// Context passed between Durable Functions activities during file processing.
/// </summary>
public class ProcessingContext
{
    public string MessageId { get; set; } = string.Empty;
    public string FileId { get; set; } = string.Empty;
    public string FileName { get; set; } = string.Empty;
    public long FileSize { get; set; }
    public string MimeType { get; set; } = string.Empty;
    public string MegaTempPath { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
    public string DeviceId { get; set; } = string.Empty;
    public string CorrelationId { get; set; } = string.Empty;
    public string? FileHash { get; set; }
    public string? LocalFilePath { get; set; }
    public string? ConvertedFilePath { get; set; }
    public string? ConvertedFormat { get; set; }
    public string? PermanentPath { get; set; }
    public Dictionary<string, string> Thumbnails { get; set; } = new();
    public bool IsDeduplicated { get; set; }
    public DateTime StartTime { get; set; }
}

/// <summary>
/// Result wrapper for activity function execution.
/// </summary>
public class ActivityResult
{
    public bool IsSuccess { get; private set; }
    public object? Data { get; private set; }
    public string? Error { get; private set; }

    /// <summary>
    /// JSON constructor used by Durable Functions when crossing activity boundaries.
    /// Without this, the private constructor leaves results unreadable after deserialization.
    /// </summary>
    [JsonConstructor]
    public ActivityResult(bool isSuccess, object? data, string? error)
    {
        IsSuccess = isSuccess;
        Data = data;
        Error = error;
    }

    public static ActivityResult Success(object? data = null) => new(true, data, null);
    public static ActivityResult Failure(string error) => new(false, null, error);

    /// <summary>
    /// Reads <see cref="Data"/> as a concrete type. Durable Functions serializes
    /// <see cref="object"/> values as <see cref="JsonElement"/>, so a direct cast
    /// from <see cref="Data"/> would fail for strings, booleans, and dictionaries.
    /// </summary>
    public T? GetData<T>()
    {
        if (Data is null) return default;
        if (Data is T typed) return typed;

        if (Data is JsonElement element)
        {
            try
            {
                return element.Deserialize<T>();
            }
            catch (JsonException)
            {
                return default;
            }
        }

        return default;
    }
}

/// <summary>
/// Request for thumbnail generation activity.
/// </summary>
public class ThumbnailRequest
{
    public string FilePath { get; set; } = string.Empty;
    public int Size { get; set; }
    public string FileId { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
}

/// <summary>
/// Options for MegaStorageProvider.
/// </summary>
public class MegaStorageOptions
{
    public string Email { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;
}