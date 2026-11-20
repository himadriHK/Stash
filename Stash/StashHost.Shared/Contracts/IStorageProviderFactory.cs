namespace StashHost.Shared.Contracts;

/// <summary>
/// Factory for creating storage provider instances.
/// </summary>
public interface IStorageProviderFactory
{
    /// <summary>
    /// Create a storage provider using the default configured provider type.
    /// </summary>
    IStorageProvider Create();

    /// <summary>
    /// Create a storage provider of the specified type.
    /// </summary>
    IStorageProvider Create(string providerType);
}
