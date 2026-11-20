using Microsoft.Extensions.DependencyInjection;

namespace Stash.Maui.Navigation;

/// <summary>
/// Resolves a registered Shell route page through the MAUI service provider so
/// pages can use constructor injection. The parameterless overload is unsupported:
/// every route page in this app is expected to be DI-created.
/// </summary>
internal sealed class ServiceProviderRouteFactory<TPage> : RouteFactory where TPage : Element
{
    public override Element GetOrCreate()
    {
        throw new InvalidOperationException(
            $"{typeof(TPage).Name} must be created through the dependency injection container.");
    }

    public override Element GetOrCreate(IServiceProvider services)
    {
        ArgumentNullException.ThrowIfNull(services);
        return services.GetRequiredService<TPage>();
    }
}
