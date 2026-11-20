using System.Text;
using Confluent.Kafka;
using Microsoft.Extensions.Configuration;
using StashHost.Shared.Contracts;
using StashHost.Shared.Messages;

namespace StashHost.Functions.Services;

/// <summary>
/// Kafka producer implementation for publishing upload request/response messages.
/// Uses <see cref="file_hash" /> as the message key for proper partitioning.
/// </summary>
public class KafkaProducer : IKafkaProducer, IAsyncDisposable
{
    private readonly IProducer<string, string> _producer;
    private readonly string _bootstrapServers;
    private bool _disposed;

    public KafkaProducer(IConfiguration configuration)
    {
        _bootstrapServers = configuration["Kafka:BootstrapServers"]
            ?? throw new InvalidOperationException("Kafka:BootstrapServers is not configured");

        var config = new ProducerConfig
        {
            BootstrapServers = _bootstrapServers,
            ClientId = "stashhost-producer",
            Acks = Acks.All,
            EnableIdempotence = true,
            MessageSendMaxRetries = 3,
            RetryBackoffMs = 1000
        };

        // Kafka SASL credentials (optional — dev clusters may not require them)
        var username = configuration["Kafka:Username"];
        var password = configuration["Kafka:Password"];
        if (!string.IsNullOrEmpty(username))
        {
            config.SaslMechanism = SaslMechanism.ScramSha256;
            config.SecurityProtocol = SecurityProtocol.SaslSsl;
            config.SaslUsername = username;
            config.SaslPassword = password;
        }

        _producer = new ProducerBuilder<string, string>(config).Build();
    }

    public async Task ProduceUploadRequestAsync(UploadRequestMessage message, CancellationToken ct)
    {
        var json = KafkaJson.Serialize(message);
        await ProduceAsync("stash.upload.request", message.FileId, json, CreateHeaders(), ct);
    }

    public async Task ProduceUploadResponseAsync(UploadResponseMessage message, CancellationToken ct)
    {
        var json = KafkaJson.Serialize(message);
        await ProduceAsync("stash.upload.response", message.FileId, json, CreateHeaders(), ct);
    }

    public async Task ProduceDeadLetterAsync(string key, string payload, string reason, CancellationToken ct)
    {
        var headers = CreateHeaders();
        headers.Add("x-dlq-reason", Encoding.UTF8.GetBytes(reason));
        await ProduceAsync("stash.dlq", key, payload, headers, ct);
    }

    private static Headers CreateHeaders() => new()
    {
        { "X-Message-Version", Encoding.UTF8.GetBytes("1") }
    };

    private async Task ProduceAsync(
        string topic,
        string key,
        string json,
        Headers headers,
        CancellationToken ct)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(KafkaProducer));

        var message = new Message<string, string>
        {
            Key = key ?? string.Empty,
            Value = json,
            Headers = headers
        };

        var deliveryResult = await _producer.ProduceAsync(topic, message, ct);
        if (deliveryResult.Status != PersistenceStatus.Persisted)
        {
            throw new InvalidOperationException($"Message not persisted to topic {topic}: {deliveryResult.Status}");
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        _producer?.Flush(TimeSpan.FromSeconds(10));
        _producer?.Dispose();
    }
}
