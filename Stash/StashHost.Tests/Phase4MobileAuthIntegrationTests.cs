using Stash.Maui.Auth;

namespace StashHost.Tests;

/// <summary>
/// Exercises the mobile Identity API client against the real Identity API pipeline
/// in-process. This catches request/response contract drift that a mock handler cannot.
/// </summary>
public class Phase4MobileAuthIntegrationTests
{
    [Fact]
    public async Task MobileClient_RegisterLoginRefreshRevoke_RoundTripsThroughIdentityApi()
    {
        using var factory = new IdentityApiFactory();
        using var client = factory.CreateClient();
        var storage = new InMemorySecureStorageService();
        var authentication = new AuthenticationService(client, storage);

        const string email = "mobile@example.com";
        const string password = "Password123!";
        const string deviceId = "mobile-device";

        var registered = await authentication.RegisterAsync(email, password, deviceId);

        Assert.True(registered.IsSuccess, registered.Error);
        Assert.NotNull(registered.Token);
        Assert.Equal(deviceId, registered.Token!.DeviceId);
        Assert.Equal(deviceId, storage.Get(AuthenticationService.DeviceIdKey));
        Assert.False(string.IsNullOrWhiteSpace(await authentication.GetAccessTokenAsync()));

        await authentication.LogoutAsync();

        Assert.Equal(string.Empty, await authentication.GetAccessTokenAsync());
        Assert.Equal(deviceId, storage.Get(AuthenticationService.DeviceIdKey));

        var loggedIn = await authentication.LoginAsync(email, password, deviceId);

        Assert.True(loggedIn.IsSuccess, loggedIn.Error);
        Assert.False(string.IsNullOrWhiteSpace(await authentication.GetAccessTokenAsync()));

        var refreshed = await authentication.RefreshTokenAsync();

        Assert.True(refreshed);
        Assert.False(string.IsNullOrWhiteSpace(await authentication.GetAccessTokenAsync()));

        var revoked = await authentication.RevokeDeviceAsync(deviceId);

        Assert.True(revoked);
        Assert.Equal(string.Empty, await authentication.GetAccessTokenAsync());

        var device = Assert.Single(factory.Store.Devices);
        Assert.True(device.IsRevoked);
    }

    private sealed class InMemorySecureStorageService : ISecureStorageService
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

        public string? Get(string key) => _values.TryGetValue(key, out var value) ? value : null;
    }
}
