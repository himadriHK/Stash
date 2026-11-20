using System.Security.Cryptography;
using System.Text;

namespace StashHost.Shared.Services;

/// <summary>
/// Maps logical Stash paths to unique root-level Mega.io file names.
///
/// MegaConnectivity.Core currently operates on the account root only. Encoding the full
/// logical path into the physical name prevents distinct logical files (notably the
/// 128/256/512 thumbnails) from overwriting each other.
/// </summary>
public static class MegaPathMapper
{
    private const int MaxBaseNameLength = 180;

    /// <summary>
    /// Returns the root-level file name used for a logical remote path.
    /// A single-segment path is returned unchanged for backward compatibility.
    /// </summary>
    public static string GetPhysicalFileName(string remotePath)
    {
        if (string.IsNullOrWhiteSpace(remotePath))
            throw new ArgumentException("Remote path cannot be empty.", nameof(remotePath));

        var normalized = remotePath.Replace('\\', '/');
        var segments = normalized.Split('/', StringSplitOptions.RemoveEmptyEntries);

        if (segments.Length == 0)
            throw new ArgumentException("Remote path must contain a file name.", nameof(remotePath));

        if (segments.Any(segment => segment is "." or ".."))
            throw new ArgumentException("Remote path cannot contain '.' or '..' segments.", nameof(remotePath));

        var leaf = Sanitize(segments[^1]);
        if (string.IsNullOrWhiteSpace(leaf))
            throw new ArgumentException("Remote path has an invalid file name.", nameof(remotePath));

        if (segments.Length == 1)
            return leaf;

        var extension = Path.GetExtension(leaf);
        var leafWithoutExtension = Path.GetFileNameWithoutExtension(leaf);
        var prefix = string.Join("_", segments[..^1].Select(Sanitize));
        var baseName = string.IsNullOrEmpty(prefix)
            ? leafWithoutExtension
            : $"{prefix}_{leafWithoutExtension}";

        if (baseName.Length > MaxBaseNameLength)
            baseName = baseName[..MaxBaseNameLength];

        var suffix = GetPathSuffix(string.Join("/", segments));
        return $"{baseName}_{suffix}{extension}";
    }

    private static string Sanitize(string segment)
    {
        var builder = new StringBuilder(segment.Length);
        foreach (var ch in segment)
        {
            builder.Append(char.IsLetterOrDigit(ch) || ch is '.' or '-' or '_' ? ch : '_');
        }

        return builder.ToString();
    }

    private static string GetPathSuffix(string normalizedPath)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(normalizedPath));
        return Convert.ToHexString(hash)[..8].ToLowerInvariant();
    }
}
