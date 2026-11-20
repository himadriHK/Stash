namespace Stash.Maui.Data.Entities;

/// <summary>
/// Lifecycle of a file from discovery through backend processing.
/// Stored as text in SQLite so the database remains readable to standard tools.
/// </summary>
public enum UploadStatus
{
    Pending,
    Scanning,
    Hashing,
    Uploading,
    Uploaded,
    Processing,
    Completed,
    Failed,
    Retrying,
    Deduplicated
}
