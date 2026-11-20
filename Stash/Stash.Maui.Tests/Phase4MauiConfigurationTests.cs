using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Stash.Maui.Auth;
using Stash.Maui.Configuration;
using StashHost.Shared.Contracts;
using StashHost.Shared.Services;

namespace Stash.Maui.Tests;

public class Phase4MauiConfigurationTests
{
    [Fact]
    public void AppSettings_LoadsIntoStashConfig()
    {
        var configuration = LoadConfiguration();
        var config = configuration.Get<StashConfig>();

        Assert.NotNull(config);
        Assert.Equal("stash.upload.request", config!.Kafka.TopicUploadRequest);
        Assert.Equal("stash.upload.response", config.Kafka.TopicUploadResponse);
        Assert.Equal("stash.dlq", config.Kafka.TopicDeadLetter);
        Assert.Equal(string.Empty, config.Kafka.RestUrl);
        Assert.Equal(30, config.Kafka.RestTimeoutSeconds);
        Assert.Equal("Mega", config.Storage.Provider);
        Assert.Equal(10, config.UploadSettings.BatchSize);
        Assert.Equal(3, config.UploadSettings.MaxRetries);
        Assert.Equal(500L * 1024 * 1024, config.UploadSettings.MaxFileSizeBytes);
        Assert.Equal(30, config.IdentityApiTimeoutSeconds);
        Assert.Equal("stash-auth", config.Auth.Jwt.Issuer);
        Assert.Equal("stash-app", config.Auth.Jwt.Audience);
        Assert.False(config.ApplicationInsights.Enabled);
    }

    [Fact]
    public void AppSettings_ExposesLldCompatibleAliases()
    {
        var config = LoadConfiguration().Get<StashConfig>();

        Assert.NotNull(config);
        Assert.Equal(config!.Kafka.BootstrapServers, config.KafkaBootstrapServers);
        Assert.Equal(config.Kafka.RestUrl, config.KafkaRestUrl);
        Assert.Equal(config.Kafka.ClusterId, config.KafkaClusterId);
        Assert.Equal(config.Kafka.TopicDeadLetter, config.KafkaTopicDeadLetter);
        Assert.Equal(config.Storage.Provider, config.StorageProvider);
        Assert.Equal(config.Storage.Mega.Email, config.MegaEmail);
        Assert.Equal(config.UploadSettings.BatchSize, config.UploadBatchSize);
    }

    [Fact]
    public void AppSettings_DoesNotContainJwtSigningKey()
    {
        var configuration = LoadConfiguration();

        Assert.Null(configuration["Auth:Jwt:SigningKey"]);
    }

    [Fact]
    public async Task AddStashServices_RegistersConfigurationAndSharedServices()
    {
        var configuration = LoadConfiguration();
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<ISecureStorageService>(new InMemorySecureStorage());
        services.AddStashServices(configuration);

        await using var provider = services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateOnBuild = true,
            ValidateScopes = true
        });

        var config = provider.GetRequiredService<StashConfig>();
        Assert.Equal("Mega", config.Storage.Provider);
        Assert.Same(configuration, provider.GetRequiredService<IConfiguration>());

        var factory = provider.GetRequiredService<StorageProviderFactory>();
        Assert.Same(factory, provider.GetRequiredService<IStorageProviderFactory>());

        var storage = provider.GetRequiredService<IStorageProvider>();
        Assert.Same(storage, provider.GetRequiredService<IStorageProvider>());

        var httpClient = provider
            .GetRequiredService<IHttpClientFactory>()
            .CreateClient(ServiceRegistration.IdentityApiHttpClientName);

        Assert.Null(httpClient.BaseAddress);
        Assert.Equal(TimeSpan.FromSeconds(30), httpClient.Timeout);

        var authentication = provider.GetRequiredService<IAuthenticationService>();
        Assert.IsType<AuthenticationService>(authentication);
    }

    [Fact]
    public async Task AddStashServices_NormalizesIdentityApiBaseAddress()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["IdentityApiBaseUrl"] = "https://identity.example/api",
                ["IdentityApiTimeoutSeconds"] = "45"
            })
            .Build();

        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<ISecureStorageService>(new InMemorySecureStorage());
        services.AddStashServices(configuration);

        await using var provider = services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateOnBuild = true,
            ValidateScopes = true
        });

        var httpClient = provider
            .GetRequiredService<IHttpClientFactory>()
            .CreateClient(ServiceRegistration.IdentityApiHttpClientName);

        Assert.Equal("https://identity.example/api/", httpClient.BaseAddress!.AbsoluteUri);
        Assert.Equal(TimeSpan.FromSeconds(45), httpClient.Timeout);
    }

    private static IConfigurationRoot LoadConfiguration()
    {
        return StashConfiguration.LoadEmbedded(typeof(Phase4MauiConfigurationTests).Assembly);
    }
}
