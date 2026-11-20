using ImageMagick;
using StashHost.Shared.Messages;

namespace StashHost.Functions.Activities;

/// <summary>
/// Thumbnail generator using Magick.NET/ImageMagick.
/// The image is oriented, scaled to cover the requested square, and center-cropped.
/// This preserves the source aspect ratio instead of stretching it to a square.
///
/// For videos the first frame is extracted with FFmpeg first, because ImageMagick cannot
/// decode video containers.
/// </summary>
public class ThumbnailGenerator : IThumbnailGenerator
{
    private readonly VideoFrameExtractor _frameExtractor;

    public ThumbnailGenerator(VideoFrameExtractor? frameExtractor = null)
    {
        _frameExtractor = frameExtractor ?? new VideoFrameExtractor();
    }

    public async Task<Stream> GenerateAsync(string filePath, int size, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(filePath))
            throw new ArgumentException("File path is required.", nameof(filePath));
        if (size <= 0)
            throw new ArgumentOutOfRangeException(nameof(size), "Thumbnail size must be positive.");

        ct.ThrowIfCancellationRequested();

        string? extractedFramePath = null;
        try
        {
            if (VideoFrameExtractor.Supports(filePath))
                extractedFramePath = await _frameExtractor.ExtractFirstFrameAsync(filePath, ct);

            return await GenerateFromImageAsync(extractedFramePath ?? filePath, size, ct);
        }
        finally
        {
            // The frame is a scratch file next to the video; the video itself must survive.
            if (extractedFramePath is not null && File.Exists(extractedFramePath))
                File.Delete(extractedFramePath);
        }
    }

    private static async Task<Stream> GenerateFromImageAsync(string filePath, int size, CancellationToken ct)
    {
        using var image = new MagickImage(filePath);
        image.AutoOrient();

        // FillArea scales to the smallest dimension that covers the square; Crop then
        // removes the excess instead of distorting the image.
        image.Resize(new MagickGeometry((uint)size, (uint)size) { FillArea = true });
        image.Crop((uint)size, (uint)size, Gravity.Center);
        image.ResetPage();

        image.Format = MagickFormat.Jpeg;
        image.Quality = 90;

        var outputStream = new MemoryStream();
        try
        {
            await image.WriteAsync(outputStream, MagickFormat.Jpeg, ct);
            outputStream.Position = 0;
            return outputStream;
        }
        catch
        {
            await outputStream.DisposeAsync();
            throw;
        }
    }
}
