using StashHost.Shared.Messages;
using StashHost.Shared.Validation;

namespace StashHost.Functions.Validation;

/// <summary>
/// Validates upload requests before they enter the Durable orchestration.
/// </summary>
public static class UploadRequestValidator
{
    public const long MaxFileSizeBytes = 500L * 1024 * 1024;
    public const int SupportedVersion = 1;

    /// <summary>
    /// Returns an error message, or null when the request is valid.
    /// </summary>
    public static string? Validate(UploadRequestMessage request)
    {
        ArgumentNullException.ThrowIfNull(request);

        if (request.Version != SupportedVersion)
            return $"Unsupported message version: {request.Version}. Expected {SupportedVersion}.";

        if (string.IsNullOrWhiteSpace(request.MessageId))
            return "Message id is required.";

        if (string.IsNullOrWhiteSpace(request.CorrelationId))
            return "Correlation id is required.";

        if (!FileHashValidator.IsSha256Hex(request.FileId))
            return "File id must be a 64-character SHA-256 hex string.";

        if (string.IsNullOrWhiteSpace(request.FileName))
            return "File name is required.";

        if (request.FileName is "." or ".."
            || request.FileName.Contains('/')
            || request.FileName.Contains('\\')
            || request.FileName.Any(char.IsControl))
        {
            return "File name must not contain path separators, control characters, or traversal segments.";
        }

        if (request.FileSize <= 0)
            return "File size must be greater than zero.";

        if (request.FileSize > MaxFileSizeBytes)
            return $"File size exceeds the {MaxFileSizeBytes} byte limit.";

        if (string.IsNullOrWhiteSpace(request.MimeType)
            || !request.MimeType.Contains('/')
            || request.MimeType.Any(char.IsWhiteSpace))
        {
            return "MIME type is required and must be a valid type/subtype value.";
        }

        if (string.IsNullOrWhiteSpace(request.MegaTempPath))
            return "Mega temp path is required.";

        var tempPathSegments = request.MegaTempPath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (!request.MegaTempPath.StartsWith("/temp/", StringComparison.Ordinal)
            || request.MegaTempPath.Contains('\\')
            || tempPathSegments.Any(segment => segment is "." or ".."))
        {
            return "Mega temp path must be a logical path under /temp/ without traversal segments.";
        }

        return null;
    }
}
