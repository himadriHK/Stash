using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using ImageMagick;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using StashHost.Functions;
using StashHost.Functions.Activities;
using StashHost.Shared.Contracts;
using StashHost.Shared.Messages;

namespace StashHost.Tests;

/// <summary>
/// Tests for the StashHost.Functions activity pipeline that run against real media
/// checked into <c>Fixtures/Media</c>: a portrait JPEG photograph, an RGBA PNG, a WebP
/// derivative of the photograph, and a Big Buck Bunny H.264 clip in MP4 and QuickTime
/// (MOV) containers. See <c>Fixtures/Media/README.md</c> for sources and licences.
///
/// Unlike the synthetic 1x1/4x4 images in Phase3BackendTests, these files exercise the
/// real decoder/encoder, orientation and centre-crop behaviour, container remuxing and
/// byte-for-byte storage of a genuine photo.
/// </summary>
public class FunctionAppMediaTests
{
    private const string UserId = "user-1";
    private const string DeviceId = "device-1";
    private const string Jpeg = "cat_1280.jpg";
    private const string Png = "transparent_checkerboard.png";
    private const string Webp = "cat_1280.webp";
    private const string Mp4 = "big_buck_bunny_360p_10s.mp4";
    private const string Mov = "big_buck_bunny_360p_clip.mov";

    /// <summary>
    /// Fixture name, SHA-256 and length exactly as recorded in Fixtures/Media/README.md.
    /// A mismatch means the binary was truncated or replaced without updating the docs.
    /// </summary>
    private static readonly (string Name, string Sha256, long Length)[] DocumentedFixtures =
    {
        (Jpeg, "23eff170b96a0cade67f883208772b3a5cec7091c6728a33ef2acd90b869bb9f", 546_059),
        (Png, "c4e870d358d64ce677e958c156d0e3fba466993d8e915fc81c5dc64937a9b696", 224_566),
        (Webp, "8b832967e894052ec3ad1a2f532d07b563bd4b1af3025ece3ad6ef8bb2998211", 375_200),
        (Mp4, "77145c94c11f3754207499158df22406e1fe7635553c1c86dc5e881dfeb32016", 991_017),
        (Mov, "3ff6c9eb0c511cd21fbca2da7e9ad5e1c45345e0713b6c81a696185af70cc2fc", 479_842)
    };

    [Fact]
    public async Task MediaFixtures_MatchDocumentedHashesAndSizes()
    {
        foreach (var (name, sha256, length) in DocumentedFixtures)
        {
            var path = FixturePath(name);

            Assert.Equal(length, new FileInfo(path).Length);
            Assert.Equal(sha256, await Sha256HexAsync(path));
        }
    }

    [Fact]
    public async Task DownloadFileActivity_DownloadsRealJpegFromMegaTempAndHashMatches()
    {
        var bytes = await File.ReadAllBytesAsync(FixturePath(Jpeg));
        var storage = new InMemoryStorage();
        storage.Seed($"/temp/uploads/{DeviceId}/{Jpeg}", bytes);
        var factory = new SingleProviderFactory(storage);
        var context = CreateContext(Jpeg, "image/jpeg", bytes.Length);

        var download = await new DownloadFileActivity(factory).RunCore(context, NullLogger.Instance);

        Assert.True(download.IsSuccess, download.Error);
        var localPath = download.GetData<string>();
        Assert.NotNull(localPath);
        Assert.Equal(Jpeg, Path.GetFileName(localPath));
        Assert.StartsWith(
            Path.Combine(Path.GetTempPath(), "stash"),
            Path.GetFullPath(localPath),
            StringComparison.OrdinalIgnoreCase);

        try
        {
            var downloaded = await File.ReadAllBytesAsync(localPath);
            Assert.Equal(bytes, downloaded);

            var hash = await new ComputeHashActivity().Run(localPath, NullLogger.Instance);

            Assert.True(hash.IsSuccess, hash.Error);
            Assert.Equal(DocumentedFixtures[0].Sha256, hash.GetData<string>());
        }
        finally
        {
            DeleteLocalTempDirectory(localPath);
        }
    }

