using System.IO;

namespace StashHost.Functions.Activities;

/// <summary>
/// Builds the canonical storage paths used by the upload pipeline.
///
/// They are logical paths: the local provider maps <c>/backups/...</c> below
/// <c>Storage:Local:RootPath</c>, while <c>/thumbs/...</c> is still written through the
/// configured (MEGA) provider.
///
/// All converted image formats are stored as JPEG and all converted video formats
/// as MP4, so deduplication and permanent storage must use the same normalized
/// extension. Using the original file name extension in only one of those places
/// makes deduplication ineffective.
/// </summary>
public static class StoragePathBuilder
{
    private static readonly HashSet<string> JpegSourceExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".jpg", ".jpeg", ".heic", ".heif", ".avif", ".webp", ".png",
        ".raw", ".cr2", ".nef", ".arw", ".dng"
    };

    private static readonly HashSet<string> Mp4SourceExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mp4", ".mov"
    };

    private static readonly HashSet<string> JpegMimeTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/jpeg", "image/jpg", "image/heic", "image/heif", "image/avif",
        "image/webp", "image/png", "image/x-canon-cr2", "image/x-nikon-nef",
        "image/x-sony-arw", "image/x-adobe-dng", "image/x-raw"
    };

    private static readonly HashSet<string> Mp4MimeTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "video/mp4", "video/quicktime"
    };

    /// <summary>
    /// Returns the extension that the permanent copy will use after conversion.
    /// </summary>
    public static string GetPermanentExtension(string fileName, string? mimeType)
    {
        var extension = Path.GetExtension(fileName ?? string.Empty);

        if (JpegSourceExtensions.Contains(extension)) return ".jpg";
        if (Mp4SourceExtensions.Contains(extension)) return ".mp4";

        if (!string.IsNullOrWhiteSpace(mimeType))
        {
            if (JpegMimeTypes.Contains(mimeType)) return ".jpg";
            if (Mp4MimeTypes.Contains(mimeType)) return ".mp4";
        }

        return extension.ToLowerInvariant();
    }

    /// <summary>
    /// Canonical permanent path: <c>/backups/{userId}/{contentHash}{extension}</c>.
    /// </summary>
    public static string GetPermanentPath(
        string userId,
        string fileHash,
        string fileName,
        string? mimeType)
    {
        if (string.IsNullOrWhiteSpace(userId))
            throw new ArgumentException("User id is required.", nameof(userId));
        if (string.IsNullOrWhiteSpace(fileHash))
            throw new ArgumentException("File hash is required.", nameof(fileHash));

        return $"/backups/{userId}/{fileHash}{GetPermanentExtension(fileName, mimeType)}";
    }

    /// <summary>
    /// Canonical thumbnail path: <c>/thumbs/{userId}/{size}/{contentHash}.jpg</c>.
    /// </summary>
    public static string GetThumbnailPath(string userId, string fileHash, int size)
    {
        if (string.IsNullOrWhiteSpace(userId))
            throw new ArgumentException("User id is required.", nameof(userId));
        if (string.IsNullOrWhiteSpace(fileHash))
            throw new ArgumentException("File hash is required.", nameof(fileHash));
        if (size <= 0)
            throw new ArgumentOutOfRangeException(nameof(size), "Thumbnail size must be positive.");

        return $"/thumbs/{userId}/{size}/{fileHash}.jpg";
    }
}
