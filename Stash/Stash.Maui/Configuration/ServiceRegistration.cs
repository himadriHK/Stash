using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Stash.Maui.Auth;
using Stash.Maui.Services;
using StashHost.Shared.Contracts;
using StashHost.Shared.Messages;
using StashHost.Shared.Services;

namespace Stash.Maui.Configuration;

/// <summary>
/// Registers the configuration and services that are available to the MAUI app.
/// This method intentionally has no MAUI-specific dependencies so it can be
/// exercised by the plain .NET test project.
/// </summary>
public static class ServiceRegistration
{
    public const string IdentityApiHttpClientName = "IdentityApi";

    /// <summary>
    /// Adds Stash configuration, HTTP access, and the shared storage services.
    /// </summary>
    public static IServiceCollection AddStashServices(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        var stashConfig = new StashConfig();
        configuration.Bind(stashConfig);

        services.AddSingleton(configuration);
        services.AddSingleton(stashConfig);

        services.AddSingleton<IOptions<MegaStorageOptions>>(
            Options.Create(new MegaStorageOptions
            {
                Email = stashConfig.Storage.Mega.Email,
                Password = stashConfig.Storage.Mega.Password
            }));

        // Register the concrete factory once, then expose it through its contract.
        // This keeps one cached Mega provider and lets the container dispose it.
        services.AddSingleton<StorageProviderFactory>();
        services.AddSingleton<IStorageProviderFactory>(
            sp => sp.GetRequiredService<StorageProviderFactory>());
        services.AddSingleton<IStorageProvider>(
            sp => sp.GetRequiredService<IStorageProviderFactory>().Create());

        services.AddHttpClient(IdentityApiHttpClientName, (sp, client) =>
        {
            var config = sp.GetRequiredService<StashConfig>();

            if (Uri.TryCreate(config.IdentityApiBaseUrl, UriKind.Absolute, out var baseUri))
            {
                // Normalize the base URL so relative endpoint paths ("api/auth/login")
                // resolve consistently whether or not the configured value ends in '/'.
                client.BaseAddress = new Uri(baseUri.AbsoluteUri.TrimEnd('/') + "/");
            }

            var timeoutSeconds = config.IdentityApiTimeoutSeconds > 0
                ? config.IdentityApiTimeoutSeconds
                : 30;
            client.Timeout = TimeSpan.FromSeconds(timeoutSeconds);
        });

        services.AddHttpClient<IAuthenticationService, AuthenticationService>(
            IdentityApiHttpClientName);

        services.AddSingleton<IFolderScannerService, FolderScannerService>();

        return services;
    }

    /// <summary>
    /// Registers the upload manager. Call after <c>AddStashData</c> so the file
    /// repository dependency is available.
    /// </summary>
    public static IServiceCollection AddStashUploadServices(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton<IUploadManager, UploadManager>();
        return services;
    }

    /// <summary>
    /// Registers the mobile Kafka producer/consumer over the REST transport.
    /// Call after <c>AddStashServices</c>, <c>AddStashData</c>, and
    /// <c>AddStashUploadServices</c> so authentication and file repositories are
    /// available. The transport throws a clear configuration error on first use
    /// when <c>Kafka:RestUrl</c> is empty; startup is not blocked.
    /// </summary>
    public static IServiceCollection AddStashKafkaServices(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddSingleton<IKafkaTransport>(sp =>
        {
            var config = sp.GetRequiredService<StashConfig>();
            var logger = sp.GetService<ILogger<KafkaRestTransport>>()
                ?? NullLogger<KafkaRestTransport>.Instance;

            return new KafkaRestTransport(new HttpClient(), config, logger);
        });

        services.AddSingleton<IKafkaProducer, KafkaProducer>();
        services.AddSingleton<IKafkaConsumer, KafkaConsumer>();

        return services;
    }

    /// <summary>
    /// Registers the platform-independent background upload pass and the
    /// platform-specific scheduler. Call after auth, data, upload, and Kafka
    /// services are registered.
    /// </summary>
    public static IServiceCollection AddStashBackgroundUploadServices(
        this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddSingleton<IBackgroundUploadService, BackgroundUploadService>();

#if ANDROID
        services.AddSingleton<IBackgroundUploadScheduler, AndroidBackgroundUploadScheduler>();
#elif IOS
        services.AddSingleton<IBackgroundUploadScheduler, IosBackgroundUploadScheduler>();
#elif WINDOWS
        services.AddSingleton<IBackgroundUploadScheduler, WindowsBackgroundUploadScheduler>();
#else
        services.AddSingleton<IBackgroundUploadScheduler, NoOpBackgroundUploadScheduler>();
#endif

        return services;
    }
}
