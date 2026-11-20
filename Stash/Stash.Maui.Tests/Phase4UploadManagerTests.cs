using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Stash.Maui.Configuration;
using Stash.Maui.Data;
using Stash.Maui.Data.Entities;
using Stash.Maui.Data.Repositories;
using Stash.Maui.Services;
using StashHost.Shared.Contracts;

namespace Stash.Maui.Tests;

public class Phase4UploadManagerTests
{
    [Fact]
    public async Task UploadFileAsync_UploadsToTempPath_AndPersistsUploadedStatus()
    {
        await using var workspace = new TestWorkspace();
        await using var provider = workspace.CreateProvider();
        provider.InitializeStashDatabase();

        var repository = provider.GetRequiredService<IFileRepository>();
        var filePath = workspace.CreateFile("photo.jpg", "image-data");
        var entity = CreateEntity(filePath);
        await repository.AddAsync(entity);

        var storage = new FakeStorageProvider();
        var manager = CreateManager(storage, repository);

        var result = await manager.UploadFileAsync(entity);

        Assert.True(result.Success);
        Assert.Equal("/temp/uploads/device-1/photo.jpg", result.MegaTempPath);
        Assert.Null(result.ErrorMessage);
        Assert.Single(storage.UploadedPaths);
        Assert.Equal("/temp/uploads/device-1/photo.jpg", storage.UploadedPaths[0]);
        Assert.Equal(Encoding.UTF8.GetBytes("image-data").Length, storage.Uploads[0].Content.Length);

        var persisted = await repository.GetByIdAsync(entity.Id);
        Assert.NotNull(persisted);
        Assert.Equal(UploadStatus.Uploaded, persisted!.Status);
        Assert.Equal("/temp/uploads/device-1/photo.jpg", persisted.MegaTempPath);
        Assert.Null(persisted.ErrorMessage);
        Assert.False(await manager.IsUploadInProgressAsync(entity.Id));
    }

    [Fact]
    public async Task UploadBatchAsync_ProcessesConfiguredBatchSize_AndPersistsAll()
    {
        await using var workspace = new TestWorkspace();
        await using var provider = workspace.CreateProvider();
        provider.InitializeStashDatabase();

        var repository = provider.GetRequiredService<IFileRepository>();
        var files = new[]
        {
            await AddFileAsync(repository, workspace, "one.jpg"),
            await AddFileAsync(repository, workspace, "two.jpg"),
            await AddFileAsync(repository, workspace, "three.jpg")
        };

        var storage = new FakeStorageProvider { Delay = TimeSpan.FromMilliseconds(50) };
        var manager = CreateManager(storage, repository, batchSize: 2);

        var result = await manager.UploadBatchAsync(files);

        Assert.Equal(3, result.TotalCount);
        Assert.Equal(3, result.SuccessCount);
        Assert.Equal(0, result.FailureCount);
        Assert.True(result.AllSucceeded);
        Assert.Equal(2, result.BatchSize);
        Assert.Equal(2, result.BatchCount);
        Assert.Equal(3, storage.UploadedPaths.Count);
        Assert.InRange(storage.MaxConcurrentUploads, 1, 2);

        foreach (var file in files)
        {
            var persisted = await repository.GetByIdAsync(file.Id);
            Assert.NotNull(persisted);
            Assert.Equal(UploadStatus.Uploaded, persisted!.Status);
            Assert.Equal($"/temp/uploads/device-1/{file.FileName}", persisted.MegaTempPath);
        }
    }

    [Fact]
    public async Task UploadFileAsync_PersistsFailure_AndIncrementsRetry()
    {
        await using var workspace = new TestWorkspace();
        await using var provider = workspace.CreateProvider();
        provider.InitializeStashDatabase();

        var repository = provider.GetRequiredService<IFileRepository>();
        var filePath = workspace.CreateFile("broken.jpg", "data");
        var entity = CreateEntity(filePath);
        await repository.AddAsync(entity);

        var storage = new FakeStorageProvider
        {
            UploadException = new IOException("Mega unavailable")
        };
        var manager = CreateManager(storage, repository);

        var result = await manager.UploadFileAsync(entity);

        Assert.False(result.Success);
        Assert.Contains("Mega unavailable", result.ErrorMessage);

        var persisted = await repository.GetByIdAsync(entity.Id);
        Assert.NotNull(persisted);
        Assert.Equal(UploadStatus.Failed, persisted!.Status);
        Assert.Contains("Mega unavailable", persisted.ErrorMessage);
        Assert.Equal(1, persisted.RetryCount);
        Assert.NotNull(persisted.LastAttemptAt);
        Assert.Equal("/temp/uploads/device-1/broken.jpg", persisted.MegaTempPath);
        Assert.False(await manager.IsUploadInProgressAsync(entity.Id));
    }

    [Fact]
    public async Task UploadFileAsync_RejectsOversizedFile_WithoutUploading()
    {
        await using var workspace = new TestWorkspace();
        await using var provider = workspace.CreateProvider();
        provider.InitializeStashDatabase();

        var repository = provider.GetRequiredService<IFileRepository>();
        var filePath = workspace.CreateFile("large.jpg", "too large");
        var entity = CreateEntity(filePath);
        await repository.AddAsync(entity);

        var storage = new FakeStorageProvider();
        var manager = CreateManager(storage, repository, maxFileSizeBytes: 4);

        var result = await manager.UploadFileAsync(entity);

        Assert.False(result.Success);
        Assert.Empty(storage.UploadedPaths);
        var persisted = await repository.GetByIdAsync(entity.Id);
        Assert.NotNull(persisted);
        Assert.Equal(UploadStatus.Failed, persisted!.Status);
        Assert.Equal(0, persisted.RetryCount);
    }

