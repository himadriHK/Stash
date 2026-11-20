using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Stash.Maui.Auth;
using Stash.Maui.Configuration;
using Stash.Maui.Data;
using Stash.Maui.Data.Entities;
using Stash.Maui.Data.Repositories;
using Stash.Maui.Services;
using StashHost.Shared.Contracts;
using StashHost.Shared.Messages;

namespace Stash.Maui.Tests;

public class Phase4KafkaTests
{
    private const string FileHash =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    [Fact]
    public async Task ProduceUploadRequestAsync_UsesHashKeyAndRequiredHeaders()
    {
        var transport = new FakeKafkaTransport();
        var authentication = new FakeAuthenticationService();
        var producer = CreateProducer(transport, authentication);

        var message = new UploadRequestMessage
        {
            FileId = FileHash,
            FileName = "photo.jpg",
            FileSize = 42,
            MimeType = "image/jpeg",
            MegaTempPath = "/temp/uploads/device-1/photo.jpg",
            DeviceId = "device-1",
            UserId = "user-1",
            CorrelationId = "correlation-1"
        };

        await producer.ProduceUploadRequestAsync(message, CancellationToken.None);

        var produced = Assert.Single(transport.Produced);
        Assert.Equal("stash.upload.request", produced.Topic);
        Assert.Equal(FileHash, produced.Key);
        Assert.Equal("Bearer access-token", produced.Headers["Authorization"]);
        Assert.Equal("device-1", produced.Headers["X-Device-Id"]);
        Assert.Equal("user-1", produced.Headers["X-User-Id"]);
        Assert.Equal("correlation-1", produced.Headers["X-Correlation-Id"]);
        Assert.Equal("1", produced.Headers["X-Message-Version"]);
        Assert.Contains("\"fileId\"", produced.Value);

        var deserialized = MobileKafkaJson.Deserialize<UploadRequestMessage>(produced.Value);
        Assert.NotNull(deserialized);
        Assert.Equal(FileHash, deserialized!.FileId);
        Assert.Equal("photo.jpg", deserialized.FileName);
        Assert.Equal("device-1", deserialized.DeviceId);
        Assert.Equal("user-1", deserialized.UserId);
    }

