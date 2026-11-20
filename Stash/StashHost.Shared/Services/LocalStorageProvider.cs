using StashHost.Shared.Contracts;

namespace StashHost.Shared.Services;

/// <summary>
/// <see cref="IStorageProvider"/> backed by a directory on the host's filesystem.
///
/// The configured root may be any path the process can write to: a local drive
/// (<c>D:\StashLibrary</c>), a mounted volume, a Windows Storage Space, or a network share
/// (<c>\\nas\photos\stash</c> or a mapped drive such as <c>Z:\stash</c>). The provider only
/// uses <see cref="File"/> and <see cref="Directory"/> APIs, so the filesystem/OS handles
/// sharing, permissions and remote I/O.
///
/// Callers keep using the same logical paths as the remote providers
/// (<c>/backups/{userId}/{hash}.jpg</c>); this provider maps them below the root and always
/// returns the logical path, so switching between storage backends does not change the
/// pipeline or the paths reported to clients.
/// </summary>
public sealed class LocalStorageProvider : IStorageProvider
{
    /// <summary>
    /// The <c>Storage:Provider</c>/<c>IStorageProviderFactory.Create</c> name for this provider.
    /// </summary>
    public const string ProviderName = "Local";

    /// <summary>
    /// Initializes a provider rooted at <paramref name="rootPath"/>.
    /// Environment variables (<c>%VAR%</c>) and a leading <c>~</c> are expanded.
    /// </summary>
    public LocalStorageProvider(string rootPath)
    {
        RootPath = NormalizeRoot(rootPath);
    }

    /// <summary>
    /// Absolute root directory holding the stored files.
    /// </summary>
    public string RootPath { get; }

    /// <summary>
    /// Expands and validates a configured root path.
    /// </summary>
    public static string NormalizeRoot(string? rootPath)
    {
        if (string.IsNullOrWhiteSpace(rootPath))
            throw new ArgumentException("A local storage root path is required.", nameof(rootPath));

        var expanded = Environment
            .ExpandEnvironmentVariables(rootPath.Trim().Trim('"'));

        if (expanded.StartsWith('~'))
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            expanded = Path.Combine(home, expanded[1..].TrimStart('/', '\\'));
        }

        if (!Path.IsPathRooted(expanded))
            throw new ArgumentException(
                $"Local storage root '{rootPath}' must be an absolute path " +
                "(for example D:\\StashLibrary, \\\\nas\\photos\\stash or ~/StashLibrary).",
                nameof(rootPath));

        var fullPath = Path.GetFullPath(expanded);

        if (fullPath.Length > 3)
            fullPath = fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

        return fullPath;
    }

    /// <summary>
    /// Maps a logical storage path to an absolute local file path, rejecting anything that
    /// would escape <see cref="RootPath"/> (for example <c>/backups/../../etc/passwd</c>).
    /// </summary>
    public string ResolvePhysicalPath(string logicalPath)
    {
        if (string.IsNullOrWhiteSpace(logicalPath))
            throw new ArgumentException("Storage path cannot be empty.", nameof(logicalPath));

        var normalized = logicalPath.Replace('\\', '/');

        // "//server/share/file" is a UNC path to another machine, not a library-relative path.
        if (normalized.StartsWith("//", StringComparison.Ordinal))
            throw new ArgumentException($"Storage path '{logicalPath}' must be relative to the storage root.", nameof(logicalPath));

        var relative = normalized.Trim('/');

        if (relative.Length == 0)
            throw new ArgumentException("Storage path must name a file.", nameof(logicalPath));
        if (Path.IsPathRooted(relative) || relative.Contains(':'))
            throw new ArgumentException($"Storage path '{logicalPath}' must be relative to the storage root.", nameof(logicalPath));

        foreach (var segment in relative.Split('/'))
        {
            if (segment is "." or "..")
                throw new ArgumentException($"Storage path '{logicalPath}' may not contain '.' or '..' segments.", nameof(logicalPath));
            if (segment.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                throw new ArgumentException($"Storage path '{logicalPath}' contains invalid characters.", nameof(logicalPath));
        }

        var physicalPath = Path.GetFullPath(
            Path.Combine(RootPath, relative.Replace('/', Path.DirectorySeparatorChar)));

        if (!IsUnderRoot(physicalPath))
            throw new ArgumentException($"Storage path '{logicalPath}' resolves outside the storage root.", nameof(logicalPath));

        return physicalPath;
    }

    public async Task<string> UploadFileAsync(Stream fileStream, string remotePath, CancellationToken ct)
    {
        if (fileStream is null)
            throw new ArgumentNullException(nameof(fileStream));

        var physicalPath = ResolvePhysicalPath(remotePath);
        var directory = Path.GetDirectoryName(physicalPath);
        if (!string.IsNullOrEmpty(directory))
            Directory.CreateDirectory(directory);

        // Write next to the destination and move into place, so a crash or a full disk never
        // leaves a half-written file that deduplication would then treat as a complete copy.
        var temporaryPath = $"{physicalPath}.{Guid.NewGuid():N}.partial";

        try
        {
            await using (var destination = new FileStream(
                             temporaryPath,
                             FileMode.CreateNew,
                             FileAccess.Write,
                             FileShare.None,
                             bufferSize: 81_920,
                             useAsync: true))
            {
                await fileStream.CopyToAsync(destination, ct);
                await destination.FlushAsync(ct);
            }

            File.Move(temporaryPath, physicalPath, overwrite: true);
        }
        catch
        {
            if (File.Exists(temporaryPath))
                File.Delete(temporaryPath);

            throw;
        }

        return remotePath;
    }

    public Task<bool> DeleteFileAsync(string remotePath, CancellationToken ct)
    {
        var physicalPath = ResolvePhysicalPath(remotePath);

        if (!File.Exists(physicalPath))
            return Task.FromResult(false);

        File.Delete(physicalPath);
        return Task.FromResult(true);
    }

    public Task<Stream> DownloadFileAsync(string remotePath, CancellationToken ct)
    {
        var physicalPath = ResolvePhysicalPath(remotePath);

        if (!File.Exists(physicalPath))
            throw new FileNotFoundException($"File not found: {physicalPath}", physicalPath);

        Stream stream = new FileStream(
            physicalPath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 81_920,
            useAsync: true);

        return Task.FromResult(stream);
    }

    public Task<bool> FileExistsAsync(string remotePath, CancellationToken ct) =>
        Task.FromResult(File.Exists(ResolvePhysicalPath(remotePath)));

    public Task<long> GetFileSizeAsync(string remotePath, CancellationToken ct)
    {
        var physicalPath = ResolvePhysicalPath(remotePath);

        if (!File.Exists(physicalPath))
            throw new FileNotFoundException($"File not found: {physicalPath}", physicalPath);

        return Task.FromResult(new FileInfo(physicalPath).Length);
    }

    private bool IsUnderRoot(string physicalPath)
    {
        var rootPrefix = RootPath.EndsWith(Path.DirectorySeparatorChar)
            ? RootPath
            : RootPath + Path.DirectorySeparatorChar;

        return physicalPath.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase)
               || string.Equals(physicalPath, RootPath, StringComparison.OrdinalIgnoreCase);
    }
}
