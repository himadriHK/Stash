using Microsoft.Maui.Storage;

namespace Stash.Maui.Auth;

/// <summary>
/// MAUI SecureStorage-backed implementation. Tokens therefore live in the platform
/// Keychain (iOS/MacCatalyst) or Keystore-backed storage (Android/Windows).
/// </summary>
public sealed class MauiSecureStorage : ISecureStorageService
{
    public Task SetAsync(string key, string value, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        return SecureStorage.Default.SetAsync(key, value);
    }

    public async Task<string?> GetAsync(string key, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        return await SecureStorage.Default.GetAsync(key).WaitAsync(ct);
    }

    public Task RemoveAsync(string key, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        SecureStorage.Default.Remove(key);
        return Task.CompletedTask;
    }
}
