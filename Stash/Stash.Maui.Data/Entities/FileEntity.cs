namespace Stash.Maui.Data.Entities;

/// <summary>
/// A local file discovered by the folder scanner and its upload/processing state.
/// </summary>
public sealed class FileEntity
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public string FileName { get; set; } = string.Empty;

    public string FilePath { get; set; } = string.Empty;

    public long FileSize { get; set; }

    /// <summary>
    /// SHA-256 content hash. The database enforces uniqueness so the same content
    /// is not queued twice.
    /// </summary>
    public string ContentHash { get; set; } = string.Empty;

    public string MimeType { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime ModifiedAt { get; set; } = DateTime.UtcNow;

    public DateTime DiscoveredAt { get; set; } = DateTime.UtcNow;

    public UploadStatus Status { get; set; } = UploadStatus.Pending;

    public string? MegaTempPath { get; set; }

    public string? PermanentPath { get; set; }

    public string? ErrorMessage { get; set; }

    public int RetryCount { get; set; }

    public DateTime? LastAttemptAt { get; set; }

    public string DeviceId { get; set; } = string.Empty;

    public string UserId { get; set; } = string.Empty;

    /// <summary>
    /// Thumbnail variants keyed by size or variant name. Persisted as JSON because
    /// SQLite has no native dictionary type.
    /// </summary>
    public Dictionary<string, string> Thumbnails { get; set; } = new(StringComparer.Ordinal);

    public string? ConvertedFormat { get; set; }

    public bool IsDeduplicated { get; set; }
}
