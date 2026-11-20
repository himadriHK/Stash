using System.ComponentModel;
using System.Diagnostics;

namespace StashHost.Functions.Activities;

/// <summary>
/// Extracts a still frame from the start of a video file using the FFmpeg CLI, so video
/// uploads can produce thumbnails. The executable is resolved from STASH_FFMPEG_PATH,
/// FFMPEG_PATH, or PATH, matching <see cref="VideoConverter"/>.
/// </summary>
public class VideoFrameExtractor
{
    private const string DefaultExecutable = "ffmpeg";
    private const string FrameExtension = ".frame.jpg";

    private static readonly string[] SupportedExtensions = { ".mp4", ".mov", ".m4v" };

    private readonly string _ffmpegPath;

    public VideoFrameExtractor(string? ffmpegPath = null)
    {
        _ffmpegPath = string.IsNullOrWhiteSpace(ffmpegPath)
            ? Environment.GetEnvironmentVariable("STASH_FFMPEG_PATH")
              ?? Environment.GetEnvironmentVariable("FFMPEG_PATH")
              ?? DefaultExecutable
            : ffmpegPath;
    }

    /// <summary>
    /// Returns true when the file extension is a video container this extractor handles.
    /// </summary>
    public static bool Supports(string? filePath) =>
        !string.IsNullOrWhiteSpace(filePath)
        && SupportedExtensions.Contains(Path.GetExtension(filePath).ToLowerInvariant());

    /// <summary>
    /// Writes the first decoded frame next to the video as a JPEG and returns its path.
    /// The caller owns the frame file and is expected to delete it.
    /// </summary>
    public async Task<string> ExtractFirstFrameAsync(string videoPath, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(videoPath))
            throw new ArgumentException("Video path is required.", nameof(videoPath));

        if (!Supports(videoPath))
            throw new NotSupportedException(
                $"Frame extraction is not supported for '{Path.GetExtension(videoPath)}'.");

        if (!File.Exists(videoPath))
            throw new FileNotFoundException("Video source file does not exist.", videoPath);

        ct.ThrowIfCancellationRequested();

        // Thumbnail sizes are generated concurrently for the same video, so each call needs
        // its own scratch frame. It sits next to the video inside the per-upload temp folder,
        // which DeleteLocalTempActivity removes even if a frame is ever left behind.
        var outputDirectory = Path.GetDirectoryName(videoPath);
        if (string.IsNullOrWhiteSpace(outputDirectory))
            outputDirectory = Path.GetTempPath();

        Directory.CreateDirectory(outputDirectory);

        var outputPath = Path.Combine(
            outputDirectory,
            $"{Path.GetFileNameWithoutExtension(videoPath)}.{Guid.NewGuid():N}{FrameExtension}");

        try
        {
            await RunFfmpegAsync(videoPath, outputPath, ct);
        }
        catch
        {
            DeleteOutput(outputPath);
            throw;
        }

        if (!File.Exists(outputPath) || new FileInfo(outputPath).Length == 0)
        {
            DeleteOutput(outputPath);
            throw new InvalidOperationException(
                $"FFmpeg did not produce a frame for '{Path.GetFileName(videoPath)}'.");
        }

        return outputPath;
    }

    private async Task RunFfmpegAsync(string videoPath, string outputPath, CancellationToken ct)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = _ffmpegPath,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        // Seek to the very start and take the first decoded frame. -q:v 2 keeps enough
        // quality for the thumbnail generator to crop from.
        foreach (var argument in new[]
                 {
                     "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                     "-ss", "0",
                     "-i", videoPath,
                     "-map", "0:v:0",
                     "-frames:v", "1",
                     "-an", "-sn",
                     "-q:v", "2",
                     "-f", "image2",
                     outputPath
                 })
        {
            startInfo.ArgumentList.Add(argument);
        }

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
                throw;
            }

            var stdout = await stdoutTask;
            var stderr = await stderrTask;

            if (process.ExitCode != 0)
            {
                var details = string.IsNullOrWhiteSpace(stderr) ? stdout : stderr;
                throw new InvalidOperationException(
                    $"FFmpeg exited with code {process.ExitCode} while extracting a frame from " +
                    $"'{Path.GetFileName(videoPath)}'. FFmpeg output: {Tail(details)}");
            }
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException)
        {
            if (ex is InvalidOperationException && ex.Message.StartsWith("FFmpeg", StringComparison.Ordinal))
                throw;

            throw new InvalidOperationException(
                $"FFmpeg could not be started from '{_ffmpegPath}'. " +
                "Install FFmpeg or set STASH_FFMPEG_PATH. " +
                $"Details: {ex.Message}", ex);
        }
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
