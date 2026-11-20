using Stash.Maui.Auth;

namespace Stash.Maui.Tests;

/// <summary>
/// In-memory replacement for MAUI SecureStorage. Tests use this so the auth service
/// can be exercised on the plain .NET target without Keychain/Keystore.
/// </summary>
internal sealed class InMemorySecureStorage : ISecureStorageService
{
    private readonly Dictionary<string, string> _values = new(StringComparer.Ordinal);

    public Task SetAsync(string key, string value, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        _values[key] = value;
        return Task.CompletedTask;
    }

    public Task<string?> GetAsync(string key, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        return Task.FromResult(_values.TryGetValue(key, out var value) ? value : null);
    }

    public Task RemoveAsync(string key, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        _values.Remove(key);
        return Task.CompletedTask;
    }

    public void Set(string key, string value) => _values[key] = value;

    public bool Contains(string key) => _values.ContainsKey(key);

    public string? Get(string key) => _values.TryGetValue(key, out var value) ? value : null;
}
