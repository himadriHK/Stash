using Stash.Maui.Data.Entities;

namespace Stash.Maui.Services;

/// <summary>
/// Discovers media files in a configured folder and computes their content hashes.
/// </summary>
public interface IFolderScannerService
{
    /// <summary>
    /// Scans with the app's default media patterns and includes subfolders.
    /// </summary>
    Task<IReadOnlyList<FileInfo>> ScanFolderAsync(
        string folderPath,
        CancellationToken ct = default);

    /// <summary>
    /// Scans with explicit include/exclude patterns. An empty include list means
    /// "all files"; exclude patterns are applied after include patterns.
    /// </summary>
    Task<IReadOnlyList<FileInfo>> ScanFolderAsync(
        string folderPath,
        IReadOnlyCollection<string>? includePatterns,
        IReadOnlyCollection<string>? excludePatterns,
        bool includeSubfolders,
        CancellationToken ct = default);

    /// <summary>
    /// Scans using a persisted folder configuration.
    /// </summary>
    Task<IReadOnlyList<FileInfo>> ScanFolderAsync(
        FolderConfig folder,
        CancellationToken ct = default);

    /// <summary>
    /// Computes a lowercase hexadecimal SHA-256 hash of the file contents.
    /// </summary>
    Task<string> ComputeFileHashAsync(string filePath, CancellationToken ct = default);

    /// <summary>
    /// Returns false for missing paths, files, and folders that cannot be read.
    /// </summary>
    Task<bool> IsFolderAccessibleAsync(string folderPath);
}
