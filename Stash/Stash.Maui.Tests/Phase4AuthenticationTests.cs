using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Stash.Maui.Auth;

namespace Stash.Maui.Tests;

public class Phase4AuthenticationTests
{
    [Fact]
    public async Task LoginAsync_PostsCredentials_AndPersistsTokenPair()
    {
        var storage = new InMemorySecureStorage();
        using var handler = new StubHandler(_ => JsonResponse(
            HttpStatusCode.OK,
            TokenResponse("access-login", "refresh-login", "device-login")));
        var service = CreateService(handler, storage);

        var result = await service.LoginAsync("user@example.com", "Secret123!", "device-login");

        Assert.True(result.IsSuccess);
        Assert.NotNull(result.Token);
        Assert.Equal("https://identity.test/api/auth/login", handler.Uri!.ToString());
        Assert.Equal(HttpMethod.Post, handler.Method);

        using var body = JsonDocument.Parse(handler.Body!);
        Assert.Equal("user@example.com", body.RootElement.GetProperty("email").GetString());
        Assert.Equal("Secret123!", body.RootElement.GetProperty("password").GetString());
        Assert.Equal("device-login", body.RootElement.GetProperty("deviceId").GetString());

        Assert.Equal("access-login", storage.Get(AuthenticationService.AccessTokenKey));
        Assert.Equal("refresh-login", storage.Get(AuthenticationService.RefreshTokenKey));
        Assert.Equal("user-1", storage.Get(AuthenticationService.UserIdKey));
        Assert.Equal("device-login", storage.Get(AuthenticationService.DeviceIdKey));
        Assert.False(string.IsNullOrWhiteSpace(storage.Get(AuthenticationService.ExpiresAtKey)));
    }

    [Fact]
    public async Task RegisterAsync_PostsToRegisterEndpoint_AndPersistsTokenPair()
    {
        var storage = new InMemorySecureStorage();
        using var handler = new StubHandler(_ => JsonResponse(
            HttpStatusCode.OK,
            TokenResponse("access-register", "refresh-register", "device-register")));
        var service = CreateService(handler, storage);

        var result = await service.RegisterAsync("new@example.com", "Secret123!", "device-register");

        Assert.True(result.IsSuccess);
        Assert.Equal("https://identity.test/api/auth/register", handler.Uri!.ToString());
        Assert.Equal("access-register", storage.Get(AuthenticationService.AccessTokenKey));
        Assert.Equal("refresh-register", storage.Get(AuthenticationService.RefreshTokenKey));
    }

    [Fact]
    public async Task LoginAsync_ServerError_ReturnsApiMessage()
    {
        var storage = new InMemorySecureStorage();
        using var handler = new StubHandler(_ => JsonResponse(
            HttpStatusCode.Unauthorized,
            JsonSerializer.Serialize(new { error = "Invalid email or password." })));
        var service = CreateService(handler, storage);

        var result = await service.LoginAsync("user@example.com", "wrong", "device-1");

        Assert.False(result.IsSuccess);
        Assert.Equal("Invalid email or password.", result.Error);
        Assert.False(storage.Contains(AuthenticationService.AccessTokenKey));
    }

    [Fact]
    public async Task GetAccessTokenAsync_ReturnsStoredToken_OrEmptyWhenMissing()
    {
        var storage = new InMemorySecureStorage();
        using var handler = new StubHandler(_ => JsonResponse(HttpStatusCode.OK, "{}"));
        var service = CreateService(handler, storage);

        Assert.Equal(string.Empty, await service.GetAccessTokenAsync());

        storage.Set(AuthenticationService.AccessTokenKey, "stored-access-token");

        Assert.Equal("stored-access-token", await service.GetAccessTokenAsync());
    }

    [Fact]
    public async Task EnsureValidAccessTokenAsync_ReturnsTrue_ForUnexpiredToken_WithoutHttpCall()
    {
        var storage = new InMemorySecureStorage();
        storage.Set(AuthenticationService.AccessTokenKey, "access-valid");
        storage.Set(
            AuthenticationService.ExpiresAtKey,
            DateTimeOffset.UtcNow.AddMinutes(5).ToString("O"));

        using var handler = new StubHandler(_ => JsonResponse(HttpStatusCode.OK, "{}"));
        var service = CreateService(handler, storage);

        var valid = await service.EnsureValidAccessTokenAsync();

        Assert.True(valid);
        Assert.Null(handler.Uri);
    }

