namespace Stash.Maui.Services;

/// <summary>
/// Result of uploading one file to temporary storage.
/// </summary>
public sealed record UploadResult(
    Guid FileId,
    bool Success,
    string? MegaTempPath,
    string? ErrorMessage)
{
    public static UploadResult Succeeded(Guid fileId, string megaTempPath)
    {
        return new UploadResult(fileId, true, megaTempPath, null);
    }

    public static UploadResult Failed(Guid fileId, string? megaTempPath, string errorMessage)
    {
        return new UploadResult(fileId, false, megaTempPath, errorMessage);
    }
}

/// <summary>
/// Result of a batched upload run.
/// </summary>
public sealed record UploadBatchResult(
    IReadOnlyList<UploadResult> Results,
    int BatchSize,
    int BatchCount)
{
    public int TotalCount => Results.Count;

    public int SuccessCount => Results.Count(result => result.Success);

    public int FailureCount => TotalCount - SuccessCount;

    public bool AllSucceeded => FailureCount == 0;
}
