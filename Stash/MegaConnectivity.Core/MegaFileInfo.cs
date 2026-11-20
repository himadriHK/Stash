namespace MegaConnectivity.Core;

/// <summary>
/// Information about a file or directory stored in Mega.io.
/// </summary>
public sealed class MegaFileInfo
{
    /// <summary>File/display name.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>Mega.io node identifier.</summary>
    public string NodeId { get; set; } = string.Empty;

    /// <summary>Size in bytes.</summary>
    public long Size { get; set; }

    /// <summary>Node type (0 = file, 1 = directory).</summary>
    public int Type { get; set; }

    /// <summary>True when this entry is a directory.</summary>
    public bool Directory { get; set; }
}
