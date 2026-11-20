using System.Diagnostics;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using ImageMagick;
using ImageMagick.Drawing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.IdentityModel.Tokens;
using StashHost.Functions.Activities;
using StashHost.Functions.Middleware;
using StashHost.Functions.Services;
using StashHost.Functions.Validation;
using StashHost.Shared.Contracts;
using StashHost.Shared.Messages;
using StashHost.Shared.Services;
using StashHost.Shared.Validation;

namespace StashHost.Tests;

public class Phase3BackendTests
{
    private const string SigningKey = "unit-test-signing-key-that-is-at-least-32-bytes-long";
    private const string Issuer = "stash-auth";
    private const string Audience = "stash-app";

    [Fact]
    public void ActivityResult_RoundTripsStringThroughJson()
    {
        var original = ActivityResult.Success("hello");

        var json = JsonSerializer.Serialize(original);
        var roundTrip = JsonSerializer.Deserialize<ActivityResult>(json);

        Assert.NotNull(roundTrip);
        Assert.True(roundTrip.IsSuccess);
        Assert.Equal("hello", roundTrip.GetData<string>());
    }

    [Fact]
    public void ActivityResult_RoundTripsBooleanAndDictionaryThroughJson()
    {
        var booleanRoundTrip = JsonSerializer.Deserialize<ActivityResult>(
            JsonSerializer.Serialize(ActivityResult.Success(true)));
        Assert.True(booleanRoundTrip!.GetData<bool>());

        var dictionary = new Dictionary<string, string> { ["128"] = "/thumbs/u/128/hash.jpg" };
        var dictionaryRoundTrip = JsonSerializer.Deserialize<ActivityResult>(
            JsonSerializer.Serialize(ActivityResult.Success(dictionary)));

        var data = dictionaryRoundTrip!.GetData<Dictionary<string, string>>();
        Assert.NotNull(data);
        Assert.Equal("/thumbs/u/128/hash.jpg", data["128"]);
    }

    [Fact]
    public void ActivityResult_RoundTripsFailureThroughJson()
    {
        var roundTrip = JsonSerializer.Deserialize<ActivityResult>(
            JsonSerializer.Serialize(ActivityResult.Failure("boom")));

        Assert.NotNull(roundTrip);
        Assert.False(roundTrip.IsSuccess);
        Assert.Equal("boom", roundTrip.Error);
        Assert.Null(roundTrip.GetData<string>());
    }

    [Fact]
    public void JwtValidator_AcceptsValidBearerTokenFromStringHeader()
    {
        var validator = new JwtValidator(SigningKey, Issuer, Audience);
        var token = CreateToken(SigningKey);
        var headers = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase)
        {
            ["Authorization"] = $"Bearer {token}"
        };

        var principal = validator.Validate(headers);

