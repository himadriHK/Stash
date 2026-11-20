using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using StashHost.Shared.Contracts;
using StashHost.Shared.Messages;

namespace StashHost.Shared.Services;

/// <summary>
/// Factory for creating storage provider instances based on configuration.
/// The Mega provider is cached so the process uses one Node runtime and one Mega
/// login instead of creating and leaking a provider per activity call.
///
/// "Mega" holds temp uploads and thumbnails; "Local" (see
/// <see cref="LocalStorageProvider"/>) is the permanent library on the host's own disk and is
/// selected explicitly by hash-backed storage, whatever <c>Storage:Provider</c> says.
/// </summary>
public sealed class StorageProviderFactory : IStorageProviderFactory, IAsyncDisposable
{
    private readonly IConfiguration _config;
    private readonly ILoggerFactory _loggerFactory;
    private readonly object _gate = new();
    private IStorageProvider? _megaProvider;
    private IStorageProvider? _localProvider;
    private bool _disposed;

    /// <summary>
    /// Initializes a new instance of StorageProviderFactory.
    /// </summary>
    public StorageProviderFactory(IConfiguration config, ILoggerFactory loggerFactory)
    {
        _config = config;
        _loggerFactory = loggerFactory;
    }

    /// <summary>
    /// Create a storage provider using the default configured provider type.
    /// </summary>
    public IStorageProvider Create()
    {
        var providerType = _config["Storage:Provider"] ?? "Mega";
        return Create(providerType);
    }

    /// <summary>
    /// Create a storage provider of the specified type.
    /// </summary>
    public IStorageProvider Create(string providerType)
    {
        if (_disposed)
            throw new ObjectDisposedException(nameof(StorageProviderFactory));

        return providerType switch
        {
            "Mega" => GetMegaProvider(),
            LocalStorageProvider.ProviderName => GetLocalProvider(),
            _ => throw new NotSupportedException($"Storage provider '{providerType}' not supported")
        };
    }

    private IStorageProvider GetMegaProvider()
    {
        lock (_gate)
        {
            if (_disposed)
                throw new ObjectDisposedException(nameof(StorageProviderFactory));

            return _megaProvider ??= new MegaStorageProvider(
                Options.Create(new MegaStorageOptions
                {
                    Email = _config["Storage:Mega:Email"] ?? string.Empty,
                    Password = _config["Storage:Mega:Password"] ?? string.Empty
                }),
                _loggerFactory.CreateLogger<MegaStorageProvider>());
        }
    }

    private IStorageProvider GetLocalProvider()
    {
        lock (_gate)
        {
            if (_disposed)
                throw new ObjectDisposedException(nameof(StorageProviderFactory));

            if (_localProvider is not null)
                return _localProvider;

            var rootPath = _config["Storage:Local:RootPath"];
            if (string.IsNullOrWhiteSpace(rootPath))
            {
                throw new InvalidOperationException(
                    "Local storage is not configured. Set Storage:Local:RootPath to the library " +
                    "directory (for example D:\\StashLibrary, \\\\nas\\photos\\stash or %USERPROFILE%\\StashLibrary).");
            }

            return _localProvider = new LocalStorageProvider(rootPath);
        }
    }

    public async ValueTask DisposeAsync()
    {
        IStorageProvider? provider;

        lock (_gate)
        {
            if (_disposed)
                return;

            _disposed = true;
            provider = _megaProvider;
            _megaProvider = null;
            _localProvider = null;
        }

        if (provider is IAsyncDisposable asyncDisposable)
            await asyncDisposable.DisposeAsync();
        else if (provider is IDisposable disposable)
            disposable.Dispose();
    }
}