    [Fact]
    public async Task ProduceUploadRequestAsync_FailsWhenNoAccessTokenIsAvailable()
    {
        var transport = new FakeKafkaTransport();
        var authentication = new FakeAuthenticationService { AccessToken = string.Empty };
        var producer = CreateProducer(transport, authentication);

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(
            () => producer.ProduceUploadRequestAsync(
                new UploadRequestMessage { FileId = FileHash },
                CancellationToken.None));

        Assert.Contains("access token", exception.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Empty(transport.Produced);
    }

    [Fact]
    public async Task ConsumeUploadResponsesAsync_UsesResponseTopicAndDeviceGroup_AndUpdatesFile()
    {
        using var cts = new CancellationTokenSource();
        var file = new FileEntity
        {
            ContentHash = FileHash,
            Status = UploadStatus.Uploaded
        };
        var repository = new FakeFileRepository(file);
        var transport = new FakeKafkaTransport
        {
            OnConsume = async (onRecord, ct) =>
            {
                await onRecord(
                    CreateRecord(new
                    {
                        fileId = FileHash,
                        status = "COMPLETED",
                        permanentPath = "/photos/2026/photo.jpg",
                        thumbnails = new Dictionary<string, string>
                        {
                            ["128"] = "/photos/thumb/photo-128.jpg",
                            ["256"] = "/photos/thumb/photo-256.jpg"
                        },
                        convertedFormat = "jpg",
                        deduplicated = true,
                        error = (string?)null
                    }),
                    ct);
                cts.Cancel();
            }
        };
        var consumer = CreateConsumer(transport, repository);

        await consumer.ConsumeUploadResponsesAsync(cts.Token);

        Assert.Equal("stash.upload.response", transport.ConsumedTopic);
        Assert.Equal("stash-mobile-device-1", transport.ConsumedGroupId);
        Assert.Equal(1, repository.UpdateCount);
        Assert.Equal(UploadStatus.Completed, file.Status);
        Assert.Equal("/photos/2026/photo.jpg", file.PermanentPath);
        Assert.Equal(2, file.Thumbnails.Count);
        Assert.Equal("/photos/thumb/photo-256.jpg", file.Thumbnails["256"]);
        Assert.Equal("jpg", file.ConvertedFormat);
        Assert.True(file.IsDeduplicated);
        Assert.Null(file.ErrorMessage);
        Assert.NotNull(file.LastAttemptAt);
    }

    [Fact]
    public async Task ConsumeUploadResponsesAsync_MapsFailedResponse()
    {
        using var cts = new CancellationTokenSource();
        var file = new FileEntity
        {
            ContentHash = FileHash,
            Status = UploadStatus.Uploading
        };
        var repository = new FakeFileRepository(file);
        var transport = new FakeKafkaTransport
        {
            OnConsume = async (onRecord, ct) =>
            {
                await onRecord(
                    CreateRecord(new
                    {
                        fileId = FileHash,
                        status = "FAILED",
                        permanentPath = (string?)null,
                        thumbnails = new Dictionary<string, string>(),
                        convertedFormat = (string?)null,
                        deduplicated = false,
                        error = "Conversion failed"
                    }),
                    ct);
                cts.Cancel();
            }
        };
        var consumer = CreateConsumer(transport, repository);

        await consumer.ConsumeUploadResponsesAsync(cts.Token);

        Assert.Equal(UploadStatus.Failed, file.Status);
        Assert.Null(file.PermanentPath);
        Assert.Empty(file.Thumbnails);
        Assert.Null(file.ConvertedFormat);
        Assert.False(file.IsDeduplicated);
        Assert.Equal("Conversion failed", file.ErrorMessage);
    }

    [Fact]
    public async Task ConsumeUploadResponsesAsync_ParsesPascalCasePayloads()
    {
        using var cts = new CancellationTokenSource();
        var file = new FileEntity
        {
            ContentHash = FileHash,
            Status = UploadStatus.Uploaded
        };
        var repository = new FakeFileRepository(file);
        var transport = new FakeKafkaTransport
        {
            OnConsume = async (onRecord, ct) =>
            {
                await onRecord(
                    CreateRecord(
                        """
                        {
                          "FileId": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                          "Status": "COMPLETED",
                          "PermanentPath": "/photos/pascal.jpg",
                          "Thumbnails": { "512": "/photos/thumb/pascal-512.jpg" },
                          "ConvertedFormat": "webp",
                          "Deduplicated": true,
                          "Error": null
                        }
                        """),
                    ct);
                cts.Cancel();
            }
        };
        var consumer = CreateConsumer(transport, repository);

        await consumer.ConsumeUploadResponsesAsync(cts.Token);

        Assert.Equal(UploadStatus.Completed, file.Status);
        Assert.Equal("/photos/pascal.jpg", file.PermanentPath);
        Assert.Equal("/photos/thumb/pascal-512.jpg", file.Thumbnails["512"]);
        Assert.Equal("webp", file.ConvertedFormat);
        Assert.True(file.IsDeduplicated);
    }

    [Fact]
    public async Task KafkaRestTransport_Produce_MapsRequestToV3RecordApi()
    {
        var handler = new RecordingHttpMessageHandler
        {
            ResponseFactory = _ => JsonResponse("""{"error_code":0}""")
        };
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("https://rest.test/")
        };
        var config = new StashConfig
        {
            Kafka = new KafkaConfig
            {
                RestUrl = "https://rest.test/",
                ClusterId = "cluster-1",
                RestUsername = "rest-user",
                RestPassword = "rest-pass"
            }
        };
        using var transport = new KafkaRestTransport(
            httpClient,
            config,
            NullLogger<KafkaRestTransport>.Instance);

        await transport.ProduceAsync(
            new KafkaTransportMessage(
                "stash.upload.request",
                FileHash,
                """{"fileId":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}""",
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                {
                    ["Authorization"] = "Bearer access-token",
                    ["X-Device-Id"] = "device-1",
                    ["X-User-Id"] = "user-1",
                    ["X-Correlation-Id"] = "correlation-1",
                    ["X-Message-Version"] = "1"
                }));

        var request = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal(
            "https://rest.test/v3/clusters/cluster-1/topics/stash.upload.request/records",
            request.Uri.ToString());
        Assert.Equal("application/json", request.ContentType);
        Assert.Equal("Basic", request.HttpAuthorizationScheme);
        Assert.NotNull(request.Body);

        using var body = JsonDocument.Parse(request.Body!);
        var root = body.RootElement;
        Assert.Equal("BINARY", root.GetProperty("key").GetProperty("type").GetString());
        Assert.Equal(
            Convert.ToBase64String(Encoding.UTF8.GetBytes(FileHash)),
            root.GetProperty("key").GetProperty("data").GetString());
        Assert.Equal("JSON", root.GetProperty("value").GetProperty("type").GetString());
        Assert.Equal(
            FileHash,
            root.GetProperty("value").GetProperty("data").GetProperty("fileId").GetString());

        var headers = root.GetProperty("headers").EnumerateArray()
            .ToDictionary(
                header => header.GetProperty("name").GetString()!,
                header => header.GetProperty("value").GetString()!);
        Assert.Equal(
            Convert.ToBase64String(Encoding.UTF8.GetBytes("Bearer access-token")),
            headers["Authorization"]);
        Assert.Equal(
            Convert.ToBase64String(Encoding.UTF8.GetBytes("device-1")),
            headers["X-Device-Id"]);
        Assert.Equal(
            Convert.ToBase64String(Encoding.UTF8.GetBytes("user-1")),
            headers["X-User-Id"]);
        Assert.Equal(
            Convert.ToBase64String(Encoding.UTF8.GetBytes("correlation-1")),
            headers["X-Correlation-Id"]);
        Assert.Equal(
            Convert.ToBase64String(Encoding.UTF8.GetBytes("1")),
            headers["X-Message-Version"]);
    }