    [Fact]
    public async Task EnsureValidAccessTokenAsync_RefreshesExpiredToken()
    {
        var storage = new InMemorySecureStorage();
        storage.Set(AuthenticationService.AccessTokenKey, "access-old");
        storage.Set(AuthenticationService.RefreshTokenKey, "refresh-old");
        storage.Set(AuthenticationService.ExpiresAtKey, DateTimeOffset.UtcNow.AddMinutes(-1).ToString("O"));
        storage.Set(AuthenticationService.UserIdKey, "user-1");
        storage.Set(AuthenticationService.DeviceIdKey, "device-1");

        using var handler = new StubHandler(_ => JsonResponse(
            HttpStatusCode.OK,
            JsonSerializer.Serialize(new
            {
                accessToken = "access-new",
                refreshToken = "refresh-new",
                expiresAt = DateTimeOffset.UtcNow.AddHours(1),
                userId = "user-1",
                deviceId = "device-1"
            })));
        var service = CreateService(handler, storage);

        var valid = await service.EnsureValidAccessTokenAsync();

        Assert.True(valid);
        Assert.Equal("https://identity.test/api/auth/refresh", handler.Uri!.ToString());
        Assert.Equal("access-new", storage.Get(AuthenticationService.AccessTokenKey));
        Assert.Equal("refresh-new", storage.Get(AuthenticationService.RefreshTokenKey));
    }

    [Fact]
    public async Task RefreshTokenAsync_PostsRefreshToken_AndRotatesStoredTokens()
    {
        var storage = new InMemorySecureStorage();
        storage.Set(AuthenticationService.AccessTokenKey, "access-old");
        storage.Set(AuthenticationService.RefreshTokenKey, "refresh-old");
        storage.Set(AuthenticationService.UserIdKey, "user-1");
        storage.Set(AuthenticationService.DeviceIdKey, "device-1");

        using var handler = new StubHandler(_ => JsonResponse(
            HttpStatusCode.OK,
            TokenResponse("access-new", "refresh-new", "device-1")));
        var service = CreateService(handler, storage);

        var refreshed = await service.RefreshTokenAsync();

        Assert.True(refreshed);
        Assert.Equal("https://identity.test/api/auth/refresh", handler.Uri!.ToString());
        using var body = JsonDocument.Parse(handler.Body!);
        Assert.Equal("refresh-old", body.RootElement.GetProperty("refreshToken").GetString());

        Assert.Equal("access-new", storage.Get(AuthenticationService.AccessTokenKey));
        Assert.Equal("refresh-new", storage.Get(AuthenticationService.RefreshTokenKey));
    }

    [Fact]
    public async Task RefreshTokenAsync_InvalidRefreshToken_ClearsSessionButKeepsDeviceId()
    {
        var storage = new InMemorySecureStorage();
        storage.Set(AuthenticationService.AccessTokenKey, "access-old");
        storage.Set(AuthenticationService.RefreshTokenKey, "refresh-old");
        storage.Set(AuthenticationService.ExpiresAtKey, DateTime.UtcNow.ToString("O"));
        storage.Set(AuthenticationService.UserIdKey, "user-1");
        storage.Set(AuthenticationService.DeviceIdKey, "device-stable");

        using var handler = new StubHandler(_ => JsonResponse(
            HttpStatusCode.Unauthorized,
            JsonSerializer.Serialize(new { error = "Invalid refresh token." })));
        var service = CreateService(handler, storage);

        var refreshed = await service.RefreshTokenAsync();

        Assert.False(refreshed);
        Assert.False(storage.Contains(AuthenticationService.AccessTokenKey));
        Assert.False(storage.Contains(AuthenticationService.RefreshTokenKey));
        Assert.False(storage.Contains(AuthenticationService.ExpiresAtKey));
        Assert.False(storage.Contains(AuthenticationService.UserIdKey));
        Assert.Equal("device-stable", storage.Get(AuthenticationService.DeviceIdKey));
    }

