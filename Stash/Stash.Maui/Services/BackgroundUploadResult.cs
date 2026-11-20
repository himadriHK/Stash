namespace Stash.Maui.Services;

/// <summary>
/// Outcome of one background upload pass.
/// </summary>
public sealed record BackgroundUploadResult(
    bool Success,
    bool AlreadyRunning,
    bool Canceled,
    int Scanned,
    int Discovered,
    int Uploaded,
    int Queued,
    int Failed,
    string? ErrorMessage)
{
    public static BackgroundUploadResult AlreadyRunningResult() =>
        new(true, true, false, 0, 0, 0, 0, 0, null);

    public static BackgroundUploadResult Completed(
        int scanned,
        int discovered,
        int uploaded,
        int queued,
        int failed) =>
        new(true, false, false, scanned, discovered, uploaded, queued, failed, null);

    public static BackgroundUploadResult CanceledResult(
        int scanned,
        int discovered,
        int uploaded,
        int queued,
        int failed) =>
        new(true, false, true, scanned, discovered, uploaded, queued, failed, "Background upload canceled.");

    public static BackgroundUploadResult Failure(string errorMessage) =>
        new(false, false, false, 0, 0, 0, 0, 0, errorMessage);
}
