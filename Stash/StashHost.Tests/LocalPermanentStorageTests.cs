using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using StashHost.Functions.Activities;
using StashHost.Shared.Contracts;
using StashHost.Shared.Messages;
using StashHost.Shared.Services;

namespace StashHost.Tests;

/// <summary>
/// Tests for permanent storage on the host's own disk: the filesystem-backed provider and the
/// activities that write to it. The local library root is an ordinary directory path, so the
/// same code covers local drives, mounted volumes, Storage Spaces and network shares.
/// </summary>
public class LocalPermanentStorageTests
{
    private const string CatHash = "23eff170b96a0cade67f883208772b3a5cec7091c6728a33ef2acd90b869bb9f";
    private const string UserId = "user-1";

    [Fact]
    public async Task LocalStorageProvider_RoundTripsFilesUnderTheRoot()
    {
        using var library = new TemporaryLibrary();
        var provider = new LocalStorageProvider(library.Path);
        var bytes = new byte[] { 0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4 };
        const string logicalPath = "/backups/user-1/hash.jpg";

        using (var source = new MemoryStream(bytes))
        {
            var storedPath = await provider.UploadFileAsync(source, logicalPath, CancellationToken.None);
            Assert.Equal(logicalPath, storedPath);
        }

        var physicalPath = Path.Combine(library.Path, "backups", UserId, "hash.jpg");
        Assert.Equal(physicalPath, provider.ResolvePhysicalPath(logicalPath));
        Assert.True(File.Exists(physicalPath));
        Assert.Equal(bytes, await File.ReadAllBytesAsync(physicalPath));

        Assert.True(await provider.FileExistsAsync(logicalPath, CancellationToken.None));
        Assert.Equal(bytes.Length, await provider.GetFileSizeAsync(logicalPath, CancellationToken.None));

        await using (var downloaded = await provider.DownloadFileAsync(logicalPath, CancellationToken.None))
        {
            using var buffer = new MemoryStream();
            await downloaded.CopyToAsync(buffer);
            Assert.Equal(bytes, buffer.ToArray());
        }

        Assert.True(await provider.DeleteFileAsync(logicalPath, CancellationToken.None));
        Assert.False(File.Exists(physicalPath));
        Assert.False(await provider.DeleteFileAsync(logicalPath, CancellationToken.None));
        Assert.False(await provider.FileExistsAsync(logicalPath, CancellationToken.None));
    }

    [Fact]
    public async Task LocalStorageProvider_OverwritesExistingFileWithoutPartialLeftovers()
    {
        using var library = new TemporaryLibrary();
        var provider = new LocalStorageProvider(library.Path);
        const string logicalPath = "/backups/user-1/hash.jpg";

        using (var first = new MemoryStream(new byte[] { 1, 1, 1 }))
            await provider.UploadFileAsync(first, logicalPath, CancellationToken.None);

        using (var second = new MemoryStream(new byte[] { 2, 2, 2, 2, 2 }))
            await provider.UploadFileAsync(second, logicalPath, CancellationToken.None);

        var physicalPath = provider.ResolvePhysicalPath(logicalPath);
        Assert.Equal(new byte[] { 2, 2, 2, 2, 2 }, await File.ReadAllBytesAsync(physicalPath));

        var directory = Path.GetDirectoryName(physicalPath)!;
        Assert.Empty(Directory.GetFiles(directory, "*.partial"));
        Assert.Single(Directory.GetFiles(directory));
    }

    [Theory]
    [InlineData("/backups/../../outside.jpg")]
    [InlineData("../outside.jpg")]
    [InlineData("C:\\Windows\\outside.jpg")]
    [InlineData("\\\\server\\share\\outside.jpg")]
    [InlineData("/backups/user-1/./hash.jpg")]
    [InlineData("/")]
    public void LocalStorageProvider_RejectsPathsOutsideTheRoot(string logicalPath)
    {
        using var library = new TemporaryLibrary();
        var provider = new LocalStorageProvider(library.Path);

        Assert.Throws<ArgumentException>(() => provider.ResolvePhysicalPath(logicalPath));
    }

    [Fact]
    public void LocalStorageProvider_RequiresAnAbsoluteRootButAcceptsAnyDiskPath()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        Assert.Equal(
            Path.Combine(home, "StashLibrary"),
            LocalStorageProvider.NormalizeRoot("~/StashLibrary"));

        Assert.Equal(
            Path.Combine(Path.GetTempPath(), "stash-library"),
            LocalStorageProvider.NormalizeRoot(Path.Combine(Path.GetTempPath(), "stash-library") + Path.DirectorySeparatorChar));

        // %VAR% expansion keeps local.settings.json portable across machines.
        Assert.Equal(
            Path.Combine(Path.GetTempPath(), "stash-library"),
            LocalStorageProvider.NormalizeRoot("%TEMP%\\stash-library"));

