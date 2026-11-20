using System.IO.Enumeration;
using System.Security.Cryptography;
using Stash.Maui.Data;
using Stash.Maui.Data.Entities;

namespace Stash.Maui.Services;

/// <summary>
/// Filesystem scanner for local media. It never opens or decodes media content;
/// discovery is based on file names and hashing is streamed with SHA-256.
/// </summary>
public sealed class FolderScannerService : IFolderScannerService
{
    private static readonly EnumerationOptions DefaultEnumerationOptions = new()
    {
        RecurseSubdirectories = false,
        IgnoreInaccessible = true,
        ReturnSpecialDirectories = false,
        AttributesToSkip = FileAttributes.Hidden
            | FileAttributes.System
            | FileAttributes.ReparsePoint
    };

    public Task<IReadOnlyList<FileInfo>> ScanFolderAsync(
        string folderPath,
        CancellationToken ct = default)
    {
        return ScanFolderAsync(
            folderPath,
            MediaFilePatterns.DefaultIncludePatterns,
            Array.Empty<string>(),
            includeSubfolders: true,
            ct);
    }

    public Task<IReadOnlyList<FileInfo>> ScanFolderAsync(
        FolderConfig folder,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(folder);

        return ScanFolderAsync(
            folder.FolderPath,
            folder.IncludePatterns,
            folder.ExcludePatterns,
            folder.IncludeSubfolders,
            ct);
    }

    public async Task<IReadOnlyList<FileInfo>> ScanFolderAsync(
        string folderPath,
        IReadOnlyCollection<string>? includePatterns,
        IReadOnlyCollection<string>? excludePatterns,
        bool includeSubfolders,
        CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(folderPath);
        ct.ThrowIfCancellationRequested();

        if (!await IsFolderAccessibleAsync(folderPath))
            return Array.Empty<FileInfo>();

        var include = NormalizePatterns(includePatterns);
        var exclude = NormalizePatterns(excludePatterns);

        var options = new EnumerationOptions
        {
            RecurseSubdirectories = includeSubfolders,
            IgnoreInaccessible = true,
            ReturnSpecialDirectories = false,
            AttributesToSkip = DefaultEnumerationOptions.AttributesToSkip
        };

        try
        {
            return Directory
                .EnumerateFiles(folderPath, "*", options)
                .Where(path => IsMatch(Path.GetFileName(path), include, exclude))
                .Select(path => new FileInfo(path))
                .OrderBy(file => file.FullName, StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // A folder can disappear or become unreadable between the accessibility
            // check and enumeration. Returning an empty result keeps a scan safe.
            return Array.Empty<FileInfo>();
        }
    }

    public async Task<string> ComputeFileHashAsync(
        string filePath,
        CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(filePath);

        await using var stream = new FileStream(
            filePath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 64 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan);

        var hash = await SHA256.HashDataAsync(stream, ct);
        return Convert.ToHexStringLower(hash);
    }

    public Task<bool> IsFolderAccessibleAsync(string folderPath)
    {
        if (string.IsNullOrWhiteSpace(folderPath))
            return Task.FromResult(false);

        try
        {
            if (!Directory.Exists(folderPath))
                return Task.FromResult(false);

            // Directory.Exists can succeed while enumeration still fails. Probe
            // one entry so permission-denied folders are reported accurately.
            using var enumerator = Directory.EnumerateFileSystemEntries(folderPath).GetEnumerator();
            enumerator.MoveNext();
            return Task.FromResult(true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return Task.FromResult(false);
        }
    }

    private static List<string> NormalizePatterns(IReadOnlyCollection<string>? patterns)
    {
        if (patterns is null || patterns.Count == 0)
            return new List<string>();

        return patterns
            .Where(pattern => !string.IsNullOrWhiteSpace(pattern))
            .Select(pattern => pattern.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static bool IsMatch(
        string fileName,
        IReadOnlyCollection<string> includePatterns,
        IReadOnlyCollection<string> excludePatterns)
    {
        if (includePatterns.Count > 0
            && !includePatterns.Any(pattern => Matches(pattern, fileName)))
        {
            return false;
        }

        return !excludePatterns.Any(pattern => Matches(pattern, fileName));
    }

    private static bool Matches(string pattern, string fileName)
    {
        return FileSystemName.MatchesSimpleExpression(
            pattern,
            fileName,
            ignoreCase: true);
    }
}
