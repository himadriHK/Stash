using Microsoft.DurableTask;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using StashHost.Functions.Orchestrations;
using StashHost.Shared.Messages;

namespace StashHost.Tests;

public class Phase7OrchestrationTests
{
    private static readonly string Hash = new('a', 64);
    private const string LocalPath = "/tmp/stash/local/photo.heic";
    private const string ConvertedPath = "/tmp/stash/local/photo.jpg";
    private static readonly string PermanentPath = $"/backups/user-1/{Hash}.jpg";

    [Fact]
    public async Task Orchestration_HappyPath_RunsActivitiesInOrderAndSendsCompletedResponse()
    {
        var context = CreateHappyContext();

        await new FileProcessingOrchestration().RunOrchestration(context);

        Assert.Equal(
            new[]
            {
                "DownloadFileActivity",
                "ComputeHashActivity",
                "CheckDeduplicationActivity",
                "ConvertFormatActivity",
                "GenerateThumbnailActivity",
                "GenerateThumbnailActivity",
                "GenerateThumbnailActivity",
                "StorePermanentActivity",
                "DeleteTempFileActivity",
                "SendResponseActivity",
                "DeleteLocalTempActivity"
            },
            context.Calls.Select(call => call.Name));

        var response = GetResponse(context);
        Assert.Equal("COMPLETED", response.Status);
        Assert.Equal(Hash, response.FileId);
        Assert.Equal(PermanentPath, response.PermanentPath);
        Assert.Equal("image/jpeg", response.ConvertedFormat);
        Assert.False(response.Deduplicated);
        Assert.Null(response.Error);
        Assert.Equal(3, response.Thumbnails.Count);

        var thumbnailRequests = context.Calls
            .Where(call => call.Name == "GenerateThumbnailActivity")
            .Select(call => Assert.IsType<ThumbnailRequest>(call.Input))
            .ToArray();
        Assert.Equal(new[] { 128, 256, 512 }, thumbnailRequests.Select(request => request.Size));
        Assert.All(thumbnailRequests, request => Assert.Equal(Hash, request.FileId));

        var downloadInput = Assert.IsType<ProcessingContext>(context.Calls[0].Input);
        Assert.Equal("/temp/uploads/device-1/photo.heic", downloadInput.MegaTempPath);
        Assert.Equal("user-1", downloadInput.UserId);
        Assert.Equal("correlation-1", downloadInput.CorrelationId);
        Assert.Equal(LocalPath, downloadInput.LocalFilePath);
    }

    [Fact]
    public async Task Orchestration_DeduplicatedShortCircuitsStorageAndConversion()
    {
        var context = CreateDeduplicatedContext();

        await new FileProcessingOrchestration().RunOrchestration(context);

        Assert.Equal(
            new[]
            {
                "DownloadFileActivity",
                "ComputeHashActivity",
                "CheckDeduplicationActivity",
                "SendResponseActivity",
                "DeleteLocalTempActivity"
            },
            context.Calls.Select(call => call.Name));

        var response = GetResponse(context);
        Assert.Equal("COMPLETED", response.Status);
        Assert.True(response.Deduplicated);
        Assert.Equal(Hash, response.FileId);
        Assert.Equal(PermanentPath, response.PermanentPath);
        Assert.Equal("image/jpeg", response.ConvertedFormat);
        Assert.Null(response.Error);

        var dedupInput = Assert.IsType<ProcessingContext>(
            context.Calls.Single(call => call.Name == "CheckDeduplicationActivity").Input);
        Assert.Equal(Hash, dedupInput.FileHash);
    }

    [Fact]
    public async Task Orchestration_DownloadFailure_SendsFailedResponseWithoutLocalCleanup()
    {
        var context = CreateContext();
        context.Enqueue("DownloadFileActivity", ActivityResult.Failure("download failed"));
        context.Enqueue("SendResponseActivity", ActivityResult.Success());

        await new FileProcessingOrchestration().RunOrchestration(context);

        Assert.Equal(
            new[] { "DownloadFileActivity", "SendResponseActivity" },
            context.Calls.Select(call => call.Name));

        var response = GetResponse(context);
        Assert.Equal("FAILED", response.Status);
        Assert.Equal("download failed", response.Error);
        Assert.Null(response.PermanentPath);
        Assert.Empty(response.Thumbnails);
    }

