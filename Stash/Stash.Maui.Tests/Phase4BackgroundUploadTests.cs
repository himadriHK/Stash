using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Stash.Maui.Auth;
using Stash.Maui.Configuration;
using Stash.Maui.Data.Entities;
using Stash.Maui.Data.Repositories;
using Stash.Maui.Services;
using StashHost.Shared.Contracts;
using StashHost.Shared.Messages;

namespace Stash.Maui.Tests;

public class Phase4BackgroundUploadTests
{
    private const string FileHash =
        "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";

    [Fact]
    public async Task RunOnceAsync_DiscoversUploadsAndQueuesNewFile()
    {
        using var tempFile = new TemporaryFile();
        var fileInfo = new FileInfo(tempFile.Path);
        var folder = CreateFolder();
        var repository = new FakeFileRepository();
        var scanner = new FakeFolderScanner(fileInfo, FileHash);
        var uploads = new FakeUploadManager(repository);
        var kafka = new FakeKafkaProducer();
        var service = CreateService(
            repository,
            new FakeFolderRepository(folder),
            scanner,
            uploads,
            kafka,
            new FakeAuthenticationService());

        var result = await service.RunOnceAsync();

        Assert.True(result.Success);
        Assert.Equal(1, result.Scanned);
        Assert.Equal(1, result.Discovered);
        Assert.Equal(1, result.Uploaded);
        Assert.Equal(1, result.Queued);
        Assert.Equal(0, result.Failed);

        var file = Assert.Single(repository.Files);
        Assert.Equal(FileHash, file.ContentHash);
        Assert.Equal(UploadStatus.Processing, file.Status);
        Assert.Equal("/temp/uploads/device-1/" + Path.GetFileName(tempFile.Path), file.MegaTempPath);

        var request = Assert.Single(kafka.Requests);
        Assert.Equal(FileHash, request.FileId);
        Assert.Equal("device-1", request.DeviceId);
        Assert.Equal("user-1", request.UserId);
        Assert.Equal(file.MegaTempPath, request.MegaTempPath);
        Assert.NotNull(request.Metadata);
    }

    [Fact]
    public async Task RunOnceAsync_SkipsAlreadyKnownContent()
    {
        using var tempFile = new TemporaryFile();
        var existing = new FileEntity
        {
            ContentHash = FileHash,
            FilePath = tempFile.Path,
            Status = UploadStatus.Completed
        };
        var repository = new FakeFileRepository(existing);
        var scanner = new FakeFolderScanner(new FileInfo(tempFile.Path), FileHash);
        var uploads = new FakeUploadManager(repository);
        var kafka = new FakeKafkaProducer();
        var service = CreateService(
            repository,
            new FakeFolderRepository(CreateFolder()),
            scanner,
            uploads,
            kafka,
            new FakeAuthenticationService());

        var result = await service.RunOnceAsync();

        Assert.True(result.Success);
        Assert.Equal(1, result.Scanned);
        Assert.Equal(0, result.Discovered);
        Assert.Equal(0, uploads.UploadCalls);
        Assert.Empty(kafka.Requests);
        Assert.Single(repository.Files);
    }

    [Fact]
    public async Task RunOnceAsync_FailsWithoutAnAuthenticatedToken()
    {
        var repository = new FakeFileRepository();
        var scanner = new FakeFolderScanner(new FileInfo("unused.jpg"), FileHash);
        var service = CreateService(
            repository,
            new FakeFolderRepository(CreateFolder()),
            scanner,
            new FakeUploadManager(repository),
            new FakeKafkaProducer(),
            new FakeAuthenticationService { AccessToken = string.Empty });

        var result = await service.RunOnceAsync();

        Assert.False(result.Success);
        Assert.Contains("authenticated", result.ErrorMessage, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(0, scanner.ScanCalls);
        Assert.Empty(repository.Files);
    }

    [Fact]
    public async Task RunOnceAsync_ReturnsAlreadyRunning_WhenAnotherPassIsActive()
    {
        using var tempFile = new TemporaryFile();
        var repository = new FakeFileRepository();
        var scanner = new FakeFolderScanner(new FileInfo(tempFile.Path), FileHash)
        {
            ScanGate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously)
        };
        var service = CreateService(
            repository,
            new FakeFolderRepository(CreateFolder()),
            scanner,
            new FakeUploadManager(repository),
            new FakeKafkaProducer(),
            new FakeAuthenticationService());

        var first = service.RunOnceAsync();
        await scanner.ScanEntered.Task;
        var second = await service.RunOnceAsync();
        scanner.ScanGate.SetResult(true);
        var firstResult = await first;

        Assert.True(firstResult.Success);
        Assert.True(second.AlreadyRunning);
        Assert.DoesNotContain(repository.Files, file => file.Status == UploadStatus.Failed);
    }

