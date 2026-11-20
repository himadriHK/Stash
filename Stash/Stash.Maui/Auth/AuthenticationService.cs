using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Globalization;

namespace Stash.Maui.Auth;

/// <summary>
/// Identity API client with SecureStorage-backed token persistence.
/// </summary>
public sealed class AuthenticationService : IAuthenticationService
{
    public const string AccessTokenKey = "stash.auth.access_token";
    public const string RefreshTokenKey = "stash.auth.refresh_token";
    public const string ExpiresAtKey = "stash.auth.expires_at";
    public const string UserIdKey = "stash.auth.user_id";
    public const string DeviceIdKey = "stash.auth.device_id";

    private readonly HttpClient _httpClient;
    private readonly ISecureStorageService _secureStorage;

    public AuthenticationService(HttpClient httpClient, ISecureStorageService secureStorage)
    {
        _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        _secureStorage = secureStorage ?? throw new ArgumentNullException(nameof(secureStorage));
    }

    public Task<AuthResult> RegisterAsync(
        string email,
        string password,
        string deviceId,
        CancellationToken ct = default)
    {
        return AuthenticateAsync(
            "api/auth/register",
            new CredentialsRequest(email, password, deviceId),
            ct);
    }

    public Task<AuthResult> LoginAsync(
        string email,
        string password,
        string deviceId,
        CancellationToken ct = default)
    {
        return AuthenticateAsync(
            "api/auth/login",
            new CredentialsRequest(email, password, deviceId),
            ct);
    }

    public async Task<string> GetAccessTokenAsync(CancellationToken ct = default)
    {
        return await _secureStorage.GetAsync(AccessTokenKey, ct) ?? string.Empty;
    }

    public async Task<bool> EnsureValidAccessTokenAsync(CancellationToken ct = default)
    {
        var accessToken = await GetAccessTokenAsync(ct);
        if (string.IsNullOrWhiteSpace(accessToken))
            return await RefreshTokenAsync(ct);

        var expiresAtValue = await _secureStorage.GetAsync(ExpiresAtKey, ct);
        if (DateTimeOffset.TryParse(
                expiresAtValue,
                CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind,
                out var expiresAt)
            && expiresAt > DateTimeOffset.UtcNow.AddMinutes(1))
        {
            return true;
        }

        return await RefreshTokenAsync(ct);
    }

    public async Task<bool> RefreshTokenAsync(CancellationToken ct = default)
    {
        var refreshToken = await _secureStorage.GetAsync(RefreshTokenKey, ct);
        if (string.IsNullOrWhiteSpace(refreshToken))
            return false;

        if (_httpClient.BaseAddress is null)
            return false;

        using var response = await _httpClient.PostAsJsonAsync(
            "api/auth/refresh",
            new RefreshRequest(refreshToken),
            AuthJson.Options,
            ct);

        if (!response.IsSuccessStatusCode)
        {
            // An invalid/expired refresh token cannot be retried. Clear the session so
            // the UI can return to login instead of repeatedly sending a dead token.
            await ClearSessionAsync(ct);
            return false;
        }

        var token = await ReadTokenAsync(response, ct);
        if (token is null)
        {
            await ClearSessionAsync(ct);
            return false;
        }

        await PersistTokenAsync(token, ct);
        return true;
    }

    public async Task<string> GetUserIdAsync(CancellationToken ct = default)
    {
        return await _secureStorage.GetAsync(UserIdKey, ct) ?? string.Empty;
    }

    public async Task LogoutAsync(CancellationToken ct = default)
    {
        await ClearSessionAsync(ct);
    }

    public async Task<bool> RevokeDeviceAsync(string deviceId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(deviceId) || _httpClient.BaseAddress is null)
            return false;

        var accessToken = await GetAccessTokenAsync(ct);
        if (string.IsNullOrWhiteSpace(accessToken))
            return false;

        using var request = new HttpRequestMessage(HttpMethod.Post, "api/auth/revoke")
        {
            Content = JsonContent.Create(new RevokeRequest(deviceId), options: AuthJson.Options)
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);

