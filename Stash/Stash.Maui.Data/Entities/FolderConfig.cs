namespace Stash.Maui.Data.Entities;

/// <summary>
/// A user-configured folder that the scanner should watch.
/// </summary>
public sealed class FolderConfig
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public string FolderPath { get; set; } = string.Empty;

    public string FolderName { get; set; } = string.Empty;

    public bool IsEnabled { get; set; } = true;

    public DateTime AddedAt { get; set; } = DateTime.UtcNow;

    public DateTime? LastScannedAt { get; set; }

    public List<string> IncludePatterns { get; set; } = MediaFilePatterns.CreateDefaultIncludePatterns();

    public List<string> ExcludePatterns { get; set; } = new();

    public bool IncludeSubfolders { get; set; } = true;
}