    [Fact]
    public async Task RunOnceAsync_QueuesPreviouslyUploadedFile()
    {
        using var tempFile = new TemporaryFile();
        var repository = new FakeFileRepository(
            new FileEntity
            {
                ContentHash = FileHash,
                FilePath = tempFile.Path,
                FileName = "uploaded.jpg",
                Status = UploadStatus.Uploaded,
                MegaTempPath = "/temp/uploads/device-1/uploaded.jpg"
            });
        var uploads = new FakeUploadManager(repository);
        var kafka = new FakeKafkaProducer();
        var service = CreateService(
            repository,
            new FakeFolderRepository(),
            new FakeFolderScanner(Array.Empty<FileInfo>(), string.Empty),
            uploads,
            kafka,
            new FakeAuthenticationService());

        var result = await service.RunOnceAsync();

        Assert.True(result.Success);
        Assert.Equal(1, result.Uploaded);
        Assert.Equal(1, result.Queued);
        Assert.Single(kafka.Requests);
        Assert.Equal(UploadStatus.Processing, Assert.Single(repository.Files).Status);
    }

    [Fact]
    public async Task RunOnceAsync_ResetsToRetrying_WhenCanceledBeforeKafkaPublish()
    {
        using var tempFile = new TemporaryFile();
        using var cts = new CancellationTokenSource();
        var repository = new FakeFileRepository();
        var kafka = new FakeKafkaProducer
        {
            CancelOnProduce = cts
        };
        var service = CreateService(
            repository,
            new FakeFolderRepository(CreateFolder()),
            new FakeFolderScanner(new FileInfo(tempFile.Path), FileHash),
            new FakeUploadManager(repository),
            kafka,
            new FakeAuthenticationService());

        var result = await service.RunOnceAsync(cts.Token);

        Assert.True(result.Canceled);
        Assert.Equal(1, result.Uploaded);
        Assert.Equal(0, result.Queued);

        var file = Assert.Single(repository.Files);
        Assert.Equal(UploadStatus.Retrying, file.Status);
        Assert.Equal("Background upload canceled before Kafka publish.", file.ErrorMessage);
    }