        using var response = await _httpClient.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode)
            return false;

        // Revoking the current device invalidates the token pair on the server.
        var storedDeviceId = await _secureStorage.GetAsync(DeviceIdKey, ct);
        if (string.Equals(storedDeviceId, deviceId, StringComparison.Ordinal))
            await ClearSessionAsync(ct);

        return true;
    }

    public async Task<string> GetOrCreateDeviceIdAsync(CancellationToken ct = default)
    {
        var deviceId = await _secureStorage.GetAsync(DeviceIdKey, ct);
        if (!string.IsNullOrWhiteSpace(deviceId))
            return deviceId;

        deviceId = Guid.NewGuid().ToString("N");
        await _secureStorage.SetAsync(DeviceIdKey, deviceId, ct);
        return deviceId;
    }

    private async Task<AuthResult> AuthenticateAsync(
        string path,
        CredentialsRequest credentials,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(credentials.Email)
            || string.IsNullOrWhiteSpace(credentials.Password)
            || string.IsNullOrWhiteSpace(credentials.DeviceId))
        {
            return AuthResult.Failed("Email, password and device ID are required.");
        }

        if (_httpClient.BaseAddress is null)
            return AuthResult.Failed("Identity API base URL is not configured.");

        using var response = await _httpClient.PostAsJsonAsync(path, credentials, AuthJson.Options, ct);

        if (!response.IsSuccessStatusCode)
        {
            var error = await ReadErrorAsync(response, ct)
                ?? response.ReasonPhrase
                ?? $"Request failed ({(int)response.StatusCode}).";
            return AuthResult.Failed(error);
        }

        var token = await ReadTokenAsync(response, ct);
        if (token is null)
            return AuthResult.Failed("The identity service returned an invalid response.");

        await PersistTokenAsync(token, ct);
        return AuthResult.Success(token);
    }

    private async Task PersistTokenAsync(JwtToken token, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(token.AccessToken) || string.IsNullOrWhiteSpace(token.RefreshToken))
            throw new InvalidOperationException("The identity service returned an incomplete token pair.");

        await _secureStorage.SetAsync(AccessTokenKey, token.AccessToken, ct);
        await _secureStorage.SetAsync(RefreshTokenKey, token.RefreshToken, ct);
        await _secureStorage.SetAsync(ExpiresAtKey, token.ExpiresAt.ToUniversalTime().ToString("O"), ct);
        await _secureStorage.SetAsync(UserIdKey, token.UserId, ct);

        if (!string.IsNullOrWhiteSpace(token.DeviceId))
            await _secureStorage.SetAsync(DeviceIdKey, token.DeviceId, ct);
    }

    private async Task ClearSessionAsync(CancellationToken ct)
    {
        await _secureStorage.RemoveAsync(AccessTokenKey, ct);
        await _secureStorage.RemoveAsync(RefreshTokenKey, ct);
        await _secureStorage.RemoveAsync(ExpiresAtKey, ct);
        await _secureStorage.RemoveAsync(UserIdKey, ct);
        // Keep DeviceIdKey: it is the stable installation identifier, not a credential.
    }

    private static async Task<JwtToken?> ReadTokenAsync(
        HttpResponseMessage response,
        CancellationToken ct)
    {
        if (response.Content.Headers.ContentLength == 0)
            return null;

        try
        {
            var token = await response.Content.ReadFromJsonAsync<JwtToken>(AuthJson.Options, ct);
            return token is not null
                && !string.IsNullOrWhiteSpace(token.AccessToken)
                && !string.IsNullOrWhiteSpace(token.RefreshToken)
                ? token
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
        catch (NotSupportedException)
        {
            return null;
        }
    }

    private static async Task<string?> ReadErrorAsync(HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            var body = await response.Content.ReadAsStringAsync(ct);
            if (string.IsNullOrWhiteSpace(body))
                return null;

            using var document = JsonDocument.Parse(body);
            if (document.RootElement.ValueKind != JsonValueKind.Object)
                return null;

            if (document.RootElement.TryGetProperty("error", out var error))
                return error.GetString();

            if (document.RootElement.TryGetProperty("title", out var title))
                return title.GetString();
        }
        catch (JsonException)
        {
        }

        return null;
    }
}