    [Fact]
    public async Task ConvertFormatActivity_ConvertsRealRgbaPngToJpeg()
    {
        var localPath = CopyFixtureToTemp(Png);

        try
        {
            using (var source = new MagickImage(localPath))
            {
                Assert.Equal(MagickFormat.Png, source.Format);
                Assert.Equal(800, (int)source.Width);
                Assert.Equal(600, (int)source.Height);
                Assert.True(source.HasAlpha, "The PNG fixture must carry an alpha channel.");
            }

            var result = await CreateConvertFormatActivity().Run(localPath, NullLogger.Instance);

            Assert.True(result.IsSuccess, result.Error);
            var converted = result.GetData<string>();
            Assert.Equal(Path.ChangeExtension(localPath, ".jpg"), converted);
            Assert.True(File.Exists(converted));

            using var image = new MagickImage(converted);
            Assert.Equal(MagickFormat.Jpeg, image.Format);
            Assert.Equal(800, (int)image.Width);
            Assert.Equal(600, (int)image.Height);
            Assert.False(image.HasAlpha);
            Assert.True(new FileInfo(converted).Length > 20_000);
        }
        finally
        {
            DeleteDirectoryOf(localPath);
        }
    }

    [Fact]
    public async Task ConvertFormatActivity_ConvertsRealWebpPhotoToJpeg()
    {
        var localPath = CopyFixtureToTemp(Webp);

        try
        {
            using (var source = new MagickImage(localPath))
            {
                Assert.Equal(MagickFormat.WebP, source.Format);
                Assert.Equal(1280, (int)source.Width);
                Assert.Equal(1709, (int)source.Height);
            }

            var result = await CreateConvertFormatActivity().Run(localPath, NullLogger.Instance);

            Assert.True(result.IsSuccess, result.Error);
            var converted = result.GetData<string>();
            Assert.True(File.Exists(converted));

            using var image = new MagickImage(converted);
            Assert.Equal(MagickFormat.Jpeg, image.Format);
            Assert.Equal(1280, (int)image.Width);
            Assert.Equal(1709, (int)image.Height);
        }
        finally
        {
            DeleteDirectoryOf(localPath);
        }
    }

    [Fact]
    public async Task ConvertFormatActivity_PassesRealJpegThroughUnchanged()
    {
        var localPath = CopyFixtureToTemp(Jpeg);
        var before = await File.ReadAllBytesAsync(localPath);

        try
        {
            var result = await CreateConvertFormatActivity().Run(localPath, NullLogger.Instance);

            Assert.True(result.IsSuccess, result.Error);
            Assert.Equal(localPath, result.GetData<string>());
            Assert.Equal(before, await File.ReadAllBytesAsync(localPath));
        }
        finally
        {
            DeleteDirectoryOf(localPath);
        }
    }

    [Theory]
    [InlineData(128)]
    [InlineData(256)]
    [InlineData(512)]
    public async Task ThumbnailGenerator_ProducesSquareThumbnailFromRealPortraitPhoto(int size)
    {
        var stream = await new ThumbnailGenerator().GenerateAsync(
            FixturePath(Jpeg),
            size,
            CancellationToken.None);

        Assert.IsType<MemoryStream>(stream);
        Assert.True(stream.Length > 2_000, $"Thumbnail {size} looks empty ({stream.Length} bytes).");

        using var image = new MagickImage(stream);
        Assert.Equal(MagickFormat.Jpeg, image.Format);
        Assert.Equal(size, (int)image.Width);
        Assert.Equal(size, (int)image.Height);
    }

