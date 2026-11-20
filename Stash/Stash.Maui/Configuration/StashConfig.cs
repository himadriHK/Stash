namespace Stash.Maui.Configuration;

/// <summary>
/// Strongly typed configuration for the Stash mobile app.
/// The shape mirrors the nested keys in appsettings.json, so sections can be
/// bound with the standard configuration binder.
/// </summary>
public sealed class StashConfig
{
    public KafkaConfig Kafka { get; set; } = new();

    public StorageConfig Storage { get; set; } = new();

    public AuthConfig Auth { get; set; } = new();

    public UploadSettings UploadSettings { get; set; } = new();

    public BackgroundUploadConfig BackgroundUpload { get; set; } = new();

    public string IdentityApiBaseUrl { get; set; } = string.Empty;

    public int IdentityApiTimeoutSeconds { get; set; } = 30;

    public ApplicationInsightsConfig ApplicationInsights { get; set; } = new();

    // Compatibility aliases for the flat names used in ARCHITECTURE_LLD_v2.md.
    public string KafkaBootstrapServers => Kafka.BootstrapServers;

    public string KafkaUsername => Kafka.Username;

    public string KafkaPassword => Kafka.Password;

    public string KafkaRestUrl => Kafka.RestUrl;

    public string KafkaClusterId => Kafka.ClusterId;

    public string KafkaTopicUploadRequest => Kafka.TopicUploadRequest;

    public string KafkaTopicUploadResponse => Kafka.TopicUploadResponse;

    public string KafkaTopicDeadLetter => Kafka.TopicDeadLetter;

    public string StorageProvider => Storage.Provider;

    public string MegaEmail => Storage.Mega.Email;

    public string MegaPassword => Storage.Mega.Password;

    public int UploadBatchSize => UploadSettings.BatchSize;
}

/// <summary>
/// Kafka connection and topic settings used by the mobile producer/consumer.
/// </summary>
public sealed class KafkaConfig
{
    // Direct Kafka settings are retained for host parity and local diagnostics.
    // Mobile devices use the REST proxy instead of a native Kafka client.
    public string BootstrapServers { get; set; } = string.Empty;

    public string Username { get; set; } = string.Empty;

    public string Password { get; set; } = string.Empty;

    /// <summary>
    /// Base URL of the Confluent REST Proxy. Include a path prefix (for example
    /// /kafka) when the proxy is mounted below the host root.
    /// </summary>
    public string RestUrl { get; set; } = string.Empty;

    public string RestUsername { get; set; } = string.Empty;

    public string RestPassword { get; set; } = string.Empty;

    public int RestTimeoutSeconds { get; set; } = 30;

    /// <summary>
    /// Optional Kafka cluster ID for the v3 produce endpoint. When empty, the
    /// transport discovers it from GET /v3/clusters.
    /// </summary>
    public string ClusterId { get; set; } = string.Empty;

    public string TopicUploadRequest { get; set; } = "stash.upload.request";

    public string TopicUploadResponse { get; set; } = "stash.upload.response";

    public string TopicDeadLetter { get; set; } = "stash.dlq";
}

/// <summary>
/// Platform background-upload scheduling settings.
/// </summary>
public sealed class BackgroundUploadConfig
{
    /// <summary>
    /// Enables scheduling the platform background worker. The worker itself also
    /// refuses to run without an authenticated session.
    /// </summary>
    public bool Enabled { get; set; } = true;

    /// <summary>
    /// Requested interval. Android WorkManager clamps periodic work to at least
    /// 15 minutes; iOS treats this as an earliest-begin hint.
    /// </summary>
    public int IntervalMinutes { get; set; } = 15;

    /// <summary>
    /// Limits one pass so a background execution window is not exhausted.
    /// Set to 0 or a negative value for no limit.
    /// </summary>
    public int MaxFilesPerRun { get; set; } = 50;
}

/// <summary>
/// Storage provider selection and provider-specific settings.
/// </summary>
public sealed class StorageConfig
{
    public string Provider { get; set; } = "Mega";

    public MegaConfig Mega { get; set; } = new();
}

/// <summary>
/// Mega.io account settings. These values must not be committed as real secrets.
/// </summary>
public sealed class MegaConfig
{
    public string Email { get; set; } = string.Empty;

    public string Password { get; set; } = string.Empty;
}

/// <summary>
/// Authentication settings that are safe to ship in a mobile client.
/// The JWT signing key is intentionally not part of mobile configuration.
/// </summary>
public sealed class AuthConfig
{
    public JwtConfig Jwt { get; set; } = new();
}

/// <summary>
/// JWT issuer/audience values used for token handling. Signing remains server-side.
/// </summary>
public sealed class JwtConfig
{
    public string Issuer { get; set; } = "stash-auth";

    public string Audience { get; set; } = "stash-app";
}

/// <summary>
/// Upload batching and size limits.
/// </summary>
public sealed class UploadSettings
{
    public int BatchSize { get; set; } = 10;

    public int MaxRetries { get; set; } = 3;

    public long MaxFileSizeBytes { get; set; } = 500 * 1024 * 1024;
}

/// <summary>
/// Application Insights settings. Telemetry is not initialized in Phase 4.1.
/// </summary>
public sealed class ApplicationInsightsConfig
{
    public bool Enabled { get; set; }

    public string ConnectionString { get; set; } = string.Empty;
}
