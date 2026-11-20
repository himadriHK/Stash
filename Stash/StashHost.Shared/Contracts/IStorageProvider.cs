namespace StashHost.Shared.Contracts;

/// <summary>
/// Storage provider abstraction for object storage operations.
/// Shared between Mobile App and StashHost backend.
/// </summary>
public interface IStorageProvider
{
    /// <summary>
    /// Upload a file stream to the specified remote path.
    /// </summary>
    Task<string> UploadFileAsync(Stream fileStream, string remotePath, CancellationToken ct);

    /// <summary>
    /// Delete a file at the specified remote path.
    /// </summary>
    Task<bool> DeleteFileAsync(string remotePath, CancellationToken ct);

    /// <summary>
    /// Download a file from the specified remote path as a stream.
    /// </summary>
    Task<Stream> DownloadFileAsync(string remotePath, CancellationToken ct);

    /// <summary>
    /// Check if a file exists at the specified remote path.
    /// </summary>
    Task<bool> FileExistsAsync(string remotePath, CancellationToken ct);

    /// <summary>
    /// Get the size of a file at the specified remote path.
    /// </summary>
    Task<long> GetFileSizeAsync(string remotePath, CancellationToken ct);
}