    [Fact]
    public async Task GenerateThumbnailActivity_UploadsRealThumbnailsToCanonicalPaths()
    {
        var storage = new InMemoryStorage();
        var factory = new SingleProviderFactory(storage);
        var hash = DocumentedFixtures[0].Sha256;
        var activity = new GenerateThumbnailActivity(new ThumbnailGenerator(), factory);
        var localPath = CopyFixtureToTemp(Jpeg);

        try
        {
            foreach (var size in new[] { 128, 256, 512 })
            {
                var result = await activity.Run(
                    new ThumbnailRequest { FilePath = localPath, Size = size, FileId = hash, UserId = UserId },
                    NullLogger.Instance);

                Assert.True(result.IsSuccess, result.Error);
                var thumbnails = result.GetData<Dictionary<string, string>>();
                Assert.NotNull(thumbnails);
                Assert.Equal($"/thumbs/{UserId}/{size}/{hash}.jpg", thumbnails[size.ToString()]);
            }

            Assert.Equal(3, storage.Paths.Count);
            foreach (var size in new[] { 128, 256, 512 })
            {
                var thumbPath = $"/thumbs/{UserId}/{size}/{hash}.jpg";
                using var image = new MagickImage(storage.Read(thumbPath));
                Assert.Equal(MagickFormat.Jpeg, image.Format);
                Assert.Equal(size, (int)image.Width);
                Assert.Equal(size, (int)image.Height);
            }
        }
        finally
        {
            DeleteDirectoryOf(localPath);
        }
    }

    [Fact]
    public async Task StorePermanentActivity_StoresRealJpegBytesAtHashBackedPath()
    {
        var storage = new InMemoryStorage();
        var factory = new SingleProviderFactory(storage);
        var localPath = CopyFixtureToTemp(Jpeg);
        var bytes = await File.ReadAllBytesAsync(localPath);
        var context = CreateContext(Jpeg, "image/jpeg", bytes.Length);
        context.ConvertedFilePath = localPath;
        context.FileHash = DocumentedFixtures[0].Sha256;

        try
        {
            var result = await new StorePermanentActivity(factory).Run(context, NullLogger.Instance);

            Assert.True(result.IsSuccess, result.Error);
            var expectedPath = $"/backups/{UserId}/{DocumentedFixtures[0].Sha256}.jpg";
            Assert.Equal(expectedPath, result.GetData<string>());
            Assert.Equal(bytes, storage.Read(expectedPath));
        }
        finally
        {
            DeleteDirectoryOf(localPath);
        }
    }

    [Fact]
    public async Task StorePermanentActivity_RequiresConvertedFileOnDisk()
    {
        var storage = new InMemoryStorage();
        var context = CreateContext(Jpeg, "image/jpeg", 1);
        context.ConvertedFilePath = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.jpg");
        context.FileHash = DocumentedFixtures[0].Sha256;

        var result = await new StorePermanentActivity(new SingleProviderFactory(storage))
            .Run(context, NullLogger.Instance);

        Assert.False(result.IsSuccess);
        Assert.Equal("Converted file does not exist.", result.Error);
        Assert.Empty(storage.Paths);
    }

    /// <summary>
    /// The full image path of FileProcessingOrchestration (download → hash → dedup →
    /// convert → thumbnails → store permanent → delete temp) driven by the real activity
    /// classes and a photo that really came off the web.
    /// </summary>
    [Fact]
    public async Task ImagePipeline_RealPhoto_ProducesPermanentCopyAndThumbnails()
    {
        var run = await RunPipelineAsync(Jpeg, "image/jpeg", generateThumbnails: true);
        var hash = DocumentedFixtures[0].Sha256;

        try
        {
            Assert.Equal(hash, run.Context.FileHash);
            Assert.Equal(hash, run.Context.FileId);
            Assert.Equal($"/backups/{UserId}/{hash}.jpg", run.Context.PermanentPath);
            Assert.Equal("image/jpeg", run.Context.ConvertedFormat);

            var permanent = run.Storage.Read($"/backups/{UserId}/{hash}.jpg");
            Assert.Equal(await File.ReadAllBytesAsync(FixturePath(Jpeg)), permanent);

            Assert.Equal(3, run.Context.Thumbnails.Count);
            Assert.Equal(
                new[] { "128", "256", "512" },
                run.Context.Thumbnails.Keys.OrderBy(size => int.Parse(size)));

            foreach (var (size, thumbPath) in run.Context.Thumbnails)
            {
                Assert.Equal($"/thumbs/{UserId}/{size}/{hash}.jpg", thumbPath);
                using var thumb = new MagickImage(run.Storage.Read(thumbPath));
                Assert.Equal(int.Parse(size), (int)thumb.Width);
                Assert.Equal(int.Parse(size), (int)thumb.Height);
            }

            // The Mega temp object must be gone, and a re-run of the same photo deduplicates.
            Assert.DoesNotContain(run.Context.MegaTempPath, run.Storage.Paths);

            var dedup = await new CheckDeduplicationActivity(run.Factory)
                .Run(run.Context, NullLogger.Instance);
            Assert.True(dedup.GetData<bool>());
        }
        finally
        {
            DeleteLocalTempDirectory(run.Context.LocalFilePath);
        }
    }