    [Fact]
    public async Task LogoutAsync_ClearsSessionButKeepsDeviceId()
    {
        var storage = new InMemorySecureStorage();
        storage.Set(AuthenticationService.AccessTokenKey, "access");
        storage.Set(AuthenticationService.RefreshTokenKey, "refresh");
        storage.Set(AuthenticationService.ExpiresAtKey, DateTime.UtcNow.ToString("O"));
        storage.Set(AuthenticationService.UserIdKey, "user-1");
        storage.Set(AuthenticationService.DeviceIdKey, "device-stable");

        using var handler = new StubHandler(_ => JsonResponse(HttpStatusCode.OK, "{}"));
        var service = CreateService(handler, storage);

        await service.LogoutAsync();

        Assert.False(storage.Contains(AuthenticationService.AccessTokenKey));
        Assert.False(storage.Contains(AuthenticationService.RefreshTokenKey));
        Assert.False(storage.Contains(AuthenticationService.ExpiresAtKey));
        Assert.False(storage.Contains(AuthenticationService.UserIdKey));
        Assert.Equal("device-stable", storage.Get(AuthenticationService.DeviceIdKey));
    }

    [Fact]
    public async Task RevokeDeviceAsync_SendsBearerToken_AndClearsCurrentDeviceSession()
    {
        var storage = new InMemorySecureStorage();
        storage.Set(AuthenticationService.AccessTokenKey, "access-revoke");
        storage.Set(AuthenticationService.DeviceIdKey, "device-1");

        using var handler = new StubHandler(_ => new HttpResponseMessage(HttpStatusCode.OK));
        var service = CreateService(handler, storage);

        var revoked = await service.RevokeDeviceAsync("device-1");

        Assert.True(revoked);
        Assert.Equal(HttpMethod.Post, handler.Method);
        Assert.Equal("https://identity.test/api/auth/revoke", handler.Uri!.ToString());
        Assert.Equal("Bearer", handler.Authorization!.Scheme);
        Assert.Equal("access-revoke", handler.Authorization.Parameter);

        using var body = JsonDocument.Parse(handler.Body!);
        Assert.Equal("device-1", body.RootElement.GetProperty("deviceId").GetString());

        Assert.False(storage.Contains(AuthenticationService.AccessTokenKey));
        Assert.Equal("device-1", storage.Get(AuthenticationService.DeviceIdKey));
    }

    [Fact]
    public async Task GetOrCreateDeviceIdAsync_GeneratesOnce_AndReusesStoredId()
    {
        var storage = new InMemorySecureStorage();
        using var handler = new StubHandler(_ => JsonResponse(HttpStatusCode.OK, "{}"));
        var service = CreateService(handler, storage);

        var first = await service.GetOrCreateDeviceIdAsync();
        var second = await service.GetOrCreateDeviceIdAsync();

        Assert.False(string.IsNullOrWhiteSpace(first));
        Assert.Equal(32, first.Length);
        Assert.Equal(first, second);
        Assert.Equal(first, storage.Get(AuthenticationService.DeviceIdKey));
    }

    [Fact]
    public async Task LoginAsync_WithoutBaseAddress_ReturnsConfigurationError()
    {
        var storage = new InMemorySecureStorage();
        using var handler = new StubHandler(_ => JsonResponse(HttpStatusCode.OK, "{}"));
        var service = CreateService(handler, storage, baseUrl: null);

        var result = await service.LoginAsync("user@example.com", "Secret123!", "device-1");

        Assert.False(result.IsSuccess);
        Assert.Equal("Identity API base URL is not configured.", result.Error);
        Assert.Null(handler.Uri);
    }

    private static AuthenticationService CreateService(
        StubHandler handler,
        ISecureStorageService storage,
        string? baseUrl = "https://identity.test/")
    {
        var client = new HttpClient(handler);
        if (baseUrl is not null)
            client.BaseAddress = new Uri(baseUrl);

        return new AuthenticationService(client, storage);
    }

    private static HttpResponseMessage JsonResponse(HttpStatusCode statusCode, string json)
    {
        return new HttpResponseMessage(statusCode)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
    }

    private static string TokenResponse(string accessToken, string refreshToken, string deviceId)
    {
        return JsonSerializer.Serialize(new
        {
            accessToken,
            refreshToken,
            expiresAt = "2026-10-29T12:00:00Z",
            userId = "user-1",
            deviceId
        });
    }

    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _responder;

        public StubHandler(Func<HttpRequestMessage, HttpResponseMessage> responder)
        {
            _responder = responder;
        }

        public HttpMethod? Method { get; private set; }

        public Uri? Uri { get; private set; }

        public string? Body { get; private set; }

        public AuthenticationHeaderValue? Authorization { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Method = request.Method;
            Uri = request.RequestUri;
            Authorization = request.Headers.Authorization;
            Body = request.Content is null
                ? null
                : await request.Content.ReadAsStringAsync(cancellationToken);

            return _responder(request);
        }
    }
}
