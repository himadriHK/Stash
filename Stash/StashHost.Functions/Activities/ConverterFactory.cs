using System.ComponentModel;
using System.Diagnostics;
using ImageMagick;
using StashHost.Shared.Messages;

namespace StashHost.Functions.Activities;

/// <summary>
/// Image converter using Magick.NET/ImageMagick for HEIC, HEIF, AVIF, WEBP, and PNG to JPEG
/// conversion. Magick.NET is Apache-2.0 licensed and does not require the ImageSharp
/// commercial/community license.
/// </summary>
public class ImageConverter : IImageConverter
{
    public bool Supports(string extension) => extension.ToLowerInvariant() switch
    {
        ".heic" or ".heif" or ".avif" or ".webp" or ".png" => true,
        _ => false
    };

    public Task<string> ConvertAsync(string inputPath, CancellationToken ct) =>
        MagickImageConverter.ConvertToJpegAsync(inputPath, ct);
}

/// <summary>
/// RAW image converter for camera RAW formats (.raw, .cr2, .nef, .arw, .dng).
/// </summary>
public class RawImageConverter : IImageConverter
{
    public bool Supports(string extension) => extension.ToLowerInvariant() switch
    {
        ".raw" or ".cr2" or ".nef" or ".arw" or ".dng" => true,
        _ => false
    };

    public Task<string> ConvertAsync(string inputPath, CancellationToken ct) =>
        MagickImageConverter.ConvertToJpegAsync(inputPath, ct);
}

/// <summary>
/// Shared Magick.NET conversion path for image and RAW converters.
/// </summary>
internal static class MagickImageConverter
{
    public static async Task<string> ConvertToJpegAsync(string inputPath, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(inputPath))
            throw new ArgumentException("Input path is required.", nameof(inputPath));

        ct.ThrowIfCancellationRequested();

        var outputPath = Path.ChangeExtension(inputPath, ".jpg");

        try
        {
            using var image = new MagickImage(inputPath);
            image.AutoOrient();
            image.Format = MagickFormat.Jpeg;
            image.Quality = 90;

            await image.WriteAsync(outputPath, MagickFormat.Jpeg, ct);
            return outputPath;
        }
        catch
        {
            // Do not leave a partially written JPEG behind when decoding/encoding fails.
            if (File.Exists(outputPath))
                File.Delete(outputPath);

            throw;
        }
    }
}

/// <summary>
/// Video converter for MOV → MP4 conversion using the FFmpeg CLI.
/// The executable is resolved from STASH_FFMPEG_PATH, FFMPEG_PATH, or PATH.
/// </summary>
public class VideoConverter : IVideoConverter
{
    private const string DefaultExecutable = "ffmpeg";
    private const string DefaultVideoCodec = "libx264";
    private readonly string _ffmpegPath;
    private readonly string _videoCodec;

    public VideoConverter(string? ffmpegPath = null, string? videoCodec = null)
    {
        _ffmpegPath = string.IsNullOrWhiteSpace(ffmpegPath)
            ? Environment.GetEnvironmentVariable("STASH_FFMPEG_PATH")
              ?? Environment.GetEnvironmentVariable("FFMPEG_PATH")
              ?? DefaultExecutable
            : ffmpegPath;

        _videoCodec = string.IsNullOrWhiteSpace(videoCodec)
            ? Environment.GetEnvironmentVariable("STASH_FFMPEG_VIDEO_CODEC")
              ?? DefaultVideoCodec
            : videoCodec;
    }

    public bool Supports(string extension) => extension.ToLowerInvariant() == ".mov";

    public async Task<string> ConvertAsync(string inputPath, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(inputPath))
            throw new ArgumentException("Input path is required.", nameof(inputPath));

        if (!Supports(Path.GetExtension(inputPath)))
            throw new NotSupportedException($"Only MOV input is supported, got '{Path.GetExtension(inputPath)}'.");

        if (!File.Exists(inputPath))
            throw new FileNotFoundException("Video source file does not exist.", inputPath);

        ct.ThrowIfCancellationRequested();

