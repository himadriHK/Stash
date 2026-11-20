namespace Stash.Maui.Data;

/// <summary>
/// File patterns the mobile app treats as backed-up media. The scanner uses the
/// same defaults as a newly created <see cref="Entities.FolderConfig"/>.
/// </summary>
public static class MediaFilePatterns
{
    public static IReadOnlyList<string> DefaultIncludePatterns { get; } = new[]
    {
        "*.jpg",
        "*.jpeg",
        "*.png",
        "*.heic",
        "*.heif",
        "*.raw",
        "*.dng",
        "*.cr2",
        "*.nef",
        "*.arw",
        "*.mov",
        "*.mp4",
        "*.avif",
        "*.webp"
    };

    public static List<string> CreateDefaultIncludePatterns()
    {
        return new List<string>(DefaultIncludePatterns);
    }
}
