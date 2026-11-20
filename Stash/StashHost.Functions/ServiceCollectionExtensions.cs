using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Configuration;
using StashHost.Functions.Activities;
using StashHost.Functions.Services;
using StashHost.Shared.Contracts;
using StashHost.Shared.Services;

namespace StashHost.Functions;

/// <summary>
/// Dependency injection extensions for StashHost.Functions.
/// </summary>
public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddStorageInfrastructure(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddSingleton<IStorageProviderFactory, StorageProviderFactory>();
        // IJwtValidator is registered in Program.cs because its constructor needs
        // the signing key/issuer/audience values from configuration.
        services.AddSingleton<IKafkaProducer, KafkaProducer>();
        services.AddSingleton<IConverterFactory>(sp => new ConverterFactory(
            new List<IImageConverter> { new ImageConverter(), new RawImageConverter() },
            new List<IVideoConverter> { new VideoConverter() }));
        services.AddSingleton(_ => new VideoFrameExtractor());
        services.AddSingleton<IThumbnailGenerator, ThumbnailGenerator>();
        return services;
    }
}