    [Fact]
    public async Task VideoPipeline_RealQuickTimeClip_TranscodesToMp4AndGeneratesThumbnails()
    {
        if (FindFfmpegExecutable() is null)
            return;

        var run = await RunPipelineAsync(Mov, "video/quicktime", generateThumbnails: true);
        var hash = DocumentedFixtures[4].Sha256;

        try
        {
            Assert.Equal(hash, run.Context.FileHash);
            Assert.Equal(".mp4", Path.GetExtension(run.Context.ConvertedFilePath!));
            Assert.Equal($"/backups/{UserId}/{hash}.mp4", run.Context.PermanentPath);
            Assert.Equal("video/mp4", run.Context.ConvertedFormat);

            var permanent = run.Storage.Read($"/backups/{UserId}/{hash}.mp4");
            Assert.True(permanent.Length > 10_000);
            Assert.Equal("ftyp", Encoding.ASCII.GetString(permanent, 4, 4));
            Assert.DoesNotContain(run.Context.MegaTempPath, run.Storage.Paths);

            await AssertDecodableAsync(permanent);

            // A video upload now yields the same three square JPEG thumbnails as a photo.
            Assert.Equal(3, run.Context.Thumbnails.Count);
            foreach (var (size, thumbPath) in run.Context.Thumbnails)
            {
                Assert.Equal($"/thumbs/{UserId}/{size}/{hash}.jpg", thumbPath);
                using var thumb = new MagickImage(run.Storage.Read(thumbPath));
                Assert.Equal(MagickFormat.Jpeg, thumb.Format);
                Assert.Equal(int.Parse(size), (int)thumb.Width);
                Assert.Equal(int.Parse(size), (int)thumb.Height);
                AssertImageHasDetail(thumb);
            }

            // Extracted frames are scratch files: none may survive next to the video.
            var localDirectory = Path.GetDirectoryName(run.Context.LocalFilePath)!;
            Assert.Empty(Directory.GetFiles(localDirectory, "*.frame.jpg"));
        }
        finally
        {
            DeleteLocalTempDirectory(run.Context.LocalFilePath);
        }
    }

    [Theory]
    [InlineData(Mp4)]
    [InlineData(Mov)]
    public async Task VideoFrameExtractor_ExtractsFirstFrameFromRealVideo(string fixtureName)
    {
        if (FindFfmpegExecutable() is null)
            return;

        var videoPath = CopyFixtureToTemp(fixtureName);
        var extractor = new VideoFrameExtractor();

        try
        {
            Assert.True(VideoFrameExtractor.Supports(videoPath));

            var framePath = await extractor.ExtractFirstFrameAsync(videoPath, CancellationToken.None);

            Assert.Equal(Path.GetDirectoryName(videoPath), Path.GetDirectoryName(framePath));
            Assert.EndsWith(".frame.jpg", framePath);
            Assert.StartsWith(
                Path.GetFileNameWithoutExtension(videoPath),
                Path.GetFileName(framePath),
                StringComparison.Ordinal);
            Assert.True(File.Exists(framePath));
            Assert.True(new FileInfo(framePath).Length > 5_000);

            using var frame = new MagickImage(framePath);
            Assert.Equal(MagickFormat.Jpeg, frame.Format);
            Assert.Equal(640, (int)frame.Width);
            Assert.Equal(360, (int)frame.Height);
            AssertImageHasDetail(frame);

            // The video itself must be left untouched.
            Assert.True(File.Exists(videoPath));
            Assert.Equal(DocumentedFixtures.Single(f => f.Name == fixtureName).Length, new FileInfo(videoPath).Length);
        }
        finally
        {
            DeleteDirectoryOf(videoPath);
        }
    }

