using System.Security.Claims;
using System.Text;
using Microsoft.Azure.Functions.Worker;
using Microsoft.DurableTask;
using Microsoft.DurableTask.Client;
using Microsoft.Extensions.Logging;
using StashHost.Functions.Functions;
using StashHost.Functions.Middleware;
using StashHost.Functions.Orchestrations;
using StashHost.Functions.Services;
using StashHost.Shared.Contracts;
using StashHost.Shared.Messages;

namespace StashHost.Tests;

public class Phase7KafkaTriggerTests
{
    private static readonly string Hash = new('a', 64);

    [Fact]
    public async Task KafkaTrigger_ValidMessage_SchedulesOrchestrationWithCorrelationIdAndJwtIdentity()
    {
        var request = CreateValidRequest();
        request.UserId = string.Empty;
        request.DeviceId = string.Empty;
        var jwt = new FakeJwtValidator { Result = CreatePrincipal() };
        var producer = new FakeKafkaProducer();
        var client = new FakeDurableTaskClient();
        var function = CreateFunction(jwt, producer);

        await function.Run(
            new[] { CreateRecord(request) },
            client,
            null!,
            CancellationToken.None);

        Assert.Empty(producer.DeadLetters);
        var scheduled = Assert.Single(client.Scheduled);
        Assert.Equal(nameof(FileProcessingOrchestration), scheduled.Name.Name);
        Assert.Equal("correlation-1", scheduled.Options?.InstanceId);

        var scheduledRequest = Assert.IsType<UploadRequestMessage>(scheduled.Input);
        Assert.Equal("user-1", scheduledRequest.UserId);
        Assert.Equal("device-1", scheduledRequest.DeviceId);
        Assert.Equal(new[] { "correlation-1" }, client.QueriedInstanceIds);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-json")]
    [InlineData("null")]
    public async Task KafkaTrigger_InvalidPayload_DeadLetters(string payload)
    {
        var producer = new FakeKafkaProducer();
        var client = new FakeDurableTaskClient();
        var function = CreateFunction(new FakeJwtValidator(), producer);

        await function.Run(
            new[] { CreateRawRecord(payload) },
            client,
            null!,
            CancellationToken.None);

        var deadLetter = Assert.Single(producer.DeadLetters);
        Assert.Equal("Invalid or empty upload request payload", deadLetter.Reason);
        Assert.Empty(client.Scheduled);
    }

    [Fact]
    public async Task KafkaTrigger_ValidationFailure_DeadLetters()
    {
        var request = CreateValidRequest();
        request.FileSize = 0;
        var producer = new FakeKafkaProducer();
        var client = new FakeDurableTaskClient();
        var function = CreateFunction(new FakeJwtValidator { Result = CreatePrincipal() }, producer);

        await function.Run(
            new[] { CreateRecord(request) },
            client,
            null!,
            CancellationToken.None);

        var deadLetter = Assert.Single(producer.DeadLetters);
        Assert.Contains("File size must be greater than zero", deadLetter.Reason);
        Assert.Empty(client.Scheduled);
    }

    [Fact]
    public async Task KafkaTrigger_MissingJwt_DeadLetters()
    {
        var producer = new FakeKafkaProducer();
        var client = new FakeDurableTaskClient();
        var function = CreateFunction(
            new FakeJwtValidator { Result = null },
            producer);

        await function.Run(
            new[] { CreateRecord(CreateValidRequest()) },
            client,
            null!,
            CancellationToken.None);

        var deadLetter = Assert.Single(producer.DeadLetters);
        Assert.Equal("Missing or invalid JWT", deadLetter.Reason);
        Assert.Empty(client.Scheduled);
    }

    [Fact]
    public async Task KafkaTrigger_JwtMissingIdentityClaims_DeadLetters()
    {
        var producer = new FakeKafkaProducer();
        var client = new FakeDurableTaskClient();
        var function = CreateFunction(
            new FakeJwtValidator
            {
                Result = new ClaimsPrincipal(new ClaimsIdentity(Array.Empty<Claim>(), "Test"))
            },
            producer);

        await function.Run(
            new[] { CreateRecord(CreateValidRequest()) },
            client,
            null!,
            CancellationToken.None);

        var deadLetter = Assert.Single(producer.DeadLetters);
        Assert.Equal("JWT is missing userId or deviceId claims", deadLetter.Reason);
        Assert.Empty(client.Scheduled);
    }

    [Theory]
    [InlineData("userId")]
    [InlineData("deviceId")]
    public async Task KafkaTrigger_PayloadIdentityMismatch_DeadLetters(string field)
    {
        var request = CreateValidRequest();
        if (field == "userId")
            request.UserId = "other-user";
        else
            request.DeviceId = "other-device";

        var producer = new FakeKafkaProducer();
        var client = new FakeDurableTaskClient();
        var function = CreateFunction(new FakeJwtValidator { Result = CreatePrincipal() }, producer);

        await function.Run(
            new[] { CreateRecord(request) },
            client,
            null!,
            CancellationToken.None);

        var deadLetter = Assert.Single(producer.DeadLetters);
        Assert.Contains(field, deadLetter.Reason);
        Assert.Empty(client.Scheduled);
    }

    [Fact]
    public async Task KafkaTrigger_HeaderIdentityMismatch_DeadLetters()
    {
        var producer = new FakeKafkaProducer();
        var client = new FakeDurableTaskClient();
        var function = CreateFunction(new FakeJwtValidator { Result = CreatePrincipal() }, producer);
        var record = CreateRecord(
            CreateValidRequest(),
            extraHeaders: new[]
            {
                new KafkaHeader
                {
                    Key = "X-User-Id",
                    Value = Encoding.UTF8.GetBytes("other-user")
                }
            });

        await function.Run(
            new[] { record },
            client,
            null!,
            CancellationToken.None);

        var deadLetter = Assert.Single(producer.DeadLetters);
        Assert.Equal("X-User-Id header does not match the JWT", deadLetter.Reason);
        Assert.Empty(client.Scheduled);
    }

    [Fact]
    public async Task KafkaTrigger_DeviceHeaderMismatch_DeadLetters()
    {
        var producer = new FakeKafkaProducer();
        var client = new FakeDurableTaskClient();
        var function = CreateFunction(new FakeJwtValidator { Result = CreatePrincipal() }, producer);
        var record = CreateRecord(
            CreateValidRequest(),
            extraHeaders: new[]
            {
                new KafkaHeader
                {
                    Key = "X-Device-Id",
                    Value = Encoding.UTF8.GetBytes("other-device")
                }
            });

        await function.Run(
            new[] { record },
            client,
            null!,
            CancellationToken.None);

        var deadLetter = Assert.Single(producer.DeadLetters);
        Assert.Equal("X-Device-Id header does not match the JWT", deadLetter.Reason);
        Assert.Empty(client.Scheduled);
    }

    [Fact]
    public async Task KafkaTrigger_CorrelationHeaderMismatch_DeadLetters()
    {
        var producer = new FakeKafkaProducer();
        var client = new FakeDurableTaskClient();
        var function = CreateFunction(new FakeJwtValidator { Result = CreatePrincipal() }, producer);
        var record = CreateRecord(
            CreateValidRequest(),
            extraHeaders: new[]
            {
                new KafkaHeader
                {
                    Key = "X-Correlation-Id",
                    Value = Encoding.UTF8.GetBytes("other-correlation")
                }
            });

        await function.Run(
            new[] { record },
            client,
            null!,
            CancellationToken.None);

        var deadLetter = Assert.Single(producer.DeadLetters);
        Assert.Equal("X-Correlation-Id header does not match the message", deadLetter.Reason);
        Assert.Empty(client.Scheduled);
    }

    [Fact]
    public async Task KafkaTrigger_MissingMessageKey_DeadLetters()
    {
        var producer = new FakeKafkaProducer();
        var client = new FakeDurableTaskClient();
        var function = CreateFunction(new FakeJwtValidator { Result = CreatePrincipal() }, producer);

        await function.Run(
            new[] { CreateRecord(CreateValidRequest(), key: string.Empty) },
            client,
            null!,
            CancellationToken.None);

        var deadLetter = Assert.Single(producer.DeadLetters);
        Assert.Equal("Kafka message key is missing", deadLetter.Reason);
        Assert.Empty(client.Scheduled);
    }

    [Fact]
    public async Task KafkaTrigger_MessageKeyMismatch_DeadLetters()
    {
        var producer = new FakeKafkaProducer();
        var client = new FakeDurableTaskClient();
        var function = CreateFunction(new FakeJwtValidator { Result = CreatePrincipal() }, producer);

        await function.Run(
            new[] { CreateRecord(CreateValidRequest(), key: new string('b', 64)) },
            client,
            null!,
            CancellationToken.None);

        var deadLetter = Assert.Single(producer.DeadLetters);
        Assert.Equal("Kafka message key does not match the file hash", deadLetter.Reason);
        Assert.Empty(client.Scheduled);
    }

    [Fact]
    public async Task KafkaTrigger_ExistingOrchestration_SkipsDuplicateMessage()
    {
        var producer = new FakeKafkaProducer();
        var client = new FakeDurableTaskClient();
        client.ExistingInstanceIds.Add("correlation-1");
        var function = CreateFunction(new FakeJwtValidator { Result = CreatePrincipal() }, producer);

        await function.Run(
            new[] { CreateRecord(CreateValidRequest()) },
            client,
            null!,
            CancellationToken.None);

        Assert.Empty(client.Scheduled);
        Assert.Empty(producer.DeadLetters);
        Assert.Equal(new[] { "correlation-1" }, client.QueriedInstanceIds);
    }

    [Fact]
    public async Task KafkaTrigger_DlqProducerFailure_IsLoggedAndDoesNotThrow()
    {
        var producer = new FakeKafkaProducer { ThrowOnDeadLetter = true };
        var client = new FakeDurableTaskClient();
        var logger = new RecordingLogger<KafkaTriggerFunction>();
        var function = CreateFunction(new FakeJwtValidator(), producer, logger);

        await function.Run(
            new[] { CreateRawRecord("not-json") },
            client,
            null!,
            CancellationToken.None);

        Assert.Empty(client.Scheduled);
        Assert.Contains(logger.Entries, entry => entry.Level == LogLevel.Error);
        Assert.Contains(logger.Entries, entry => entry.Message.Contains("stash.dlq"));
    }

    [Fact]
    public async Task KafkaTrigger_OneBadRecord_DoesNotStopLaterRecords()
    {
        var producer = new FakeKafkaProducer();
        var client = new FakeDurableTaskClient();
        var function = CreateFunction(new FakeJwtValidator { Result = CreatePrincipal() }, producer);

        await function.Run(
            new[]
            {
                CreateRawRecord("not-json"),
                CreateRecord(CreateValidRequest())
            },
            client,
            null!,
            CancellationToken.None);

        Assert.Single(producer.DeadLetters);
        Assert.Single(client.Scheduled);
    }

    private static KafkaTriggerFunction CreateFunction(
        FakeJwtValidator jwt,
        FakeKafkaProducer producer,
        RecordingLogger<KafkaTriggerFunction>? logger = null) =>
        new(logger ?? new RecordingLogger<KafkaTriggerFunction>(), jwt, producer);

    private static UploadRequestMessage CreateValidRequest() => new()
    {
        MessageId = "message-1",
        FileId = Hash,
        FileName = "photo.heic",
        FileSize = 128,
        MimeType = "image/heic",
        MegaTempPath = "/temp/uploads/device-1/photo.heic",
        UserId = "user-1",
        DeviceId = "device-1",
        CorrelationId = "correlation-1",
        Version = 1
    };

    private static ClaimsPrincipal CreatePrincipal() =>
        new(new ClaimsIdentity(
            new[]
            {
                new Claim("userId", "user-1"),
                new Claim("deviceId", "device-1")
            },
            "Test"));

    private static KafkaRecord CreateRecord(
        UploadRequestMessage request,
        string? key = null,
        IEnumerable<KafkaHeader>? extraHeaders = null) =>
        new()
        {
            Topic = "stash.upload.request",
            Partition = 0,
            Offset = 1,
            Key = Encoding.UTF8.GetBytes(key ?? request.FileId),
            Value = Encoding.UTF8.GetBytes(KafkaJson.Serialize(request)),
            Headers = new[]
            {
                new KafkaHeader
                {
                    Key = "Authorization",
                    Value = Encoding.UTF8.GetBytes("Bearer test-token")
                }
            }.Concat(extraHeaders ?? Array.Empty<KafkaHeader>()).ToArray()
        };

    private static KafkaRecord CreateRawRecord(string payload, string? key = null) =>
        new()
        {
            Topic = "stash.upload.request",
            Partition = 0,
            Offset = 1,
            Key = Encoding.UTF8.GetBytes(key ?? Hash),
            Value = Encoding.UTF8.GetBytes(payload),
            Headers = Array.Empty<KafkaHeader>()
        };

    private sealed record DeadLetter(string Key, string Payload, string Reason);

    private sealed record ScheduledOrchestration(
        TaskName Name,
        object? Input,
        StartOrchestrationOptions? Options);

    private sealed record LogEntry(LogLevel Level, string Message, Exception? Exception);

    private sealed class FakeJwtValidator : IJwtValidator
    {
        public ClaimsPrincipal? Result { get; set; }

        public IDictionary<string, object>? LastHeaders { get; private set; }

        public ClaimsPrincipal? Validate(IDictionary<string, object> headers)
        {
            LastHeaders = headers;
            return Result;
        }
    }

    private sealed class FakeKafkaProducer : IKafkaProducer
    {
        public List<DeadLetter> DeadLetters { get; } = new();

        public bool ThrowOnDeadLetter { get; set; }

        public Task ProduceUploadRequestAsync(UploadRequestMessage message, CancellationToken ct) =>
            Task.CompletedTask;

        public Task ProduceUploadResponseAsync(UploadResponseMessage message, CancellationToken ct) =>
            Task.CompletedTask;

        public Task ProduceDeadLetterAsync(
            string key,
            string payload,
            string reason,
            CancellationToken ct)
        {
            if (ThrowOnDeadLetter)
                throw new InvalidOperationException("DLQ unavailable");

            DeadLetters.Add(new DeadLetter(key, payload, reason));
            return Task.CompletedTask;
        }
    }

    private sealed class FakeDurableTaskClient : DurableTaskClient
    {
        public FakeDurableTaskClient() : base("test-client")
        {
        }

        public List<ScheduledOrchestration> Scheduled { get; } = new();

        public List<string> QueriedInstanceIds { get; } = new();

        public HashSet<string> ExistingInstanceIds { get; } = new(StringComparer.Ordinal);

        public override Task<string> ScheduleNewOrchestrationInstanceAsync(
            TaskName orchestratorName,
            object? input = null,
            StartOrchestrationOptions? options = null,
            CancellationToken cancellation = default)
        {
            Scheduled.Add(new ScheduledOrchestration(orchestratorName, input, options));
            return Task.FromResult(options?.InstanceId ?? "generated-instance");
        }

        public override Task<OrchestrationMetadata?> GetInstancesAsync(
            string instanceId,
            bool getInputsAndOutputs = false,
            CancellationToken cancellation = default)
        {
            QueriedInstanceIds.Add(instanceId);
            return Task.FromResult(
                ExistingInstanceIds.Contains(instanceId)
                    ? new OrchestrationMetadata(nameof(FileProcessingOrchestration), instanceId)
                    : null);
        }

        public override Task RaiseEventAsync(
            string instanceId,
            string eventName,
            object? eventPayload = null,
            CancellationToken cancellation = default) =>
            throw new NotSupportedException();

        public override Task<OrchestrationMetadata> WaitForInstanceStartAsync(
            string instanceId,
            bool getInputsAndOutputs = false,
            CancellationToken cancellation = default) =>
            throw new NotSupportedException();

        public override Task<OrchestrationMetadata> WaitForInstanceCompletionAsync(
            string instanceId,
            bool getInputsAndOutputs = false,
            CancellationToken cancellation = default) =>
            throw new NotSupportedException();

        public override Task SuspendInstanceAsync(
            string instanceId,
            string? reason = null,
            CancellationToken cancellation = default) =>
            throw new NotSupportedException();

        public override Task ResumeInstanceAsync(
            string instanceId,
            string? reason = null,
            CancellationToken cancellation = default) =>
            throw new NotSupportedException();

        public override AsyncPageable<OrchestrationMetadata> GetAllInstancesAsync(
            OrchestrationQuery? filter = null) =>
            throw new NotSupportedException();

        public override ValueTask DisposeAsync() => default;
    }

    private sealed class RecordingLogger<T> : ILogger<T>
    {
        public List<LogEntry> Entries { get; } = new();

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            Entries.Add(new LogEntry(logLevel, formatter(state, exception), exception));
        }
    }
}
