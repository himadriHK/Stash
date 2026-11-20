namespace Stash.Maui.Auth;

/// <summary>
/// Abstraction over MAUI SecureStorage so authentication can be tested without a
/// platform-specific Keychain/Keystore implementation.
/// </summary>
public interface ISecureStorageService
{
    Task SetAsync(string key, string value, CancellationToken ct = default);

    Task<string?> GetAsync(string key, CancellationToken ct = default);

    Task RemoveAsync(string key, CancellationToken ct = default);
}