    [Fact]
    public async Task KafkaRestTransport_Consume_CreatesConsumerSubscribesAndReadsRecords()
    {
        var handler = new RecordingHttpMessageHandler
        {
            ResponseFactory = request =>
            {
                var path = request.RequestUri!.AbsolutePath;
                if (request.Method == HttpMethod.Post
                    && path == "/consumers/stash-mobile-device-1")
                {
                    return JsonResponse(
                        """
                        {
                          "instance_id": "instance-1",
                          "base_uri": "https://rest.test/consumers/stash-mobile-device-1/instances/instance-1"
                        }
                        """);
                }

                if (request.Method == HttpMethod.Post
                    && path.EndsWith("/subscription", StringComparison.Ordinal))
                {
                    return new HttpResponseMessage(HttpStatusCode.NoContent);
                }

                if (request.Method == HttpMethod.Get
                    && path.EndsWith("/records", StringComparison.Ordinal))
                {
                    return JsonResponse(
                        """
                        [
                          {
                            "topic": "stash.upload.response",
                            "key": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                            "value": {
                              "fileId": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                              "status": "COMPLETED"
                            }
                          }
                        ]
                        """);
                }

                if (request.Method == HttpMethod.Delete)
                    return new HttpResponseMessage(HttpStatusCode.NoContent);

                return new HttpResponseMessage(HttpStatusCode.NotFound);
            }
        };
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("https://rest.test/")
        };
        var config = new StashConfig
        {
            Kafka = new KafkaConfig
            {
                RestUrl = "https://rest.test/",
                ClusterId = "cluster-1"
            }
        };
        using var transport = new KafkaRestTransport(
            httpClient,
            config,
            NullLogger<KafkaRestTransport>.Instance);
        using var cts = new CancellationTokenSource();
        var records = new List<KafkaTransportRecord>();

        await transport.ConsumeAsync(
            "stash.upload.response",
            "stash-mobile-device-1",
            async (record, ct) =>
            {
                records.Add(record);
                cts.Cancel();
                await Task.CompletedTask;
            },
            cts.Token);

        var record = Assert.Single(records);
        Assert.Equal("stash.upload.response", record.Topic);
        Assert.Equal(FileHash, record.Key);
        using var recordJson = JsonDocument.Parse(record.Value);
        Assert.Equal(
            "COMPLETED",
            recordJson.RootElement.GetProperty("status").GetString());

