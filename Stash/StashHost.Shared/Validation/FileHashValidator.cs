using System.Security.Cryptography;

namespace StashHost.Shared.Validation;

/// <summary>
/// Validation helpers for the client-supplied SHA-256 file identifier.
/// </summary>
public static class FileHashValidator
{
    private const int Sha256HexLength = 64;

    /// <summary>
    /// Returns true when the value is exactly 64 hexadecimal characters.
    /// </summary>
    public static bool IsSha256Hex(string? value) =>
        !string.IsNullOrWhiteSpace(value)
        && value.Length == Sha256HexLength
        && value.All(IsHex);

    /// <summary>
    /// Compares the client-supplied hash with the hash computed from the downloaded bytes.
    /// The comparison is case-insensitive because SHA-256 hex casing is not significant.
    /// </summary>
    public static bool Matches(string? suppliedHash, string? computedHash) =>
        IsSha256Hex(suppliedHash)
        && IsSha256Hex(computedHash)
        && string.Equals(suppliedHash, computedHash, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Computes a lowercase SHA-256 hexadecimal hash for a stream.
    /// </summary>
    public static async Task<string> ComputeSha256Async(Stream stream, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(stream);

        var hash = await SHA256.HashDataAsync(stream, ct);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    /// <summary>
    /// Computes a lowercase SHA-256 hexadecimal hash for a file.
    /// </summary>
    public static async Task<string> ComputeSha256Async(string filePath, CancellationToken ct = default)
    {
        await using var stream = File.OpenRead(filePath);
        return await ComputeSha256Async(stream, ct);
    }

    private static bool IsHex(char value) =>
        value is >= '0' and <= '9'
        or >= 'a' and <= 'f'
        or >= 'A' and <= 'F';
}