    [Fact]
    public async Task Orchestration_HashFailure_SendsFailedResponseAndCleansLocalFile()
    {
        var context = CreateContext();
        context.Enqueue("DownloadFileActivity", ActivityResult.Success(LocalPath));
        context.Enqueue("ComputeHashActivity", ActivityResult.Failure("hash failed"));
        context.Enqueue("SendResponseActivity", ActivityResult.Success());
        context.Enqueue("DeleteLocalTempActivity", ActivityResult.Success());

        await new FileProcessingOrchestration().RunOrchestration(context);

        Assert.Equal(
            new[]
            {
                "DownloadFileActivity",
                "ComputeHashActivity",
                "SendResponseActivity",
                "DeleteLocalTempActivity"
            },
            context.Calls.Select(call => call.Name));

        var response = GetResponse(context);
        Assert.Equal("FAILED", response.Status);
        Assert.Equal("hash failed", response.Error);
        Assert.DoesNotContain(context.Calls, call => call.Name == "CheckDeduplicationActivity");
    }

    [Theory]
    [InlineData("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "does not match")]
    [InlineData("", "empty result")]
    public async Task Orchestration_RejectsInvalidComputedHash(
        string computedHash,
        string expectedError)
    {
        var context = CreateContext();
        context.Enqueue("DownloadFileActivity", ActivityResult.Success(LocalPath));
        context.Enqueue("ComputeHashActivity", ActivityResult.Success(computedHash));
        context.Enqueue("SendResponseActivity", ActivityResult.Success());
        context.Enqueue("DeleteLocalTempActivity", ActivityResult.Success());

        await new FileProcessingOrchestration().RunOrchestration(context);

        var response = GetResponse(context);
        Assert.Equal("FAILED", response.Status);
        Assert.Contains(expectedError, response.Error);
        Assert.DoesNotContain(context.Calls, call => call.Name == "CheckDeduplicationActivity");
    }

    [Fact]
    public async Task Orchestration_ConvertFailure_SendsFailedResponseAndCleansLocalFile()
    {
        var context = CreateContext();
        context.Enqueue("DownloadFileActivity", ActivityResult.Success(LocalPath));
        context.Enqueue("ComputeHashActivity", ActivityResult.Success(Hash));
        context.Enqueue("CheckDeduplicationActivity", ActivityResult.Success(false));
        context.Enqueue("ConvertFormatActivity", ActivityResult.Failure("conversion failed"));
        context.Enqueue("SendResponseActivity", ActivityResult.Success());
        context.Enqueue("DeleteLocalTempActivity", ActivityResult.Success());

        await new FileProcessingOrchestration().RunOrchestration(context);

        Assert.DoesNotContain(context.Calls, call => call.Name == "GenerateThumbnailActivity");
        Assert.DoesNotContain(context.Calls, call => call.Name == "StorePermanentActivity");
        Assert.DoesNotContain(context.Calls, call => call.Name == "DeleteTempFileActivity");
        Assert.Contains(context.Calls, call => call.Name == "DeleteLocalTempActivity");

        var response = GetResponse(context);
        Assert.Equal("FAILED", response.Status);
        Assert.Equal("conversion failed", response.Error);
    }

    [Fact]
    public async Task Orchestration_StoreFailure_SendsFailedResponseAndCleansLocalFile()
    {
        var context = CreateContext();
        EnqueueThroughThumbnails(context);
        context.Enqueue("StorePermanentActivity", ActivityResult.Failure("store failed"));
        context.Enqueue("SendResponseActivity", ActivityResult.Success());
        context.Enqueue("DeleteLocalTempActivity", ActivityResult.Success());

        await new FileProcessingOrchestration().RunOrchestration(context);

        Assert.DoesNotContain(context.Calls, call => call.Name == "DeleteTempFileActivity");
        Assert.Contains(context.Calls, call => call.Name == "DeleteLocalTempActivity");

        var response = GetResponse(context);
        Assert.Equal("FAILED", response.Status);
        Assert.Equal("store failed", response.Error);
    }

    [Fact]
    public async Task Orchestration_ThumbnailFailure_IsNonFatal()
    {
        var context = CreateHappyContext(thumbnailResults: new[]
        {
            ThumbnailSuccess(128),
            ActivityResult.Failure("thumbnail failed"),
            ThumbnailSuccess(512)
        });

        await new FileProcessingOrchestration().RunOrchestration(context);

        var response = GetResponse(context);
        Assert.Equal("COMPLETED", response.Status);
        Assert.Null(response.Error);
        Assert.Equal(2, response.Thumbnails.Count);
        Assert.Contains("128", response.Thumbnails.Keys);
        Assert.Contains("512", response.Thumbnails.Keys);
        Assert.DoesNotContain("256", response.Thumbnails.Keys);
    }

    [Fact]
    public async Task Orchestration_DeleteTempFailure_RetriesOnceAndSucceeds()
    {
        var context = CreateHappyContext(deleteTempResults: new[]
        {
            ActivityResult.Failure("transient Mega failure"),
            ActivityResult.Success()
        });

        await new FileProcessingOrchestration().RunOrchestration(context);

        Assert.Equal(2, context.Calls.Count(call => call.Name == "DeleteTempFileActivity"));
        Assert.Equal("COMPLETED", GetResponse(context).Status);
    }

    [Fact]
    public async Task Orchestration_DeleteTempFinalFailure_IsNonFatal()
    {
        var context = CreateHappyContext(deleteTempResults: new[]
        {
            ActivityResult.Failure("first failure"),
            ActivityResult.Failure("second failure")
        });

        await new FileProcessingOrchestration().RunOrchestration(context);

        Assert.Equal(2, context.Calls.Count(call => call.Name == "DeleteTempFileActivity"));
        var response = GetResponse(context);
        Assert.Equal("COMPLETED", response.Status);
        Assert.Null(response.Error);
    }

    [Fact]
    public async Task Orchestration_LocalCleanupFailure_IsNonFatal()
    {
        var context = CreateHappyContext(
            cleanupResult: ActivityResult.Failure("local cleanup failed"));

        await new FileProcessingOrchestration().RunOrchestration(context);

        Assert.Equal("COMPLETED", GetResponse(context).Status);
    }

    [Fact]
    public async Task Orchestration_WithoutInput_Throws()
    {
        var context = new FakeOrchestrationContext(input: null);

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(
            () => new FileProcessingOrchestration().RunOrchestration(context));

        Assert.Contains(nameof(UploadRequestMessage), exception.Message);
    }

    private static FakeOrchestrationContext CreateContext() =>
        new(CreateRequest());

    private static FakeOrchestrationContext CreateHappyContext(
        ActivityResult[]? thumbnailResults = null,
        ActivityResult[]? deleteTempResults = null,
        ActivityResult? cleanupResult = null)
    {
        var context = CreateContext();
        context.Enqueue("DownloadFileActivity", ActivityResult.Success(LocalPath));
        context.Enqueue("ComputeHashActivity", ActivityResult.Success(Hash));
        context.Enqueue("CheckDeduplicationActivity", ActivityResult.Success(false));
        context.Enqueue("ConvertFormatActivity", ActivityResult.Success(ConvertedPath));
        context.Enqueue(
            "GenerateThumbnailActivity",
            thumbnailResults ?? new[] { ThumbnailSuccess(128), ThumbnailSuccess(256), ThumbnailSuccess(512) });
        context.Enqueue("StorePermanentActivity", ActivityResult.Success(PermanentPath));
        context.Enqueue(
            "DeleteTempFileActivity",
            deleteTempResults ?? new[] { ActivityResult.Success() });
        context.Enqueue("SendResponseActivity", ActivityResult.Success());
        context.Enqueue(
            "DeleteLocalTempActivity",
            cleanupResult ?? ActivityResult.Success());
        return context;
    }

    private static FakeOrchestrationContext CreateDeduplicatedContext()
    {
        var context = new FakeOrchestrationContext(CreateRequest(new string('A', 64)));
        context.Enqueue("DownloadFileActivity", ActivityResult.Success(LocalPath));
        context.Enqueue("ComputeHashActivity", ActivityResult.Success(Hash));
        context.Enqueue("CheckDeduplicationActivity", ActivityResult.Success(true));
        context.Enqueue("SendResponseActivity", ActivityResult.Success());
        context.Enqueue("DeleteLocalTempActivity", ActivityResult.Success());
        return context;
    }

    private static void EnqueueThroughThumbnails(FakeOrchestrationContext context)
    {
        context.Enqueue("DownloadFileActivity", ActivityResult.Success(LocalPath));
        context.Enqueue("ComputeHashActivity", ActivityResult.Success(Hash));
        context.Enqueue("CheckDeduplicationActivity", ActivityResult.Success(false));
        context.Enqueue("ConvertFormatActivity", ActivityResult.Success(ConvertedPath));
        context.Enqueue(
            "GenerateThumbnailActivity",
            ThumbnailSuccess(128),
            ThumbnailSuccess(256),
            ThumbnailSuccess(512));
    }

    private static ActivityResult ThumbnailSuccess(int size) =>
        ActivityResult.Success(new Dictionary<string, string>
        {
            [size.ToString()] = $"/thumbs/user-1/{size}/{Hash}.jpg"
        });

    private static UploadResponseMessage GetResponse(FakeOrchestrationContext context)
    {
        var call = Assert.Single(context.Calls, call => call.Name == "SendResponseActivity");
        return Assert.IsType<UploadResponseMessage>(call.Input);
    }

    private static UploadRequestMessage CreateRequest(string? suppliedHash = null) => new()
    {
        MessageId = "message-1",
        FileId = suppliedHash ?? Hash,
        FileName = "photo.heic",
        FileSize = 128,
        MimeType = "image/heic",
        MegaTempPath = "/temp/uploads/device-1/photo.heic",
        UserId = "user-1",
        DeviceId = "device-1",
        CorrelationId = "correlation-1",
        Version = 1
    };

    private sealed record OrchestrationCall(string Name, object? Input);

    private sealed class FakeOrchestrationContext : TaskOrchestrationContext
    {
        private readonly UploadRequestMessage? _input;
        private readonly DateTime _now;
        private readonly Dictionary<string, Queue<ActivityResult>> _results = new(StringComparer.Ordinal);

        public FakeOrchestrationContext(UploadRequestMessage? input, DateTime? now = null)
        {
            _input = input;
            _now = now ?? new DateTime(2026, 10, 29, 12, 0, 0, DateTimeKind.Utc);
        }

        public List<OrchestrationCall> Calls { get; } = new();

        public override TaskName Name => new(nameof(FileProcessingOrchestration));

        public override string InstanceId => "instance-1";

        public override ParentOrchestrationInstance? Parent => null;

        public override DateTime CurrentUtcDateTime => _now;

        public override bool IsReplaying => false;

        protected override ILoggerFactory LoggerFactory => NullLoggerFactory.Instance;

        public override T GetInput<T>() => _input is T input ? input : default!;

        public override Task<TResult> CallActivityAsync<TResult>(
            TaskName name,
            object? input = null,
            TaskOptions? options = null)
        {
            Calls.Add(new OrchestrationCall(name.Name, input));

            if (!_results.TryGetValue(name.Name, out var queue) || queue.Count == 0)
                throw new InvalidOperationException($"No activity result configured for {name.Name}.");

            var result = queue.Dequeue();
            return Task.FromResult((TResult)(object)result);
        }

        public void Enqueue(string activityName, params ActivityResult[] results)
        {
            if (!_results.TryGetValue(activityName, out var queue))
            {
                queue = new Queue<ActivityResult>();
                _results[activityName] = queue;
            }

            foreach (var result in results)
                queue.Enqueue(result);
        }

        public override Task CreateTimer(DateTime fireAt, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public override Task<T> WaitForExternalEvent<T>(
            string eventName,
            CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public override void SendEvent(string instanceId, string eventName, object payload) =>
            throw new NotSupportedException();

        public override void SetCustomStatus(object? customStatus) =>
            throw new NotSupportedException();

        public override Task<TResult> CallSubOrchestratorAsync<TResult>(
            TaskName orchestratorName,
            object? input = null,
            TaskOptions? options = null) =>
            throw new NotSupportedException();

        public override void ContinueAsNew(object? newInput = null, bool preserveUnprocessedEvents = true) =>
            throw new NotSupportedException();

        public override Guid NewGuid() => Guid.NewGuid();
    }
}