    [Fact]
    public async Task VideoFrameExtractor_RejectsNonVideoInput()
    {
        var imagePath = CopyFixtureToTemp(Jpeg);

        try
        {
            Assert.False(VideoFrameExtractor.Supports(imagePath));
            Assert.False(VideoFrameExtractor.Supports(null));

            await Assert.ThrowsAsync<NotSupportedException>(() =>
                new VideoFrameExtractor().ExtractFirstFrameAsync(imagePath, CancellationToken.None));

            Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(imagePath)!, "*.frame.jpg"));
        }
        finally
        {
            DeleteDirectoryOf(imagePath);
        }
    }

    [Fact]
    public async Task FunctionAppServices_ResolveAVideoCapableThumbnailGenerator()
    {
        if (FindFfmpegExecutable() is null)
            return;

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddStorageInfrastructure(new ConfigurationBuilder().Build());

        await using var provider = services.BuildServiceProvider();
        var generator = provider.GetRequiredService<IThumbnailGenerator>();

        using var thumbnail = new MagickImage(
            await generator.GenerateAsync(FixturePath(Mp4), 256, CancellationToken.None));

        Assert.Equal(MagickFormat.Jpeg, thumbnail.Format);
        Assert.Equal(256, (int)thumbnail.Width);
        Assert.Equal(256, (int)thumbnail.Height);
    }

    [Theory]
    [InlineData(128)]
    [InlineData(512)]
    public async Task ThumbnailGenerator_GeneratesThumbnailsFromRealVideo(int size)
    {
        if (FindFfmpegExecutable() is null)
            return;

        var stream = await new ThumbnailGenerator().GenerateAsync(
            FixturePath(Mp4), size, CancellationToken.None);

        using var image = new MagickImage(stream);
        Assert.Equal(MagickFormat.Jpeg, image.Format);
        Assert.Equal(size, (int)image.Width);
        Assert.Equal(size, (int)image.Height);
        AssertImageHasDetail(image);
    }

    /// <summary>
    /// Rejects thumbnails that are a single flat colour (for example an all-black frame),
    /// which would silently be "valid" JPEGs of the wrong content.
    /// </summary>
    private static void AssertImageHasDetail(MagickImage image)
    {
        var pixels = image.GetPixels().ToByteArray(PixelMapping.RGB);
        Assert.NotNull(pixels);

        var distinctValues = pixels!.Distinct().Count();
        Assert.True(distinctValues > 32, $"Thumbnail appears to be flat ({distinctValues} distinct byte values).");
    }

    private static async Task<PipelineRun> RunPipelineAsync(
        string fixtureName,
        string mimeType,
        bool generateThumbnails)
    {
        var bytes = await File.ReadAllBytesAsync(FixturePath(fixtureName));
        var storage = new InMemoryStorage();
        var context = CreateContext(fixtureName, mimeType, bytes.Length);
        storage.Seed(context.MegaTempPath, bytes);
        var factory = new SingleProviderFactory(storage);

        var download = await new DownloadFileActivity(factory).RunCore(context, NullLogger.Instance);
        Assert.True(download.IsSuccess, download.Error);
        context.LocalFilePath = download.GetData<string>();
        Assert.NotNull(context.LocalFilePath);

        var hash = await new ComputeHashActivity().Run(context.LocalFilePath, NullLogger.Instance);
        Assert.True(hash.IsSuccess, hash.Error);
        context.FileHash = hash.GetData<string>();
        Assert.NotNull(context.FileHash);
        context.FileId = context.FileHash;

        var dedup = await new CheckDeduplicationActivity(factory).Run(context, NullLogger.Instance);
        Assert.True(dedup.IsSuccess, dedup.Error);
        Assert.False(dedup.GetData<bool>());

        var convert = await CreateConvertFormatActivity().Run(context.LocalFilePath, NullLogger.Instance);
        Assert.True(convert.IsSuccess, convert.Error);
        context.ConvertedFilePath = convert.GetData<string>();
        Assert.NotNull(context.ConvertedFilePath);
        context.ConvertedFormat = mimeType == "video/quicktime" ? "video/mp4" : "image/jpeg";

        if (generateThumbnails)
        {
            var thumbnailActivity = new GenerateThumbnailActivity(new ThumbnailGenerator(), factory);
            foreach (var size in new[] { 128, 256, 512 })
            {
                var result = await thumbnailActivity.Run(
                    new ThumbnailRequest
                    {
                        FilePath = context.ConvertedFilePath,
                        Size = size,
                        FileId = context.FileHash,
                        UserId = UserId
                    },
                    NullLogger.Instance);

                Assert.True(result.IsSuccess, result.Error);
                foreach (var (key, value) in result.GetData<Dictionary<string, string>>()!)
                    context.Thumbnails[key] = value;
            }
        }

        var store = await new StorePermanentActivity(factory).Run(context, NullLogger.Instance);
        Assert.True(store.IsSuccess, store.Error);
        context.PermanentPath = store.GetData<string>();

        var deleteTemp = await new DeleteTempFileActivity(factory).Run(context.MegaTempPath, NullLogger.Instance);
        Assert.True(deleteTemp.IsSuccess, deleteTemp.Error);

        return new PipelineRun(storage, factory, context);
    }

    private static ConvertFormatActivity CreateConvertFormatActivity() =>
        new(new ConverterFactory(
            new IImageConverter[] { new ImageConverter(), new RawImageConverter() },
            new IVideoConverter[] { new VideoConverter() }));

    private static ProcessingContext CreateContext(string fileName, string mimeType, long size) => new()
    {
        MessageId = "message-1",
        FileId = string.Empty,
        FileName = fileName,
        FileSize = size,
        MimeType = mimeType,
        MegaTempPath = $"/temp/uploads/{DeviceId}/{fileName}",
        UserId = UserId,
        DeviceId = DeviceId,
        CorrelationId = "correlation-1",
        StartTime = DateTime.UtcNow
    };

    private static string FixturePath(string name)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Fixtures", "Media", name);
        Assert.True(File.Exists(path), $"Media fixture was not copied to the test output: {path}");
        return path;
    }

    private static string CopyFixtureToTemp(string name)
    {
        var directory = Path.Combine(Path.GetTempPath(), "stash-media-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, name);
        File.Copy(FixturePath(name), path);
        return path;
    }

    private static void DeleteDirectoryOf(string filePath)
    {
        var directory = Path.GetDirectoryName(filePath);
        if (directory is not null && Directory.Exists(directory))
            Directory.Delete(directory, recursive: true);
    }

    private static void DeleteLocalTempDirectory(string? localFilePath)
    {
        if (string.IsNullOrWhiteSpace(localFilePath))
            return;

        var directory = Path.GetDirectoryName(localFilePath);
        var stashRoot = Path.Combine(Path.GetTempPath(), "stash");
        if (directory is not null
            && !string.Equals(directory, stashRoot, StringComparison.OrdinalIgnoreCase)
            && Directory.Exists(directory))
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static async Task<string> Sha256HexAsync(string path)
    {
        await using var stream = File.OpenRead(path);
        var hash = await SHA256.HashDataAsync(stream);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static async Task AssertDecodableAsync(byte[] mp4)
    {
        var ffmpeg = FindFfmpegExecutable();
        Assert.NotNull(ffmpeg);

        var path = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.mp4");
        await File.WriteAllBytesAsync(path, mp4);

        try
        {
            var (exitCode, standardError) = await RunProcessAsync(
                ffmpeg,
                new[] { "-v", "error", "-i", path, "-f", "null", "-" });

            Assert.True(exitCode == 0, standardError);
        }
        finally
        {
            File.Delete(path);
        }
    }

    private static string? FindFfmpegExecutable()
    {
        var configuredCandidates = new[]
        {
            Environment.GetEnvironmentVariable("STASH_FFMPEG_PATH"),
            Environment.GetEnvironmentVariable("FFMPEG_PATH")
        };

        foreach (var candidate in configuredCandidates)
        {
            if (!string.IsNullOrWhiteSpace(candidate) && File.Exists(candidate))
                return candidate;
        }

        var pathVariable = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrWhiteSpace(pathVariable))
            return null;

        var executableNames = OperatingSystem.IsWindows()
            ? new[] { "ffmpeg.exe", "ffmpeg" }
            : new[] { "ffmpeg" };

        foreach (var directory in pathVariable.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var trimmedDirectory = directory.Trim().Trim('"');
            foreach (var executableName in executableNames)
            {
                var candidate = Path.Combine(trimmedDirectory, executableName);
                if (File.Exists(candidate))
                    return candidate;
            }
        }

        return null;
    }

    private static async Task<(int ExitCode, string StandardError)> RunProcessAsync(
        string executable,
        IEnumerable<string> arguments)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        foreach (var argument in arguments)
            startInfo.ArgumentList.Add(argument);

        using var process = new Process { StartInfo = startInfo };
        process.Start();
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        await stdoutTask;
        return (process.ExitCode, await stderrTask);
    }

    private sealed record PipelineRun(
        InMemoryStorage Storage,
        SingleProviderFactory Factory,
        ProcessingContext Context);

    private sealed class SingleProviderFactory : IStorageProviderFactory
    {
        public SingleProviderFactory(IStorageProvider provider) => Provider = provider;

        public IStorageProvider Provider { get; }

        public IStorageProvider Create() => Provider;

        public IStorageProvider Create(string providerType) => Provider;
    }

    /// <summary>
    /// Stands in for Mega.io: keeps uploaded bytes in memory so tests can assert the exact
    /// content the backend would have written to remote storage.
    /// </summary>
    private sealed class InMemoryStorage : IStorageProvider
    {
        private readonly object _gate = new();
        private readonly Dictionary<string, byte[]> _files = new(StringComparer.Ordinal);

        public IReadOnlyList<string> Paths
        {
            get
            {
                lock (_gate)
                    return _files.Keys.ToArray();
            }
        }

        public void Seed(string remotePath, byte[] content)
        {
            lock (_gate)
                _files[remotePath] = content;
        }

        public byte[] Read(string remotePath)
        {
            lock (_gate)
            {
                Assert.True(_files.ContainsKey(remotePath), $"Nothing was stored at '{remotePath}'.");
                return _files[remotePath];
            }
        }

        public async Task<string> UploadFileAsync(Stream fileStream, string remotePath, CancellationToken ct)
        {
            using var buffer = new MemoryStream();
            await fileStream.CopyToAsync(buffer, ct);

            lock (_gate)
                _files[remotePath] = buffer.ToArray();

            return remotePath;
        }

        public Task<bool> DeleteFileAsync(string remotePath, CancellationToken ct)
        {
            lock (_gate)
                return Task.FromResult(_files.Remove(remotePath));
        }

        public Task<Stream> DownloadFileAsync(string remotePath, CancellationToken ct)
        {
            lock (_gate)
            {
                if (!_files.TryGetValue(remotePath, out var content))
                    throw new FileNotFoundException($"No remote file at '{remotePath}'.", remotePath);

                return Task.FromResult<Stream>(new MemoryStream(content, writable: false));
            }
        }

        public Task<bool> FileExistsAsync(string remotePath, CancellationToken ct)
        {
            lock (_gate)
                return Task.FromResult(_files.ContainsKey(remotePath));
        }

        public Task<long> GetFileSizeAsync(string remotePath, CancellationToken ct)
        {
            lock (_gate)
                return Task.FromResult(_files.TryGetValue(remotePath, out var content) ? content.LongLength : 0L);
        }
    }
}