    [Fact]
    public async Task RunOnceAsync_MarksFileFailed_WhenKafkaPublishFails()
    {
        using var tempFile = new TemporaryFile();
        var repository = new FakeFileRepository();
        var kafka = new FakeKafkaProducer
        {
            Failure = new InvalidOperationException("proxy unavailable")
        };
        var service = CreateService(
            repository,
            new FakeFolderRepository(CreateFolder()),
            new FakeFolderScanner(new FileInfo(tempFile.Path), FileHash),
            new FakeUploadManager(repository),
            kafka,
            new FakeAuthenticationService());

        var result = await service.RunOnceAsync();

        Assert.True(result.Success);
        Assert.Equal(1, result.Uploaded);
        Assert.Equal(0, result.Queued);
        Assert.Equal(1, result.Failed);

        var file = Assert.Single(repository.Files);
        Assert.Equal(UploadStatus.Failed, file.Status);
        Assert.Equal(1, file.RetryCount);
        Assert.Contains("proxy unavailable", file.ErrorMessage, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task RunOnceAsync_RespectsMaxFilesPerRun()
    {
        using var firstFile = new TemporaryFile();
        using var secondFile = new TemporaryFile();
        var repository = new FakeFileRepository(
            new FileEntity
            {
                ContentHash = FileHash,
                FilePath = firstFile.Path,
                FileName = "first.jpg",
                Status = UploadStatus.Pending
            },
            new FileEntity
            {
                ContentHash = new string('b', 64),
                FilePath = secondFile.Path,
                FileName = "second.jpg",
                Status = UploadStatus.Pending
            });
        var uploads = new FakeUploadManager(repository);
        var config = CreateConfig();
        config.BackgroundUpload.MaxFilesPerRun = 1;
        var service = new BackgroundUploadService(
            new FakeAuthenticationService(),
            new FakeFolderRepository(),
            new FakeFolderScanner(Array.Empty<FileInfo>(), string.Empty),
            repository,
            uploads,
            new FakeKafkaProducer(),
            config,
            NullLogger<BackgroundUploadService>.Instance);

        var result = await service.RunOnceAsync();

        Assert.True(result.Success);
        Assert.Equal(1, result.Uploaded);
        Assert.Equal(1, uploads.UploadCalls);
        Assert.Equal(1, result.Queued);
    }

    [Fact]
    public async Task AddStashBackgroundUploadServices_RegistersServiceAndScheduler()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        var config = CreateConfig();
        services.AddSingleton(config);
        services.AddSingleton<IAuthenticationService, FakeAuthenticationService>();
        services.AddSingleton<IFolderRepository>(new FakeFolderRepository());
        services.AddSingleton<IFileRepository>(new FakeFileRepository());
        services.AddSingleton<IFolderScannerService>(new FakeFolderScanner(Array.Empty<FileInfo>(), string.Empty));
        services.AddSingleton<IUploadManager>(new FakeUploadManager(new FakeFileRepository()));
        services.AddSingleton<IKafkaProducer>(new FakeKafkaProducer());
        services.AddStashBackgroundUploadServices();

        await using var provider = services.BuildServiceProvider();
        Assert.NotNull(provider.GetService<IBackgroundUploadService>());
        Assert.NotNull(provider.GetService<IBackgroundUploadScheduler>());
    }

    private static BackgroundUploadService CreateService(
        FakeFileRepository repository,
        FakeFolderRepository folders,
        FakeFolderScanner scanner,
        FakeUploadManager uploads,
        FakeKafkaProducer kafka,
        FakeAuthenticationService authentication)
    {
        return new BackgroundUploadService(
            authentication,
            folders,
            scanner,
            repository,
            uploads,
            kafka,
            CreateConfig(),
            NullLogger<BackgroundUploadService>.Instance);
    }

    private static StashConfig CreateConfig()
    {
        return new StashConfig
        {
            BackgroundUpload = new BackgroundUploadConfig
            {
                Enabled = true,
                IntervalMinutes = 15,
                MaxFilesPerRun = 50
            },
            UploadSettings = new UploadSettings
            {
                BatchSize = 10,
                MaxRetries = 3,
                MaxFileSizeBytes = 500L * 1024 * 1024
            }
        };
    }

    private static FolderConfig CreateFolder()
    {
        return new FolderConfig
        {
            FolderPath = Path.GetTempPath(),
            FolderName = "Test",
            IsEnabled = true
        };
    }

    private sealed class TemporaryFile : IDisposable
    {
        public TemporaryFile()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                $"stash-bg-{Guid.NewGuid():N}.jpg");
            File.WriteAllText(Path, "background-upload-test");
        }

        public string Path { get; }

