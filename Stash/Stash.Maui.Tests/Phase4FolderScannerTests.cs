using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Stash.Maui.Configuration;
using Stash.Maui.Data.Entities;
using Stash.Maui.Services;

namespace Stash.Maui.Tests;

public class Phase4FolderScannerTests
{
    [Fact]
    public async Task ScanFolderAsync_DiscoversMediaTypes_AndSkipsOtherFiles()
    {
        using var directory = new TemporaryDirectory();
        directory.CreateFile("photo.jpg");
        directory.CreateFile("photo2.JPG");
        directory.CreateFile("image.png");
        directory.CreateFile("clip.mp4");
        directory.CreateFile("movie.mov");
        directory.CreateFile("picture.webp");
        directory.CreateFile("still.avif");
        directory.CreateFile("raw.raw");
        directory.CreateFile("raw.dng");
        directory.CreateFile("notes.txt");
        directory.CreateFile("archive.zip");
        directory.CreateFile("nested/nested.heic");
        directory.CreateFile("nested/nested.jpeg");

        IFolderScannerService scanner = new FolderScannerService();

        var files = await scanner.ScanFolderAsync(directory.RootPath);
        var names = files.Select(file => file.Name).OrderBy(name => name).ToArray();

        Assert.Equal(
            new[]
            {
                "clip.mp4",
                "image.png",
                "movie.mov",
                "nested.heic",
                "nested.jpeg",
                "photo.jpg",
                "photo2.JPG",
                "picture.webp",
                "raw.dng",
                "raw.raw",
                "still.avif"
            },
            names);

        Assert.All(files, file => Assert.True(file.Exists));
        Assert.DoesNotContain(files, file => file.Name == "notes.txt");
        Assert.DoesNotContain(files, file => file.Name == "archive.zip");
    }

    [Fact]
    public async Task ScanFolderAsync_AppliesIncludeExcludePatterns_AndSubfolderSetting()
    {
        using var directory = new TemporaryDirectory();
        directory.CreateFile("keep.jpg");
        directory.CreateFile("drop.tmp");
        directory.CreateFile("clip.mp4");
        directory.CreateFile("nested/keep2.jpg");
        directory.CreateFile("nested/drop.tmp");

        IFolderScannerService scanner = new FolderScannerService();
        var include = new[] { "*.jpg", "*.mp4", "*.tmp" };
        var exclude = new[] { "*.tmp" };

        var topOnly = await scanner.ScanFolderAsync(
            directory.RootPath,
            include,
            exclude,
            includeSubfolders: false);

        Assert.Equal(
            new[] { "clip.mp4", "keep.jpg" },
            topOnly.Select(file => file.Name).OrderBy(name => name).ToArray());

        var recursive = await scanner.ScanFolderAsync(
            directory.RootPath,
            include,
            exclude,
            includeSubfolders: true);

        Assert.Equal(
            new[] { "clip.mp4", "keep.jpg", "keep2.jpg" },
            recursive.Select(file => file.Name).OrderBy(name => name).ToArray());

        var allFiles = await scanner.ScanFolderAsync(
            directory.RootPath,
            Array.Empty<string>(),
            Array.Empty<string>(),
            includeSubfolders: false);

        Assert.Equal(
            new[] { "clip.mp4", "drop.tmp", "keep.jpg" },
            allFiles.Select(file => file.Name).OrderBy(name => name).ToArray());
    }

    [Fact]
    public async Task ScanFolderAsync_UsesFolderConfig()
    {
        using var directory = new TemporaryDirectory();
        directory.CreateFile("keep.jpg");
        directory.CreateFile("drop.jpg");
        directory.CreateFile("clip.mp4");
        directory.CreateFile("nested/keep2.jpg");

        var config = new FolderConfig
        {
            FolderPath = directory.RootPath,
            FolderName = "Test",
            IncludePatterns = new List<string> { "*.jpg" },
            ExcludePatterns = new List<string> { "drop*" },
            IncludeSubfolders = false
        };

        IFolderScannerService scanner = new FolderScannerService();
        var files = await scanner.ScanFolderAsync(config);

        Assert.Single(files);
        Assert.Equal("keep.jpg", files[0].Name);
    }

    [Fact]
    public async Task ComputeFileHashAsync_ReturnsLowercaseSha256()
    {
        using var directory = new TemporaryDirectory();
        var filePath = Path.Combine(directory.RootPath, "hash.txt");
        File.WriteAllBytes(filePath, Encoding.ASCII.GetBytes("abc"));

        IFolderScannerService scanner = new FolderScannerService();
        var hash = await scanner.ComputeFileHashAsync(filePath);

        Assert.Equal(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            hash);
        Assert.Equal(hash.ToLowerInvariant(), hash);
    }

    [Fact]
    public async Task IsFolderAccessibleAsync_HandlesExistingMissingAndFilePaths()
    {
        using var directory = new TemporaryDirectory();
        var filePath = directory.CreateFile("not-a-folder.jpg");

        IFolderScannerService scanner = new FolderScannerService();

        Assert.True(await scanner.IsFolderAccessibleAsync(directory.RootPath));
        Assert.False(await scanner.IsFolderAccessibleAsync(
            Path.Combine(directory.RootPath, "missing")));
        Assert.False(await scanner.IsFolderAccessibleAsync(filePath));
        Assert.False(await scanner.IsFolderAccessibleAsync(string.Empty));
    }

    [Fact]
    public async Task ScanFolderAsync_ReturnsEmpty_WhenFolderIsMissing()
    {
        using var directory = new TemporaryDirectory();
        IFolderScannerService scanner = new FolderScannerService();

        var files = await scanner.ScanFolderAsync(
            Path.Combine(directory.RootPath, "missing"));

        Assert.Empty(files);
    }

    [Fact]
    public void AddStashServices_RegistersFolderScanner()
    {
        var configuration = new ConfigurationBuilder().Build();
        var services = new ServiceCollection();
        services.AddStashServices(configuration);

        using var provider = services.BuildServiceProvider();
        Assert.IsType<FolderScannerService>(
            provider.GetRequiredService<IFolderScannerService>());
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        public TemporaryDirectory()
        {
            RootPath = Path.Combine(
                Path.GetTempPath(),
                "stash-folder-scanner-tests",
                Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(RootPath);
        }

        public string RootPath { get; }

        public string CreateFile(string relativePath, string content = "test")
        {
            var fullPath = Path.Combine(RootPath, relativePath);
            var parent = Path.GetDirectoryName(fullPath);
            if (!string.IsNullOrEmpty(parent))
                Directory.CreateDirectory(parent);

            File.WriteAllText(fullPath, content, Encoding.UTF8);
            return fullPath;
        }

        public void Dispose()
        {
            try
            {
                if (Directory.Exists(RootPath))
                    Directory.Delete(RootPath, recursive: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // A transient filesystem handle should not fail the test result.
            }
        }
    }
}