        var outputPath = Path.ChangeExtension(inputPath, ".mp4");
        var outputDirectory = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrWhiteSpace(outputDirectory))
            Directory.CreateDirectory(outputDirectory);

        if (File.Exists(outputPath))
            File.Delete(outputPath);

        var startInfo = new ProcessStartInfo
        {
            FileName = _ffmpegPath,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        foreach (var argument in BuildArguments(inputPath, outputPath))
            startInfo.ArgumentList.Add(argument);

        try
        {
            using var process = new Process { StartInfo = startInfo };
            if (!process.Start())
                throw new InvalidOperationException("FFmpeg process did not start.");

            var stdoutTask = process.StandardOutput.ReadToEndAsync();
            var stderrTask = process.StandardError.ReadToEndAsync();

            try
            {
                await process.WaitForExitAsync(ct);
            }
            catch (OperationCanceledException)
            {
                KillProcess(process);
                DeleteOutput(outputPath);
                throw;
            }

            var stdout = await stdoutTask;
            var stderr = await stderrTask;

            if (process.ExitCode != 0)
            {
                DeleteOutput(outputPath);
                var details = string.IsNullOrWhiteSpace(stderr) ? stdout : stderr;
                throw new InvalidOperationException(
                    $"FFmpeg exited with code {process.ExitCode} while transcoding '{Path.GetFileName(inputPath)}'. " +
                    $"FFmpeg output: {Tail(details)}");
            }

            if (!File.Exists(outputPath) || new FileInfo(outputPath).Length == 0)
            {
                DeleteOutput(outputPath);
                throw new InvalidOperationException(
                    "FFmpeg reported success but did not produce a non-empty MP4 file.");
            }

            return outputPath;
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException)
        {
            DeleteOutput(outputPath);

            if (ex is InvalidOperationException && ex.Message.StartsWith("FFmpeg", StringComparison.Ordinal))
                throw;

            throw new InvalidOperationException(
                $"FFmpeg could not be started from '{_ffmpegPath}'. " +
                "Install FFmpeg or set STASH_FFMPEG_PATH. " +
                $"Details: {ex.Message}", ex);
        }
    }

    private IEnumerable<string> BuildArguments(string inputPath, string outputPath)
    {
        yield return "-hide_banner";
        yield return "-loglevel";
        yield return "error";
        yield return "-nostdin";
        yield return "-y";
        yield return "-i";
        yield return inputPath;
        yield return "-map";
        yield return "0:v:0";
        yield return "-map";
        yield return "0:a?";
        yield return "-c:v";
        yield return _videoCodec;

        if (string.Equals(_videoCodec, "libx264", StringComparison.OrdinalIgnoreCase))
        {
            yield return "-preset";
            yield return "fast";
            yield return "-crf";
            yield return "23";
        }
        else
        {
            // A generic quality setting for non-x264 encoders such as mpeg4.
            yield return "-q:v";
            yield return "5";
        }

        yield return "-pix_fmt";
        yield return "yuv420p";
        yield return "-c:a";
        yield return "aac";
        yield return "-b:a";
        yield return "128k";
        yield return "-movflags";
        yield return "+faststart";
        yield return "-f";
        yield return "mp4";
        yield return outputPath;
    }

    private static void KillProcess(Process process)
    {
        try
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
        }
        catch
        {
            // The process may have exited between the check and Kill.
        }
    }

    private static void DeleteOutput(string outputPath)
    {
        if (File.Exists(outputPath))
            File.Delete(outputPath);
    }

    private static string Tail(string value)
    {
        const int maxLength = 4000;
        if (string.IsNullOrWhiteSpace(value))
            return "(no FFmpeg error output)";

        return value.Length <= maxLength ? value.Trim() : value[^maxLength..].Trim();
    }
}

/// <summary>
/// Factory for creating image and video converters based on file extension.
/// </summary>
public class ConverterFactory : IConverterFactory
{
    private readonly IEnumerable<IImageConverter> _imageConverters;
    private readonly IEnumerable<IVideoConverter> _videoConverters;

    public ConverterFactory(IEnumerable<IImageConverter> imageConverters, IEnumerable<IVideoConverter> videoConverters)
    {
        _imageConverters = imageConverters;
        _videoConverters = videoConverters;
    }

    public IImageConverter? GetImageConverter(string extension) =>
        _imageConverters.FirstOrDefault(c => c.Supports(extension));

    public IVideoConverter? GetVideoConverter(string extension) =>
        _videoConverters.FirstOrDefault(c => c.Supports(extension));

    public IConverter? GetConverter(string extension)
    {
        var imageConverter = _imageConverters.FirstOrDefault(c => c.Supports(extension));
        if (imageConverter is not null) return imageConverter;
        return _videoConverters.FirstOrDefault(c => c.Supports(extension));
    }
}
