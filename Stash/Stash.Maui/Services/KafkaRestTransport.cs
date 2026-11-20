using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Stash.Maui.Configuration;

namespace Stash.Maui.Services;

/// <summary>
/// Kafka transport over the Confluent REST Proxy.
///
/// Produce uses the v3 records API because the v2 JSON produce API does not
/// carry Kafka record headers. The host trigger requires the Authorization,
/// device, user, correlation, and message-version headers, so v3 is required
/// for upload requests. Consume uses the v2 consumer API, which returns JSON
/// values and does not need record headers.
/// </summary>
public sealed class KafkaRestTransport : IKafkaTransport, IDisposable
{
    private const string JsonContentType = "application/vnd.kafka.json.v2+json";
    private const string V2ContentType = "application/vnd.kafka.v2+json";
    private const int ConsumerPollTimeoutMs = 10_000;

    private readonly HttpClient _httpClient;
    private readonly StashConfig _config;
    private readonly ILogger<KafkaRestTransport> _logger;
    private readonly SemaphoreSlim _clusterIdGate = new(1, 1);

    private string? _clusterId;
    private bool _disposed;

    public KafkaRestTransport(
        HttpClient httpClient,
        StashConfig config,
        ILogger<KafkaRestTransport> logger)
    {
        _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        _config = config ?? throw new ArgumentNullException(nameof(config));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));

        if (Uri.TryCreate(config.Kafka.RestUrl, UriKind.Absolute, out var restUri))
        {
            // A trailing slash makes relative paths (v3/..., consumers/...)
            // resolve under a configured path prefix such as /kafka/.
            _httpClient.BaseAddress = new Uri(restUri.AbsoluteUri.TrimEnd('/') + "/");
        }

        var timeoutSeconds = config.Kafka.RestTimeoutSeconds > 0
            ? config.Kafka.RestTimeoutSeconds
            : 30;
        _httpClient.Timeout = TimeSpan.FromSeconds(timeoutSeconds);
    }

    public async Task ProduceAsync(
        KafkaTransportMessage message,
        CancellationToken ct = default)
    {
        ThrowIfDisposed();
        ArgumentNullException.ThrowIfNull(message);
        EnsureConfigured();

        if (string.IsNullOrWhiteSpace(message.Topic))
            throw new ArgumentException("A Kafka topic is required.", nameof(message));

        var clusterId = await GetClusterIdAsync(ct).ConfigureAwait(false);

        var value = ParseJsonValue(message.Value);
        var record = new Dictionary<string, object?>
        {
            ["key"] = new Dictionary<string, object?>
            {
                ["type"] = "BINARY",
                ["data"] = ToBase64(message.Key)
            },
            ["value"] = value,
            ["headers"] = message.Headers
                .Select(header => new Dictionary<string, object?>
                {
                    ["name"] = header.Key,
                    ["value"] = ToBase64(header.Value)
                })
                .ToArray()
        };

        var json = JsonSerializer.Serialize(record, MobileKafkaJson.Options);
        var uri = BuildUri(
            $"v3/clusters/{Uri.EscapeDataString(clusterId)}" +
            $"/topics/{Uri.EscapeDataString(message.Topic)}/records");

        using var request = new HttpRequestMessage(HttpMethod.Post, uri)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        ApplyBasicAuth(request);

        using var response = await _httpClient
            .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct)
            .ConfigureAwait(false);
        var responseBody = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            throw new KafkaTransportException(
                $"Kafka REST produce failed with {(int)response.StatusCode} " +
                $"{response.ReasonPhrase}: {Truncate(responseBody)}");
        }

        EnsureNoRecordError(responseBody);
    }

    public async Task ConsumeAsync(
        string topic,
        string groupId,
        Func<KafkaTransportRecord, CancellationToken, Task> onRecord,
        CancellationToken ct = default)
    {
        ThrowIfDisposed();
        ArgumentException.ThrowIfNullOrWhiteSpace(topic);
        ArgumentException.ThrowIfNullOrWhiteSpace(groupId);
        ArgumentNullException.ThrowIfNull(onRecord);
        EnsureConfigured();

        string? consumerUri = null;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    consumerUri ??= await CreateConsumerAsync(groupId, topic, ct)
                        .ConfigureAwait(false);

                    var records = await PollAsync(consumerUri, ct).ConfigureAwait(false);
                    foreach (var record in records)
                    {
                        ct.ThrowIfCancellationRequested();
                        await onRecord(record, ct).ConfigureAwait(false);
                    }
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    break;
                }
                catch (KafkaConsumerNotFoundException)
                {
                    _logger.LogWarning(
                        "Kafka REST consumer instance was not found; recreating it.");
                    if (consumerUri is not null)
                        await DeleteConsumerQuietlyAsync(consumerUri).ConfigureAwait(false);
                    consumerUri = null;
                }
                catch (Exception ex) when (!ct.IsCancellationRequested)
                {
                    _logger.LogWarning(
                        ex,
                        "Kafka REST consume loop failed; recreating the consumer.");
                    if (consumerUri is not null)
                        await DeleteConsumerQuietlyAsync(consumerUri).ConfigureAwait(false);
                    consumerUri = null;

                    await Task.Delay(TimeSpan.FromSeconds(5), ct).ConfigureAwait(false);
                }
            }
        }
        finally
        {
            if (consumerUri is not null)
                await DeleteConsumerQuietlyAsync(consumerUri).ConfigureAwait(false);
        }
    }

    private async Task<string> GetClusterIdAsync(CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(_config.Kafka.ClusterId))
            return _config.Kafka.ClusterId.Trim();

        if (!string.IsNullOrWhiteSpace(_clusterId))
            return _clusterId;

        await _clusterIdGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (!string.IsNullOrWhiteSpace(_clusterId))
                return _clusterId;

            var uri = BuildUri("v3/clusters");
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            ApplyBasicAuth(request);

            using var response = await _httpClient
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct)
                .ConfigureAwait(false);
            var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

            if (!response.IsSuccessStatusCode)
            {
                throw new KafkaTransportException(
                    $"Kafka REST cluster discovery failed with {(int)response.StatusCode}: " +
                    Truncate(body));
            }

            using var document = JsonDocument.Parse(body);
            if (document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty("data", out var data)
                && data.ValueKind == JsonValueKind.Array)
            {
                foreach (var cluster in data.EnumerateArray())
                {
                    if (cluster.TryGetProperty("cluster_id", out var id)
                        && !string.IsNullOrWhiteSpace(id.GetString()))
                    {
                        _clusterId = id.GetString();
                        return _clusterId!;
                    }
                }
            }

            throw new KafkaTransportException(
                "Kafka REST cluster discovery returned no cluster_id. " +
                "Set Kafka:ClusterId explicitly.");
        }
        finally
        {
            _clusterIdGate.Release();
        }
    }

    private async Task<string> CreateConsumerAsync(
        string groupId,
        string topic,
        CancellationToken ct)
    {
        var instanceName = $"stash-mobile-{Sanitize(groupId)}-{Guid.NewGuid():N}";
        var body = new Dictionary<string, object?>
        {
            ["name"] = instanceName,
            ["format"] = "json",
            ["auto.offset.reset"] = "earliest",
            ["auto.commit.enable"] = "true"
        };

        var uri = BuildUri($"consumers/{Uri.EscapeDataString(groupId)}");
        var responseBody = await SendJsonAsync(
            HttpMethod.Post,
            uri,
            JsonSerializer.Serialize(body, MobileKafkaJson.Options),
            V2ContentType,
            ct).ConfigureAwait(false);

        using var document = JsonDocument.Parse(responseBody);
        if (!document.RootElement.TryGetProperty("base_uri", out var baseUriElement)
            || string.IsNullOrWhiteSpace(baseUriElement.GetString()))
        {
            throw new KafkaTransportException(
                "Kafka REST consumer creation returned no base_uri.");
        }

        var consumerUri = ResolveConsumerUri(baseUriElement.GetString()!);
        try
        {
            var subscription = JsonSerializer.Serialize(
                new Dictionary<string, object?> { ["topics"] = new[] { topic } },
                MobileKafkaJson.Options);
            await SendJsonAsync(
                HttpMethod.Post,
                new Uri(consumerUri + "/subscription"),
                subscription,
                V2ContentType,
                ct).ConfigureAwait(false);
        }
        catch
        {
            await DeleteConsumerQuietlyAsync(consumerUri).ConfigureAwait(false);
            throw;
        }

        return consumerUri;
    }

    private async Task<IReadOnlyList<KafkaTransportRecord>> PollAsync(
        string consumerUri,
        CancellationToken ct)
    {
        var uri = new Uri(
            consumerUri +
            $"/records?timeout={ConsumerPollTimeoutMs}&max_bytes=1048576");

        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue(JsonContentType));
        ApplyBasicAuth(request);

        using var response = await _httpClient
            .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct)
            .ConfigureAwait(false);

        if (response.StatusCode == HttpStatusCode.NoContent)
            return Array.Empty<KafkaTransportRecord>();

        if (response.StatusCode == HttpStatusCode.NotFound)
            throw new KafkaConsumerNotFoundException();

        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new KafkaTransportException(
                $"Kafka REST consume failed with {(int)response.StatusCode}: " +
                Truncate(body));
        }

        if (string.IsNullOrWhiteSpace(body))
            return Array.Empty<KafkaTransportRecord>();

        using var document = JsonDocument.Parse(body);
        if (document.RootElement.ValueKind != JsonValueKind.Array)
            return Array.Empty<KafkaTransportRecord>();

        var records = new List<KafkaTransportRecord>();
        foreach (var element in document.RootElement.EnumerateArray())
        {
            records.Add(new KafkaTransportRecord(
                GetString(element, "topic") ?? string.Empty,
                GetString(element, "key") ?? string.Empty,
                ReadValue(element),
                ReadHeaders(element)));
        }

        return records;
    }

    private async Task<string> SendJsonAsync(
        HttpMethod method,
        Uri uri,
        string json,
        string contentType,
        CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, uri)
        {
            Content = new StringContent(json, Encoding.UTF8)
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue(contentType);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue(contentType));
        ApplyBasicAuth(request);

        using var response = await _httpClient
            .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct)
            .ConfigureAwait(false);
        var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            throw new KafkaTransportException(
                $"Kafka REST {method} {uri} failed with " +
                $"{(int)response.StatusCode} {response.ReasonPhrase}: {Truncate(body)}");
        }

        return body;
    }

    private async Task DeleteConsumerQuietlyAsync(string consumerUri)
    {
        try
        {
            using var request = new HttpRequestMessage(
                HttpMethod.Delete,
                new Uri(consumerUri));
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue(V2ContentType));
            ApplyBasicAuth(request);

            using var response = await _httpClient
                .SendAsync(request, CancellationToken.None)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Failed to delete Kafka REST consumer instance.");
        }
    }

    private Uri BuildUri(string relativePath)
    {
        var baseAddress = _httpClient.BaseAddress
            ?? throw new InvalidOperationException(
                "Kafka REST proxy is not configured. Set Kafka:RestUrl in appsettings.json.");

        return new Uri(baseAddress, relativePath);
    }

    private string ResolveConsumerUri(string baseUri)
    {
        if (Uri.TryCreate(baseUri, UriKind.Absolute, out var absolute))
            return absolute.AbsoluteUri.TrimEnd('/');

        var baseAddress = _httpClient.BaseAddress
            ?? throw new InvalidOperationException(
                "Kafka REST proxy is not configured. Set Kafka:RestUrl in appsettings.json.");

        return new Uri(baseAddress, baseUri.TrimStart('/')).AbsoluteUri.TrimEnd('/');
    }

    private void EnsureConfigured()
    {
        if (_httpClient.BaseAddress is null)
        {
            throw new InvalidOperationException(
                "Kafka REST proxy is not configured. Set Kafka:RestUrl in appsettings.json.");
        }
    }

    private void ApplyBasicAuth(HttpRequestMessage request)
    {
        if (string.IsNullOrWhiteSpace(_config.Kafka.RestUsername))
            return;

        var credentials = $"{_config.Kafka.RestUsername}:{_config.Kafka.RestPassword}";
        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Basic",
            Convert.ToBase64String(Encoding.UTF8.GetBytes(credentials)));
    }

    private static Dictionary<string, object?> ParseJsonValue(string value)
    {
        try
        {
            using var document = JsonDocument.Parse(value);
            return new Dictionary<string, object?>
            {
                ["type"] = "JSON",
                ["data"] = document.RootElement.Clone()
            };
        }
        catch (JsonException)
        {
            return new Dictionary<string, object?>
            {
                ["type"] = "STRING",
                ["data"] = value
            };
        }
    }

    private static string? GetString(JsonElement element, string propertyName)
    {
        return element.TryGetProperty(propertyName, out var property)
            && property.ValueKind == JsonValueKind.String
            ? property.GetString()
            : null;
    }

    private static string ReadValue(JsonElement record)
    {
        if (!record.TryGetProperty("value", out var value)
            || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return string.Empty;
        }

        return value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : value.GetRawText();
    }

    private static IReadOnlyDictionary<string, string> ReadHeaders(JsonElement record)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!record.TryGetProperty("headers", out var headerArray)
            || headerArray.ValueKind != JsonValueKind.Array)
        {
            return headers;
        }

        foreach (var header in headerArray.EnumerateArray())
        {
            if (header.ValueKind != JsonValueKind.Object)
                continue;

            var name = GetString(header, "name") ?? GetString(header, "key");
            var value = GetString(header, "value");
            if (!string.IsNullOrWhiteSpace(name) && value is not null)
                headers[name] = value;
        }

        return headers;
    }

    private static string ToBase64(string value)
    {
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(value ?? string.Empty));
    }

    private static string Truncate(string value)
    {
        const int maxLength = 500;
        return value.Length <= maxLength ? value : value[..maxLength] + "...";
    }

    private static string Sanitize(string value)
    {
        var builder = new StringBuilder(value.Length);
        foreach (var character in value)
        {
            builder.Append(char.IsLetterOrDigit(character) || character is '-' or '_'
                ? character
                : '_');
        }

        return builder.Length == 0 ? "device" : builder.ToString();
    }

    private void EnsureNoRecordError(string responseBody)
    {
        if (string.IsNullOrWhiteSpace(responseBody))
            return;

        try
        {
            using var document = JsonDocument.Parse(responseBody);
            if (document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty("error_code", out var errorCode)
                && errorCode.TryGetInt32(out var code)
                && code != 0)
            {
                throw new KafkaTransportException(
                    $"Kafka REST produce returned error_code {code}: " +
                    Truncate(responseBody));
            }
        }
        catch (JsonException)
        {
            // A non-JSON success body is not itself a failure.
        }
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
    }

    public void Dispose()
    {
        if (_disposed)
            return;

        _disposed = true;
        _clusterIdGate.Dispose();
        _httpClient.Dispose();
    }

    private sealed class KafkaConsumerNotFoundException : Exception
    {
    }
}

/// <summary>
/// Raised when the Kafka REST proxy returns an error or a record-level failure.
/// </summary>
public sealed class KafkaTransportException : Exception
{
    public KafkaTransportException(string message)
        : base(message)
    {
    }
}