        Assert.Contains(
            handler.Requests,
            request => request.Method == HttpMethod.Post
                && request.Uri.AbsolutePath == "/consumers/stash-mobile-device-1");
        Assert.Contains(
            handler.Requests,
            request => request.Method == HttpMethod.Post
                && request.Uri.AbsolutePath.EndsWith(
                    "/instances/instance-1/subscription",
                    StringComparison.Ordinal));
        Assert.Contains(
            handler.Requests,
            request => request.Method == HttpMethod.Get
                && request.Uri.AbsolutePath.EndsWith(
                    "/instances/instance-1/records",
                    StringComparison.Ordinal));
        Assert.Contains(
            handler.Requests,
            request => request.Method == HttpMethod.Delete);
    }

    [Fact]
    public async Task AddStashKafkaServices_RegistersProducerAndConsumer()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<ISecureStorageService, InMemorySecureStorage>();
        services.AddStashServices(new ConfigurationBuilder().Build());
        services.AddStashData(Path.Combine(
            Path.GetTempPath(),
            "stash-kafka-di",
            Guid.NewGuid().ToString("N") + ".db"));
        services.AddStashUploadServices();
        services.AddStashKafkaServices();

        await using var provider = services.BuildServiceProvider();
        Assert.IsType<KafkaProducer>(provider.GetRequiredService<IKafkaProducer>());
        Assert.IsType<KafkaConsumer>(provider.GetRequiredService<IKafkaConsumer>());
    }

    private static KafkaProducer CreateProducer(
        FakeKafkaTransport transport,
        FakeAuthenticationService authentication)
    {
        var config = new StashConfig();
        return new KafkaProducer(
            transport,
            authentication,
            config,
            NullLogger<KafkaProducer>.Instance);
    }

    private static KafkaConsumer CreateConsumer(
        FakeKafkaTransport transport,
        FakeFileRepository repository)
    {
        return new KafkaConsumer(
            transport,
            new FakeAuthenticationService(),
            repository,
            new StashConfig(),
            NullLogger<KafkaConsumer>.Instance);
    }

    private static KafkaTransportRecord CreateRecord(object value)
    {
        return new KafkaTransportRecord(
            "stash.upload.response",
            FileHash,
            JsonSerializer.Serialize(value, MobileKafkaJson.Options),
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase));
    }

    private static KafkaTransportRecord CreateRecord(string value)
    {
        return new KafkaTransportRecord(
            "stash.upload.response",
            FileHash,
            value,
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase));
    }

    private static HttpResponseMessage JsonResponse(string json)
    {
        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
    }

    private sealed class FakeKafkaTransport : IKafkaTransport
    {
        public List<KafkaTransportMessage> Produced { get; } = new();

        public string? ConsumedTopic { get; private set; }

        public string? ConsumedGroupId { get; private set; }

        public Func<Func<KafkaTransportRecord, CancellationToken, Task>, CancellationToken, Task>?
            OnConsume { get; set; }

        public Task ProduceAsync(KafkaTransportMessage message, CancellationToken ct = default)
        {
            Produced.Add(message);
            return Task.CompletedTask;
        }

        public async Task ConsumeAsync(
            string topic,
            string groupId,
            Func<KafkaTransportRecord, CancellationToken, Task> onRecord,
            CancellationToken ct = default)
        {
            ConsumedTopic = topic;
            ConsumedGroupId = groupId;

            if (OnConsume is not null)
            {
                await OnConsume(onRecord, ct);
                return;
            }

            await Task.Delay(Timeout.InfiniteTimeSpan, ct);
        }
    }

    private sealed class InMemorySecureStorage : ISecureStorageService
    {
        private readonly Dictionary<string, string> _values = new();

        public Task SetAsync(string key, string value, CancellationToken ct = default)
        {
            _values[key] = value;
            return Task.CompletedTask;
        }

        public Task<string?> GetAsync(string key, CancellationToken ct = default) =>
            Task.FromResult(_values.TryGetValue(key, out var value) ? value : null);

        public Task RemoveAsync(string key, CancellationToken ct = default)
        {
            _values.Remove(key);
            return Task.CompletedTask;
        }
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

    private sealed class FakeFileRepository : IFileRepository
    {
        private readonly FileEntity? _file;

        public FakeFileRepository(FileEntity? file)
        {
            _file = file;
        }

        public int UpdateCount { get; private set; }

        public Task<FileEntity?> GetByIdAsync(Guid id, CancellationToken ct = default) =>
            Task.FromResult(_file?.Id == id ? _file : null);

        public Task<FileEntity?> GetByContentHashAsync(
            string contentHash,
            CancellationToken ct = default) =>
            Task.FromResult(
                _file is not null
                && string.Equals(_file.ContentHash, contentHash, StringComparison.OrdinalIgnoreCase)
                    ? _file
                    : null);

        public Task<IReadOnlyList<FileEntity>> GetAllAsync(CancellationToken ct = default) =>
            Task.FromResult<IReadOnlyList<FileEntity>>(
                _file is null ? Array.Empty<FileEntity>() : new[] { _file });

        public Task<bool> ExistsByContentHashAsync(
            string contentHash,
            CancellationToken ct = default) =>
            Task.FromResult(
                _file is not null
                && string.Equals(_file.ContentHash, contentHash, StringComparison.OrdinalIgnoreCase));

        public Task AddAsync(FileEntity file, CancellationToken ct = default) =>
            Task.CompletedTask;

        public Task UpdateAsync(FileEntity file, CancellationToken ct = default)
        {
            UpdateCount++;
            return Task.CompletedTask;
        }

        public Task<bool> DeleteAsync(Guid id, CancellationToken ct = default) =>
            Task.FromResult(false);
    }

    private sealed class RecordingHttpMessageHandler : HttpMessageHandler
    {
        public List<RecordedRequest> Requests { get; } = new();

        public Func<HttpRequestMessage, HttpResponseMessage> ResponseFactory { get; set; } =
            _ => new HttpResponseMessage(HttpStatusCode.OK);

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var body = request.Content is null
                ? null
                : await request.Content.ReadAsStringAsync(cancellationToken);

            Requests.Add(new RecordedRequest(
                request.Method,
                request.RequestUri!,
                request.Content?.Headers.ContentType?.MediaType,
                request.Headers.Authorization?.Scheme,
                body));

            return ResponseFactory(request);
        }
    }

    private sealed record RecordedRequest(
        HttpMethod Method,
        Uri Uri,
        string? ContentType,
        string? HttpAuthorizationScheme,
        string? Body);
}