        Assert.NotNull(principal);
        Assert.Equal("user-1", principal.FindFirst("userId")?.Value);
        Assert.Equal("device-1", principal.FindFirst("deviceId")?.Value);
    }

    [Fact]
    public void JwtValidator_AcceptsLowercaseHeaderNameAndByteArrayValue()
    {
        var validator = new JwtValidator(SigningKey, Issuer, Audience);
        var token = CreateToken(SigningKey);
        var headers = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase)
        {
            ["authorization"] = Encoding.UTF8.GetBytes($"Bearer {token}")
        };

        var principal = validator.Validate(headers);

        Assert.NotNull(principal);
        Assert.Equal("user-1", principal.FindFirst("userId")?.Value);
    }

    [Fact]
    public void JwtValidator_RejectsMissingMalformedExpiredAndWrongKeyTokens()
    {
        var validator = new JwtValidator(SigningKey, Issuer, Audience);

        Assert.Null(validator.Validate(new Dictionary<string, object>()));
        Assert.Null(validator.Validate(new Dictionary<string, object>
        {
            ["Authorization"] = "Bearer not-a-token"
        }));

        var expired = CreateToken(
            SigningKey,
            notBefore: DateTime.UtcNow.AddMinutes(-10),
            expires: DateTime.UtcNow.AddMinutes(-5));
        Assert.Null(validator.Validate(new Dictionary<string, object>
        {
            ["Authorization"] = $"Bearer {expired}"
        }));

        var otherValidator = new JwtValidator(
            "another-unit-test-signing-key-that-is-long-enough", Issuer, Audience);
        Assert.Null(otherValidator.Validate(new Dictionary<string, object>
        {
            ["Authorization"] = $"Bearer {CreateToken(SigningKey)}"
        }));
    }

    [Theory]
    [InlineData("photo.heic", "image/heic", ".jpg")]
    [InlineData("photo.avif", "image/avif", ".jpg")]
    [InlineData("photo.webp", "image/webp", ".jpg")]
    [InlineData("photo.png", "image/png", ".jpg")]
    [InlineData("photo.raw", "image/x-raw", ".jpg")]
    [InlineData("photo.cr2", "image/x-canon-cr2", ".jpg")]
    [InlineData("photo.nef", "image/x-nikon-nef", ".jpg")]
    [InlineData("photo.arw", "image/x-sony-arw", ".jpg")]
    [InlineData("photo.dng", "image/x-adobe-dng", ".jpg")]
    [InlineData("photo.jpg", "image/jpeg", ".jpg")]
    [InlineData("movie.mov", "video/quicktime", ".mp4")]
    [InlineData("movie.mp4", "video/mp4", ".mp4")]
    [InlineData("document.pdf", "application/pdf", ".pdf")]
    public void PermanentExtension_IsNormalizedForConvertedFormats(
        string fileName,
        string mimeType,
        string expected)
    {
        Assert.Equal(expected, StoragePathBuilder.GetPermanentExtension(fileName, mimeType));
    }

    [Fact]
    public void PermanentAndThumbnailPaths_UseCanonicalLayout()
    {
        Assert.Equal(
            "/backups/user-1/hash.jpg",
            StoragePathBuilder.GetPermanentPath("user-1", "hash", "photo.heic", "image/heic"));

        Assert.Equal(
            "/backups/user-1/hash.mp4",
            StoragePathBuilder.GetPermanentPath("user-1", "hash", "movie.mov", "video/quicktime"));

        Assert.Equal(
            "/thumbs/user-1/128/hash.jpg",
            StoragePathBuilder.GetThumbnailPath("user-1", "hash", 128));
    }

    [Fact]
    public void Converters_SupportExpectedFormats()
    {
        var image = new ImageConverter();
        var raw = new RawImageConverter();
        var video = new VideoConverter();

        Assert.True(image.Supports(".heic"));
        Assert.True(image.Supports(".heif"));
        Assert.True(image.Supports(".avif"));
        Assert.True(image.Supports(".webp"));
        Assert.True(image.Supports(".png"));
        Assert.False(image.Supports(".jpg"));

        Assert.True(raw.Supports(".raw"));
        Assert.True(raw.Supports(".cr2"));
        Assert.True(raw.Supports(".nef"));
        Assert.True(raw.Supports(".arw"));
        Assert.True(raw.Supports(".dng"));

        Assert.True(video.Supports(".mov"));
        Assert.False(video.Supports(".mp4"));
    }

    [Fact]
    public void ConverterFactory_ResolvesByExtension()
    {
        var factory = new ConverterFactory(
            new IImageConverter[] { new ImageConverter(), new RawImageConverter() },
            new IVideoConverter[] { new VideoConverter() });

        Assert.IsType<ImageConverter>(factory.GetConverter(".png"));
        Assert.IsType<RawImageConverter>(factory.GetConverter(".cr2"));
        Assert.IsType<VideoConverter>(factory.GetConverter(".mov"));
        Assert.Null(factory.GetConverter(".txt"));
    }

    [Fact]
    public async Task ConvertFormatActivity_PassesThroughJpeg()
    {
        var factory = new ConverterFactory(
            new IImageConverter[] { new ImageConverter(), new RawImageConverter() },
            new IVideoConverter[] { new VideoConverter() });
        var activity = new ConvertFormatActivity(factory);
        var path = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.jpg");
        await File.WriteAllBytesAsync(path, new byte[] { 0xFF, 0xD8, 0xFF, 0xD9 });

        try
        {
            var result = await activity.Run(path, NullLogger.Instance);

            Assert.True(result.IsSuccess);
            Assert.Equal(path, result.GetData<string>());
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public async Task ImageConverter_ConvertsPngToJpeg()
    {
        var input = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.png");
        var output = Path.ChangeExtension(input, ".jpg");

        try
        {
            CreateImage(input, 4, 4, MagickFormat.Png);

            var converted = await new ImageConverter().ConvertAsync(input, CancellationToken.None);

            Assert.Equal(output, converted);
            Assert.True(File.Exists(converted));
            using var loaded = new MagickImage(converted);
            Assert.Equal(4, (int)loaded.Width);
            Assert.Equal(4, (int)loaded.Height);
        }
        finally
        {
            if (File.Exists(input)) File.Delete(input);
            if (File.Exists(output)) File.Delete(output);
        }
    }

    [Theory]
    [InlineData(MagickFormat.WebP)]
    [InlineData(MagickFormat.Avif)]
    public async Task ImageConverter_ConvertsWebPAndAvifToJpeg(MagickFormat format)
    {
        var input = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.{format.ToString().ToLowerInvariant()}");
        var output = Path.ChangeExtension(input, ".jpg");

        try
        {
            CreateImage(input, 64, 32, format);

            var converted = await new ImageConverter().ConvertAsync(input, CancellationToken.None);

            Assert.Equal(output, converted);
            using var loaded = new MagickImage(converted);
            Assert.Equal(64, (int)loaded.Width);
            Assert.Equal(32, (int)loaded.Height);
        }
        finally
        {
            if (File.Exists(input)) File.Delete(input);
            if (File.Exists(output)) File.Delete(output);
        }
    }

    [Fact]
    public async Task RawImageConverter_ConvertsRealDngFixtureToJpeg()
    {
        var fixture = GetRawFixturePath();
        var input = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.dng");
        var output = Path.ChangeExtension(input, ".jpg");

        try
        {
            File.Copy(fixture, input);

            var converted = await new RawImageConverter().ConvertAsync(input, CancellationToken.None);

            Assert.Equal(output, converted);
            Assert.True(File.Exists(converted));
            Assert.True(new FileInfo(converted).Length > 10_000);

            using var loaded = new MagickImage(converted);
            Assert.Equal(MagickFormat.Jpeg, loaded.Format);
            Assert.Equal(1952, (int)loaded.Width);
            Assert.Equal(1104, (int)loaded.Height);
        }
        finally
        {
            if (File.Exists(input)) File.Delete(input);
            if (File.Exists(output)) File.Delete(output);
        }
    }

    [Fact]
    public async Task ConvertFormatActivity_ConvertsRealDngFixtureToJpeg()
    {
        var fixture = GetRawFixturePath();
        var input = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.dng");
        var output = Path.ChangeExtension(input, ".jpg");

        try
        {
            File.Copy(fixture, input);
            var factory = new ConverterFactory(
                new IImageConverter[] { new ImageConverter(), new RawImageConverter() },
                Array.Empty<IVideoConverter>());

            var result = await new ConvertFormatActivity(factory).Run(input, NullLogger.Instance);

            Assert.True(result.IsSuccess, result.Error);
            var converted = result.GetData<string>();
            Assert.Equal(output, converted);
            Assert.True(File.Exists(converted));
            Assert.True(new FileInfo(converted).Length > 10_000);

            using var loaded = new MagickImage(converted);
            Assert.Equal(MagickFormat.Jpeg, loaded.Format);
            Assert.Equal(1952, (int)loaded.Width);
            Assert.Equal(1104, (int)loaded.Height);
        }
        finally
        {
            if (File.Exists(input)) File.Delete(input);
            if (File.Exists(output)) File.Delete(output);
        }
    }

    [Fact]
    public async Task RawImageConverter_InvalidDngLeavesNoJpeg()
    {
        var input = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.dng");
        var output = Path.ChangeExtension(input, ".jpg");
        await File.WriteAllBytesAsync(input, new byte[] { 1, 2, 3, 4, 5, 6, 7, 8 });

        try
        {
            await Assert.ThrowsAnyAsync<Exception>(
                () => new RawImageConverter().ConvertAsync(input, CancellationToken.None));

            Assert.False(File.Exists(output));
        }
        finally
        {
            if (File.Exists(input)) File.Delete(input);
            if (File.Exists(output)) File.Delete(output);
        }
    }

    [Fact]
    public void MagickImageLibrary_ReportsRequiredDecoders()
    {
        var required = new[] { "HEIC", "AVIF", "CR2", "NEF", "ARW", "DNG", "RAW" };

        foreach (var name in required)
        {
            var info = MagickNET.SupportedFormats.FirstOrDefault(
                f => f.Format.ToString().Equals(name, StringComparison.OrdinalIgnoreCase));

            Assert.NotNull(info);
            Assert.True(info!.SupportsReading, $"{name} must be readable by the bundled Magick.NET build.");
        }
    }

    [Fact]
    public void FileHashValidator_AcceptsOnlySha256AndComparesCaseInsensitively()
    {
        const string lower = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

        Assert.True(FileHashValidator.IsSha256Hex(lower));
        Assert.True(FileHashValidator.IsSha256Hex(lower.ToUpperInvariant()));
        Assert.False(FileHashValidator.IsSha256Hex("not-a-hash"));
        Assert.False(FileHashValidator.IsSha256Hex(lower + "0"));

        Assert.True(FileHashValidator.Matches(lower.ToUpperInvariant(), lower));
        Assert.False(FileHashValidator.Matches(lower, new string('0', 64)));
    }

    [Fact]
    public async Task FileHashValidator_ComputesKnownSha256()
    {
        await using var stream = new MemoryStream("hello"u8.ToArray());

        var hash = await FileHashValidator.ComputeSha256Async(stream);

        Assert.Equal(
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            hash);
    }

    [Fact]
    public async Task ComputeHashActivity_ComputesKnownSha256()
    {
        var path = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.bin");
        await File.WriteAllTextAsync(path, "hello");

        try
        {
            var result = await new ComputeHashActivity().Run(path, NullLogger.Instance);

            Assert.True(result.IsSuccess);
            Assert.Equal(
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
                result.GetData<string>());
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public async Task CheckDeduplicationActivity_UsesNormalizedPermanentPath()
    {
        var factory = new CapturingStorageProviderFactory();
        var activity = new CheckDeduplicationActivity(factory);

        var result = await activity.Run(new ProcessingContext
        {
            UserId = "user-1",
            FileHash = "hash",
            FileName = "photo.heic",
            MimeType = "image/heic"
        }, NullLogger.Instance);

        Assert.True(result.IsSuccess);
        Assert.False(result.GetData<bool>());
        Assert.Equal("/backups/user-1/hash.jpg", factory.Provider.ExistsPath);
    }

    [Fact]
    public async Task CheckDeduplicationActivity_ReturnsTrueWhenPermanentFileExists()
    {
        var factory = new CapturingStorageProviderFactory();
        factory.Provider.ExistsResult = true;
        var activity = new CheckDeduplicationActivity(factory);

        var result = await activity.Run(new ProcessingContext
        {
            UserId = "user-1",
            FileHash = "hash",
            FileName = "photo.heic",
            MimeType = "image/heic"
        }, NullLogger.Instance);

        Assert.True(result.IsSuccess);
        Assert.True(result.GetData<bool>());
    }

    [Fact]
    public async Task DownloadFileActivity_AcceptsMatchingSize()
    {
        var factory = new CapturingStorageProviderFactory();
        var content = new byte[] { 1, 2, 3, 4 };
        factory.Provider.DownloadContent = content;
        var fileName = $"{Guid.NewGuid():N}.jpg";
        string? localPath = null;

        try
        {
            var result = await new DownloadFileActivity(factory).RunCore(new ProcessingContext
            {
                FileId = "file-id",
                FileName = fileName,
                FileSize = content.Length,
                MegaTempPath = "/temp/uploads/device/photo.jpg"
            }, NullLogger.Instance);

            Assert.True(result.IsSuccess);
            localPath = result.GetData<string>();
            Assert.NotNull(localPath);
            Assert.True(File.Exists(localPath));
            Assert.Equal(content, await File.ReadAllBytesAsync(localPath));
            Assert.Equal(fileName, Path.GetFileName(localPath));
        }
        finally
        {
            if (localPath is not null)
            {
                var directory = Path.GetDirectoryName(localPath);
                if (directory is not null && Directory.Exists(directory))
                    Directory.Delete(directory, recursive: true);
            }
        }
    }

    [Theory]
    [InlineData(3, 5L)]
    [InlineData(5, 3L)]
    public async Task DownloadFileActivity_RejectsMismatchedSizeAndCleansUp(int actualLength, long declaredLength)
    {
        var factory = new CapturingStorageProviderFactory();
        factory.Provider.DownloadContent = Enumerable.Range(0, actualLength)
            .Select(value => (byte)value)
            .ToArray();
        var fileName = $"{Guid.NewGuid():N}.jpg";

        var result = await new DownloadFileActivity(factory).RunCore(new ProcessingContext
        {
            FileId = "file-id",
            FileName = fileName,
            FileSize = declaredLength,
            MegaTempPath = "/temp/uploads/device/photo.jpg"
        }, NullLogger.Instance);

        Assert.False(result.IsSuccess);
        Assert.Contains(actualLength.ToString(), result.Error!);
        Assert.Contains(declaredLength.ToString(), result.Error!);
        Assert.Empty(FindStashTempFiles(fileName));
    }

    [Fact]
    public async Task ThumbnailGenerator_ProducesSquareThumbnailWithoutDistortingAspectRatio()
    {
        var input = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.png");

        try
        {
            // A centered 200x200 red square on a 600x300 green canvas. A correct
            // cover/crop thumbnail keeps the red region square; a stretch does not.
            using (var image = new MagickImage(MagickColors.Green, 600, 300))
            {
                new Drawables()
                    .FillColor(MagickColors.Red)
                    .Rectangle(200, 50, 400, 250)
                    .Draw(image);
                image.Write(input, MagickFormat.Png);
            }

            await using var thumbnail = await new ThumbnailGenerator()
                .GenerateAsync(input, 128, CancellationToken.None);
            using var loaded = new MagickImage(thumbnail);

            Assert.Equal(128, (int)loaded.Width);
            Assert.Equal(128, (int)loaded.Height);

            var pixels = loaded.ToByteArray(MagickFormat.Rgba);
            var minX = int.MaxValue;
            var minY = int.MaxValue;
            var maxX = int.MinValue;
            var maxY = int.MinValue;

            for (var y = 0; y < loaded.Height; y++)
            {
                for (var x = 0; x < loaded.Width; x++)
                {
                    var index = ((int)y * (int)loaded.Width + x) * 4;
                    var red = pixels[index];
                    var green = pixels[index + 1];
                    var blue = pixels[index + 2];

                    if (red > 200 && green < 80 && blue < 80)
                    {
                        minX = Math.Min(minX, x);
                        minY = Math.Min(minY, y);
                        maxX = Math.Max(maxX, x);
                        maxY = Math.Max(maxY, y);
                    }
                }
            }

            Assert.True(maxX >= minX && maxY >= minY, "The red square was not found in the thumbnail.");
            var redWidth = maxX - minX + 1;
            var redHeight = maxY - minY + 1;
            Assert.InRange(Math.Abs(redWidth - redHeight), 0, 2);
        }
        finally
        {
            if (File.Exists(input)) File.Delete(input);
        }
    }

    [Fact]
    public async Task StorePermanentActivity_UsesNormalizedPermanentPath()
    {
        var factory = new CapturingStorageProviderFactory();
        var activity = new StorePermanentActivity(factory);
        var source = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.jpg");
        await File.WriteAllBytesAsync(source, new byte[] { 0xFF, 0xD8, 0xFF, 0xD9 });

        try
        {
            var result = await activity.Run(new ProcessingContext
            {
                UserId = "user-1",
                FileHash = "hash",
                FileName = "photo.heic",
                MimeType = "image/heic",
                ConvertedFilePath = source
            }, NullLogger.Instance);

            Assert.True(result.IsSuccess);
            Assert.Equal("/backups/user-1/hash.jpg", factory.Provider.UploadPath);
        }
        finally
        {
            File.Delete(source);
        }
    }

    [Fact]
    public async Task GenerateThumbnailActivity_UsesCanonicalThumbnailPath()
    {
        var factory = new CapturingStorageProviderFactory();
        var activity = new GenerateThumbnailActivity(new FakeThumbnailGenerator(), factory);

        var result = await activity.Run(new ThumbnailRequest
        {
            FilePath = "ignored.jpg",
            FileId = "hash",
            UserId = "user-1",
            Size = 128
        }, NullLogger.Instance);

        Assert.True(result.IsSuccess);
        Assert.Equal("/thumbs/user-1/128/hash.jpg", factory.Provider.UploadPath);
    }

    [Fact]
    public void KafkaJson_UsesCamelCaseAndReadsPascalCasePayloads()
    {
        var message = new UploadResponseMessage
        {
            FileId = "hash",
            Status = "COMPLETED",
            CorrelationId = "correlation"
        };

        var json = KafkaJson.Serialize(message);

        Assert.Contains("\"fileId\":\"hash\"", json);
        Assert.Contains("\"correlationId\":\"correlation\"", json);
        Assert.DoesNotContain("\"FileId\"", json);

        var parsed = KafkaJson.Deserialize<UploadResponseMessage>(
            """{"FileId":"hash","Status":"COMPLETED","CorrelationId":"correlation"}""");

        Assert.NotNull(parsed);
        Assert.Equal("hash", parsed!.FileId);
        Assert.Equal("COMPLETED", parsed.Status);
        Assert.Equal("correlation", parsed.CorrelationId);
    }

    [Fact]
    public void UploadRequestValidator_AcceptsAValidRequest()
    {
        Assert.Null(UploadRequestValidator.Validate(CreateValidRequest()));
    }

    [Theory]
    [InlineData("fileName", "../escape.jpg")]
    [InlineData("fileName", "folder/photo.jpg")]
    [InlineData("fileId", "not-a-sha256")]
    [InlineData("mimeType", "not-a-mime")]
    [InlineData("megaTempPath", "/backups/user/file.jpg")]
    [InlineData("megaTempPath", "/temp/../file.jpg")]
    [InlineData("version", "2")]
    public void UploadRequestValidator_RejectsInvalidFields(string field, string value)
    {
        var request = CreateValidRequest();

        switch (field)
        {
            case "fileName": request.FileName = value; break;
            case "fileId": request.FileId = value; break;
            case "mimeType": request.MimeType = value; break;
            case "megaTempPath": request.MegaTempPath = value; break;
            case "version": request.Version = int.Parse(value); break;
            default: throw new InvalidOperationException(field);
        }

        Assert.NotNull(UploadRequestValidator.Validate(request));
    }

    [Fact]
    public void UploadRequestValidator_AllowsDoubleDotsInsideAFileName()
    {
        var request = CreateValidRequest();
        request.FileName = "photo..heic";
        request.MegaTempPath = "/temp/uploads/device-1/photo..heic";

        Assert.Null(UploadRequestValidator.Validate(request));
    }

    [Fact]
    public void UploadRequestValidator_RejectsInvalidSizes()
    {
        var zero = CreateValidRequest();
        zero.FileSize = 0;
        Assert.NotNull(UploadRequestValidator.Validate(zero));

        var tooLarge = CreateValidRequest();
        tooLarge.FileSize = UploadRequestValidator.MaxFileSizeBytes + 1;
        Assert.NotNull(UploadRequestValidator.Validate(tooLarge));
    }

    [Fact]
    public async Task DeleteLocalTempActivity_DeletesThePerFileDirectory()
    {
        var directory = Path.Combine(Path.GetTempPath(), "stash", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var file = Path.Combine(directory, "photo.jpg");
        await File.WriteAllTextAsync(file, "test");

        try
        {
            var result = await new DeleteLocalTempActivity().Run(file, NullLogger.Instance);

            Assert.True(result.IsSuccess);
            Assert.False(Directory.Exists(directory));
        }
        finally
        {
            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task DeleteLocalTempActivity_RefusesPathsOutsideTheStashTempRoot()
    {
        var directory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var file = Path.Combine(directory, "photo.jpg");
        await File.WriteAllTextAsync(file, "test");

        try
        {
            var result = await new DeleteLocalTempActivity().Run(file, NullLogger.Instance);

            Assert.False(result.IsSuccess);
            Assert.True(File.Exists(file));
        }
        finally
        {
            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task StorageProviderFactory_ReusesTheMegaProviderAndRejectsUnknownProviders()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Storage:Provider"] = "Mega",
                ["Storage:Mega:Email"] = "test@example.com",
                ["Storage:Mega:Password"] = "password"
            })
            .Build();

        await using var factory = new StorageProviderFactory(configuration, NullLoggerFactory.Instance);

        var first = factory.Create();
        var second = factory.Create();

        Assert.Same(first, second);
        Assert.Throws<NotSupportedException>(() => factory.Create("Unknown"));
    }

    [Fact]
    public void MegaPathMapper_EncodesLogicalPathsIntoSeparateRootNames()
    {
        var thumb128 = MegaPathMapper.GetPhysicalFileName("/thumbs/user-1/128/hash.jpg");
        var thumb256 = MegaPathMapper.GetPhysicalFileName("/thumbs/user-1/256/hash.jpg");
        var backup = MegaPathMapper.GetPhysicalFileName("/backups/user-1/hash.jpg");

        Assert.NotEqual(thumb128, thumb256);
        Assert.NotEqual(thumb128, backup);
        Assert.StartsWith("thumbs_user-1_128_hash_", thumb128);
        Assert.EndsWith(".jpg", thumb128);
        Assert.Equal(thumb128, MegaPathMapper.GetPhysicalFileName("/thumbs/user-1/128/hash.jpg"));
        Assert.Throws<ArgumentException>(() =>
            MegaPathMapper.GetPhysicalFileName("/temp/../hash.jpg"));
    }

    [Fact]
    public async Task VideoConverter_ConvertsMovToMp4()
    {
        var ffmpeg = FindFfmpegExecutable();
        if (ffmpeg is null)
            return;

        var input = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.mov");
        var output = Path.ChangeExtension(input, ".mp4");

        try
        {
            await CreateTestMovAsync(ffmpeg, input);

            var converted = await new VideoConverter(ffmpeg).ConvertAsync(input, CancellationToken.None);

            Assert.Equal(output, converted);
            Assert.True(File.Exists(converted));
            Assert.True(new FileInfo(converted).Length > 0);

            var (exitCode, standardError) = await RunProcessAsync(
                ffmpeg,
                new[] { "-v", "error", "-i", converted, "-f", "null", "-" });
            Assert.True(exitCode == 0, standardError);
        }
        finally
        {
            if (File.Exists(input)) File.Delete(input);
            if (File.Exists(output)) File.Delete(output);
        }
    }

    [Fact]
    public async Task VideoConverter_SupportsMpeg4CodecOverride()
    {
        var ffmpeg = FindFfmpegExecutable();
        if (ffmpeg is null)
            return;

        var input = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.mov");
        var output = Path.ChangeExtension(input, ".mp4");

        try
        {
            await CreateTestMovAsync(ffmpeg, input);

            var converted = await new VideoConverter(ffmpeg, "mpeg4")
                .ConvertAsync(input, CancellationToken.None);

            Assert.Equal(output, converted);
            Assert.True(File.Exists(converted));
            Assert.True(new FileInfo(converted).Length > 0);
        }
        finally
        {
            if (File.Exists(input)) File.Delete(input);
            if (File.Exists(output)) File.Delete(output);
        }
    }

    [Fact]
    public async Task ConvertFormatActivity_TranscodesMovToMp4()
    {
        var ffmpeg = FindFfmpegExecutable();
        if (ffmpeg is null)
            return;

        var input = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.mov");
        var output = Path.ChangeExtension(input, ".mp4");

        try
        {
            await CreateTestMovAsync(ffmpeg, input);

            var factory = new ConverterFactory(
                new IImageConverter[] { new ImageConverter(), new RawImageConverter() },
                new IVideoConverter[] { new VideoConverter(ffmpeg) });
            var result = await new ConvertFormatActivity(factory).Run(input, NullLogger.Instance);

            Assert.True(result.IsSuccess);
            Assert.Equal(output, result.GetData<string>());
            Assert.True(File.Exists(output));
            Assert.True(new FileInfo(output).Length > 0);
        }
        finally
        {
            if (File.Exists(input)) File.Delete(input);
            if (File.Exists(output)) File.Delete(output);
        }
    }

    [Fact]
    public async Task VideoConverter_ReportsMissingFfmpeg()
    {
        var input = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.mov");
        await File.WriteAllBytesAsync(input, new byte[] { 1, 2, 3 });

        var missingExecutable = Path.Combine(
            Path.GetTempPath(),
            Guid.NewGuid().ToString("N"),
            OperatingSystem.IsWindows() ? "ffmpeg.exe" : "ffmpeg");

        try
        {
            var exception = await Assert.ThrowsAsync<InvalidOperationException>(
                () => new VideoConverter(missingExecutable).ConvertAsync(input, CancellationToken.None));

            Assert.Contains("FFmpeg could not be started", exception.Message);
        }
        finally
        {
            File.Delete(input);
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

    private static async Task CreateTestMovAsync(string ffmpeg, string outputPath)
    {
        var (exitCode, standardError) = await RunProcessAsync(
            ffmpeg,
            new[]
            {
                "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=10",
                "-c:v", "mpeg4", "-q:v", "5", outputPath
            });

        if (exitCode != 0)
            throw new InvalidOperationException($"Could not create the MOV test fixture: {standardError}");
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

    private static string GetRawFixturePath()
    {
        var path = Path.Combine(
            AppContext.BaseDirectory,
            "Fixtures",
            "Raw",
            "blackmagic_micro_cinema_12bit.dng");

        Assert.True(File.Exists(path), $"RAW fixture was not copied to the test output: {path}");
        return path;
    }

    private static string[] FindStashTempFiles(string fileName)
    {
        var root = Path.Combine(Path.GetTempPath(), "stash");
        return Directory.Exists(root)
            ? Directory.GetFiles(root, fileName, SearchOption.AllDirectories)
            : Array.Empty<string>();
    }

    private static UploadRequestMessage CreateValidRequest() => new()
    {
        MessageId = "message-1",
        CorrelationId = "correlation-1",
        FileId = new string('a', 64),
        FileName = "photo.heic",
        FileSize = 128,
        MimeType = "image/heic",
        MegaTempPath = "/temp/uploads/device-1/photo.heic",
        Version = 1
    };

    private static void CreateImage(string path, int width, int height, MagickFormat format)
    {
        using var image = new MagickImage(MagickColors.Red, (uint)width, (uint)height);
        image.Format = format;
        image.Write(path);
    }

    private static string CreateToken(
        string signingKey,
        DateTime? notBefore = null,
        DateTime? expires = null)
    {
        var credentials = new SigningCredentials(
            new SymmetricSecurityKey(Encoding.UTF8.GetBytes(signingKey)),
            SecurityAlgorithms.HmacSha256);

        var token = new JwtSecurityToken(
            issuer: Issuer,
            audience: Audience,
            claims: new[]
            {
                new Claim("userId", "user-1"),
                new Claim("deviceId", "device-1")
            },
            notBefore: notBefore ?? DateTime.UtcNow.AddMinutes(-1),
            expires: expires ?? DateTime.UtcNow.AddMinutes(5),
            signingCredentials: credentials);

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private sealed class FakeThumbnailGenerator : IThumbnailGenerator
    {
        public Task<Stream> GenerateAsync(string filePath, int size, CancellationToken ct) =>
            Task.FromResult<Stream>(new MemoryStream(new byte[] { 1, 2, 3 }));
    }

    private sealed class CapturingStorageProviderFactory : IStorageProviderFactory
    {
        public CapturingStorageProvider Provider { get; } = new();

        public IStorageProvider Create() => Provider;

        public IStorageProvider Create(string providerType) => Provider;
    }

    private sealed class CapturingStorageProvider : IStorageProvider
    {
        public string? ExistsPath { get; private set; }
        public string? UploadPath { get; private set; }
        public bool ExistsResult { get; set; }
        public byte[] DownloadContent { get; set; } = Array.Empty<byte>();

        public Task<string> UploadFileAsync(Stream fileStream, string remotePath, CancellationToken ct)
        {
            UploadPath = remotePath;
            return Task.FromResult(remotePath);
        }

        public Task<bool> DeleteFileAsync(string remotePath, CancellationToken ct) =>
            Task.FromResult(true);

        public Task<Stream> DownloadFileAsync(string remotePath, CancellationToken ct) =>
            Task.FromResult<Stream>(new MemoryStream(DownloadContent));

        public Task<bool> FileExistsAsync(string remotePath, CancellationToken ct)
        {
            ExistsPath = remotePath;
            return Task.FromResult(ExistsResult);
        }

        public Task<long> GetFileSizeAsync(string remotePath, CancellationToken ct) =>
            Task.FromResult(0L);
    }
}