    [Fact]
    public async Task IsUploadInProgressAsync_IsTrueDuringUpload()
    {
        await using var workspace = new TestWorkspace();
        await using var provider = workspace.CreateProvider();
        provider.InitializeStashDatabase();

        var repository = provider.GetRequiredService<IFileRepository>();
        var filePath = workspace.CreateFile("slow.jpg", "data");
        var entity = CreateEntity(filePath);
        await repository.AddAsync(entity);

        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var storage = new FakeStorageProvider
        {
            OnUploadAsync = async (_, _) =>
            {
                started.TrySetResult();
                await release.Task;
            }
        };
        var manager = CreateManager(storage, repository);

        var upload = manager.UploadFileAsync(entity);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.True(await manager.IsUploadInProgressAsync(entity.Id));

        release.SetResult();
        var result = await upload;

        Assert.True(result.Success);
        Assert.False(await manager.IsUploadInProgressAsync(entity.Id));
    }

    [Fact]
    public async Task AddStashUploadServices_RegistersUploadManager()
    {
        await using var workspace = new TestWorkspace();
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddStashServices(new ConfigurationBuilder().Build());
        services.AddStashData(workspace.DatabasePath);
        services.AddStashUploadServices();

        await using var provider = services.BuildServiceProvider();
        Assert.IsType<UploadManager>(provider.GetRequiredService<IUploadManager>());
    }

    private static UploadManager CreateManager(
        FakeStorageProvider storage,
        IFileRepository repository,
        int batchSize = 10,
        long maxFileSizeBytes = 500L * 1024 * 1024)
    {
        var configuration = new StashConfig();
        configuration.UploadSettings.BatchSize = batchSize;
        configuration.UploadSettings.MaxFileSizeBytes = maxFileSizeBytes;

        return new UploadManager(
            storage,
            repository,
            configuration,
            NullLogger<UploadManager>.Instance);
    }

    private static async Task<FileEntity> AddFileAsync(
        IFileRepository repository,
        TestWorkspace workspace,
        string fileName)
    {
        var entity = CreateEntity(workspace.CreateFile(fileName, fileName));
        await repository.AddAsync(entity);
        return entity;
    }

    private static FileEntity CreateEntity(string filePath)
    {
        var hash = Convert.ToHexStringLower(
            SHA256.HashData(Encoding.UTF8.GetBytes(filePath)));

        return new FileEntity
        {
            FileName = Path.GetFileName(filePath),
            FilePath = filePath,
            FileSize = new FileInfo(filePath).Length,
            ContentHash = hash,
            MimeType = "image/jpeg",
            DeviceId = "device-1",
            UserId = "user-1"
        };
    }

    private sealed class TestWorkspace : IAsyncDisposable
    {
        public TestWorkspace()
        {
            RootPath = Path.Combine(
                Path.GetTempPath(),
                "stash-upload-tests",
                Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(RootPath);
            DatabasePath = Path.Combine(RootPath, "stash.db");
        }

        public string RootPath { get; }

        public string DatabasePath { get; }

        public string CreateFile(string fileName, string content)
        {
            var filePath = Path.Combine(RootPath, fileName);
            File.WriteAllText(
                filePath,
                content,
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            return filePath;
        }

        public ServiceProvider CreateProvider()
        {
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddStashData(DatabasePath);
            return services.BuildServiceProvider();
        }

        public ValueTask DisposeAsync()
        {
            SqliteConnection.ClearAllPools();

            try
            {
                if (Directory.Exists(RootPath))
                    Directory.Delete(RootPath, recursive: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // A transient filesystem handle should not fail the test result.
            }

            return ValueTask.CompletedTask;
        }
    }

    private sealed class FakeStorageProvider : IStorageProvider
    {
        private readonly ConcurrentQueue<(string Path, byte[] Content)> _uploads = new();
        private readonly object _gate = new();
        private int _activeUploads;
        private int _maxConcurrentUploads;

        public IReadOnlyList<(string Path, byte[] Content)> Uploads => _uploads.ToArray();

        public IReadOnlyList<string> UploadedPaths => Uploads.Select(upload => upload.Path).ToArray();

        public int MaxConcurrentUploads => _maxConcurrentUploads;

        public Func<string, CancellationToken, Task>? OnUploadAsync { get; set; }

        public Exception? UploadException { get; set; }

        public TimeSpan Delay { get; set; }

        public async Task<string> UploadFileAsync(
            Stream fileStream,
            string remotePath,
            CancellationToken ct)
        {
            var active = Interlocked.Increment(ref _activeUploads);
            lock (_gate)
                _maxConcurrentUploads = Math.Max(_maxConcurrentUploads, active);

            try
            {
                using var buffer = new MemoryStream();
                await fileStream.CopyToAsync(buffer, ct);
                _uploads.Enqueue((remotePath, buffer.ToArray()));

                if (OnUploadAsync is not null)
                    await OnUploadAsync(remotePath, ct);
                if (Delay > TimeSpan.Zero)
                    await Task.Delay(Delay, ct);
                if (UploadException is not null)
                    throw UploadException;

                return remotePath;
            }
            finally
            {
                Interlocked.Decrement(ref _activeUploads);
            }
        }

        public Task<bool> DeleteFileAsync(string remotePath, CancellationToken ct)
        {
            return Task.FromResult(false);
        }

        public Task<Stream> DownloadFileAsync(string remotePath, CancellationToken ct)
        {
            throw new NotSupportedException();
        }

        public Task<bool> FileExistsAsync(string remotePath, CancellationToken ct)
        {
            return Task.FromResult(false);
        }

        public Task<long> GetFileSizeAsync(string remotePath, CancellationToken ct)
        {
            return Task.FromResult(0L);
        }
    }
}