        public void Dispose()
        {
            try
            {
                File.Delete(Path);
            }
            catch
            {
                // Best-effort test cleanup.
            }
        }
    }

    private sealed class FakeFolderRepository : IFolderRepository
    {
        private readonly List<FolderConfig> _folders;

        public FakeFolderRepository(params FolderConfig[] folders)
        {
            _folders = folders.ToList();
        }

        public Task<FolderConfig?> GetByIdAsync(Guid id, CancellationToken ct = default) =>
            Task.FromResult(_folders.FirstOrDefault(folder => folder.Id == id));

        public Task<FolderConfig?> GetByPathAsync(string folderPath, CancellationToken ct = default) =>
            Task.FromResult(_folders.FirstOrDefault(folder => folder.FolderPath == folderPath));

        public Task<IReadOnlyList<FolderConfig>> GetAllAsync(CancellationToken ct = default) =>
            Task.FromResult<IReadOnlyList<FolderConfig>>(_folders.ToList());

        public Task AddAsync(FolderConfig folder, CancellationToken ct = default)
        {
            _folders.Add(folder);
            return Task.CompletedTask;
        }

        public Task UpdateAsync(FolderConfig folder, CancellationToken ct = default) =>
            Task.CompletedTask;

        public Task<bool> DeleteAsync(Guid id, CancellationToken ct = default) =>
            Task.FromResult(_folders.RemoveAll(folder => folder.Id == id) > 0);
    }

    private sealed class FakeFileRepository : IFileRepository
    {
        private readonly List<FileEntity> _files;

        public FakeFileRepository(params FileEntity[] files)
        {
            _files = files.ToList();
        }

        public IReadOnlyList<FileEntity> Files => _files;

        public Task<FileEntity?> GetByIdAsync(Guid id, CancellationToken ct = default) =>
            Task.FromResult(_files.FirstOrDefault(file => file.Id == id));

        public Task<FileEntity?> GetByContentHashAsync(
            string contentHash,
            CancellationToken ct = default) =>
            Task.FromResult(_files.FirstOrDefault(file =>
                string.Equals(file.ContentHash, contentHash, StringComparison.OrdinalIgnoreCase)));

        public Task<IReadOnlyList<FileEntity>> GetAllAsync(CancellationToken ct = default) =>
            Task.FromResult<IReadOnlyList<FileEntity>>(_files.ToList());

        public Task<bool> ExistsByContentHashAsync(
            string contentHash,
            CancellationToken ct = default) =>
            Task.FromResult(_files.Any(file =>
                string.Equals(file.ContentHash, contentHash, StringComparison.OrdinalIgnoreCase)));

        public Task AddAsync(FileEntity file, CancellationToken ct = default)
        {
            _files.Add(file);
            return Task.CompletedTask;
        }

        public Task UpdateAsync(FileEntity file, CancellationToken ct = default) =>
            Task.CompletedTask;

        public Task<bool> DeleteAsync(Guid id, CancellationToken ct = default) =>
            Task.FromResult(_files.RemoveAll(file => file.Id == id) > 0);
    }

    private sealed class FakeFolderScanner : IFolderScannerService
    {
        private readonly IReadOnlyList<FileInfo> _files;
        private readonly string _hash;

        public FakeFolderScanner(IReadOnlyList<FileInfo> files, string hash)
        {
            _files = files;
            _hash = hash;
        }

        public FakeFolderScanner(FileInfo file, string hash)
            : this(new[] { file }, hash)
        {
        }

        public int ScanCalls { get; private set; }

        public TaskCompletionSource<bool>? ScanGate { get; set; }

        public TaskCompletionSource<bool> ScanEntered { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public async Task<IReadOnlyList<FileInfo>> ScanFolderAsync(
            string folderPath,
            CancellationToken ct = default)
        {
            ScanCalls++;
            ScanEntered.TrySetResult(true);
            if (ScanGate is not null)
                await ScanGate.Task.WaitAsync(ct);
            return _files;
        }

        public Task<IReadOnlyList<FileInfo>> ScanFolderAsync(
            string folderPath,
            IReadOnlyCollection<string>? includePatterns,
            IReadOnlyCollection<string>? excludePatterns,
            bool includeSubfolders,
            CancellationToken ct = default) => ScanFolderAsync(folderPath, ct);

        public Task<IReadOnlyList<FileInfo>> ScanFolderAsync(
            FolderConfig folder,
            CancellationToken ct = default) => ScanFolderAsync(folder.FolderPath, ct);

        public Task<string> ComputeFileHashAsync(
            string filePath,
            CancellationToken ct = default) => Task.FromResult(_hash);

        public Task<bool> IsFolderAccessibleAsync(string folderPath) => Task.FromResult(true);
    }

    private sealed class FakeUploadManager : IUploadManager
    {
        private readonly FakeFileRepository _repository;

        public FakeUploadManager(FakeFileRepository repository)
        {
            _repository = repository;
        }

        public int UploadCalls { get; private set; }

        public async Task<UploadResult> UploadFileAsync(
            FileEntity file,
            string megaTempPath,
            CancellationToken ct = default)
        {
            UploadCalls++;
            file.MegaTempPath = megaTempPath;
            file.Status = UploadStatus.Uploaded;
            await _repository.UpdateAsync(file, ct);
            return UploadResult.Succeeded(file.Id, megaTempPath);
        }

        public Task<UploadResult> UploadFileAsync(
            FileEntity file,
            CancellationToken ct = default) =>
            UploadFileAsync(file, $"/temp/uploads/device-1/{file.FileName}", ct);

        public async Task<UploadBatchResult> UploadBatchAsync(
            IEnumerable<FileEntity> files,
            CancellationToken ct = default)
        {
            var results = new List<UploadResult>();
            foreach (var file in files)
            {
                results.Add(await UploadFileAsync(file, ct));
            }

            return new UploadBatchResult(results, 10, results.Count == 0 ? 0 : 1);
        }

        public Task<bool> IsUploadInProgressAsync(Guid fileId) => Task.FromResult(false);
    }

    private sealed class FakeKafkaProducer : IKafkaProducer
    {
        public List<UploadRequestMessage> Requests { get; } = new();

        public Exception? Failure { get; set; }

        public CancellationTokenSource? CancelOnProduce { get; set; }

        public Task ProduceUploadRequestAsync(
            UploadRequestMessage message,
            CancellationToken ct)
        {
            if (Failure is not null)
                throw Failure;

            if (CancelOnProduce is not null)
            {
                CancelOnProduce.Cancel();
                throw new OperationCanceledException(CancelOnProduce.Token);
            }

            Requests.Add(message);
            return Task.CompletedTask;
        }

        public Task ProduceUploadResponseAsync(
            UploadResponseMessage message,
            CancellationToken ct) => Task.CompletedTask;

        public Task ProduceDeadLetterAsync(
            string key,
            string payload,
            string reason,
            CancellationToken ct) => Task.CompletedTask;
    }

    private sealed class FakeAuthenticationService : IAuthenticationService
    {
        public string AccessToken { get; set; } = "access-token";

        public string UserId { get; set; } = "user-1";

        public string DeviceId { get; set; } = "device-1";

        public Task<AuthResult> RegisterAsync(
            string email,
            string password,
            string deviceId,
            CancellationToken ct = default) => throw new NotSupportedException();

        public Task<AuthResult> LoginAsync(
            string email,
            string password,
            string deviceId,
            CancellationToken ct = default) => throw new NotSupportedException();

        public Task<string> GetAccessTokenAsync(CancellationToken ct = default) =>
            Task.FromResult(AccessToken);

        public Task<bool> EnsureValidAccessTokenAsync(CancellationToken ct = default) =>
            Task.FromResult(!string.IsNullOrWhiteSpace(AccessToken));

        public Task<string> GetUserIdAsync(CancellationToken ct = default) =>
            Task.FromResult(UserId);

        public Task<bool> RefreshTokenAsync(CancellationToken ct = default) =>
            Task.FromResult(true);

        public Task LogoutAsync(CancellationToken ct = default) => Task.CompletedTask;

        public Task<bool> RevokeDeviceAsync(string deviceId, CancellationToken ct = default) =>
            Task.FromResult(false);

        public Task<string> GetOrCreateDeviceIdAsync(CancellationToken ct = default) =>
            Task.FromResult(DeviceId);
    }
}