        // A UNC share and a mapped drive are just rooted paths; nothing is touched on disk.
        Assert.Equal(
            @"\\nas\photos\stash",
            LocalStorageProvider.NormalizeRoot(@"\\nas\photos\stash"));

        Assert.Throws<ArgumentException>(() => LocalStorageProvider.NormalizeRoot("relative/library"));
        Assert.Throws<ArgumentException>(() => LocalStorageProvider.NormalizeRoot("  "));
    }

    [Fact]
    public async Task StorageProviderFactory_CreatesLocalProviderOnExplicitRequest()
    {
        using var library = new TemporaryLibrary();
        await using var factory = CreateFactory(library.Path);

        var provider = factory.Create(LocalStorageProvider.ProviderName);

        Assert.IsType<LocalStorageProvider>(provider);
        Assert.Same(provider, factory.Create(LocalStorageProvider.ProviderName));
    }

    [Fact]
    public async Task StorageProviderFactory_ExplainsMissingLocalRoot()
    {
        await using var factory = new StorageProviderFactory(
            new ConfigurationBuilder().Build(),
            NullLoggerFactory.Instance);

        var error = Assert.Throws<InvalidOperationException>(() =>
            factory.Create(LocalStorageProvider.ProviderName));

        Assert.Contains("Storage:Local:RootPath", error.Message);
    }

    [Fact]
    public async Task StorePermanentActivity_WritesRealPhotoToConfiguredLibraryRoot()
    {
        using var library = new TemporaryLibrary();
        await using var factory = CreateFactory(library.Path);
        var activity = new StorePermanentActivity(factory);
        var source = Path.Combine(FindFixturesDirectory(), "Media", "cat_1280.jpg");
        var content = await File.ReadAllBytesAsync(source);

        var result = await activity.Run(new ProcessingContext
        {
            FileId = CatHash,
            FileHash = CatHash,
            FileName = "cat_1280.jpg",
            MimeType = "image/jpeg",
            UserId = UserId,
            ConvertedFilePath = source
        }, NullLogger.Instance);

        Assert.True(result.IsSuccess, result.Error);
        Assert.Equal($"/backups/{UserId}/{CatHash}.jpg", result.GetData<string>());

        var storedFile = Path.Combine(library.Path, "backups", UserId, $"{CatHash}.jpg");
        Assert.True(File.Exists(storedFile), $"Expected the photo at {storedFile}.");
        Assert.Equal(content, await File.ReadAllBytesAsync(storedFile));
    }

    [Fact]
    public async Task StorePermanentActivity_IsVisibleToDeduplication()
    {
        using var library = new TemporaryLibrary();
        await using var factory = CreateFactory(library.Path);
        var source = Path.Combine(FindFixturesDirectory(), "Media", "cat_1280.jpg");
        var context = new ProcessingContext
        {
            FileId = CatHash,
            FileHash = CatHash,
            FileName = "cat_1280.jpg",
            MimeType = "image/jpeg",
            UserId = UserId,
            ConvertedFilePath = source
        };

        var dedupBefore = await new CheckDeduplicationActivity(factory)
            .Run(context, NullLogger.Instance);
        Assert.False(dedupBefore.GetData<bool>());

        var store = await new StorePermanentActivity(factory).Run(context, NullLogger.Instance);
        Assert.True(store.IsSuccess, store.Error);

        var dedupAfter = await new CheckDeduplicationActivity(factory)
            .Run(context, NullLogger.Instance);
        Assert.True(dedupAfter.GetData<bool>());
    }

    [Fact]
    public async Task StorePermanentActivity_FailsClearlyWhenLibraryRootIsMissing()
    {
        await using var factory = new StorageProviderFactory(
            new ConfigurationBuilder().Build(),
            NullLoggerFactory.Instance);
        var source = Path.Combine(FindFixturesDirectory(), "Media", "cat_1280.jpg");

        var result = await new StorePermanentActivity(factory).Run(new ProcessingContext
        {
            FileId = CatHash,
            FileHash = CatHash,
            FileName = "cat_1280.jpg",
            MimeType = "image/jpeg",
            UserId = UserId,
            ConvertedFilePath = source
        }, NullLogger.Instance);

        Assert.False(result.IsSuccess);
        Assert.Contains("Storage:Local:RootPath", result.Error);
    }

    private static StorageProviderFactory CreateFactory(string rootPath) =>
        new(
            new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Storage:Local:RootPath"] = rootPath
                })
                .Build(),
            NullLoggerFactory.Instance);

    private static string FindFixturesDirectory() => Path.Combine(AppContext.BaseDirectory, "Fixtures");

    private sealed class TemporaryLibrary : IDisposable
    {
        public TemporaryLibrary()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                "stash-library-tests",
                Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose()
        {
            if (Directory.Exists(Path))
                Directory.Delete(Path, recursive: true);
        }
    }
}
