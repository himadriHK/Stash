using StashHost.Shared.Messages;

namespace StashHost.Functions.Activities;

/// <summary>
/// Common contract for file converters (images and videos).
/// </summary>
public interface IConverter
{
    bool Supports(string extension);
    Task<string> ConvertAsync(string inputPath, CancellationToken ct);
}

/// <summary>
/// Interface for image converters.
/// </summary>
public interface IImageConverter : IConverter
{
}

/// <summary>
/// Interface for video converters.
/// </summary>
public interface IVideoConverter : IConverter
{
}

/// <summary>
/// Interface for thumbnail generation.
/// </summary>
public interface IThumbnailGenerator
{
    Task<Stream> GenerateAsync(string filePath, int size, CancellationToken ct);
}

/// <summary>
/// Interface for creating image and video converters based on file extension.
/// </summary>
public interface IConverterFactory
{
    /// <summary>
    /// Resolves the first converter (image or video) that supports the given extension.
    /// </summary>
    IConverter? GetConverter(string extension);

    IImageConverter? GetImageConverter(string extension);
    IVideoConverter? GetVideoConverter(string extension);
}
