namespace Stash.Maui.Auth;

/// <summary>
/// Authentication operations used by the mobile UI, upload manager, and Kafka producer.
/// </summary>
public interface IAuthenticationService
{
    Task<AuthResult> RegisterAsync(
        string email,
        string password,
        string deviceId,
        CancellationToken ct = default);

    Task<AuthResult> LoginAsync(
        string email,
        string password,
        string deviceId,
        CancellationToken ct = default);

    Task<string> GetAccessTokenAsync(CancellationToken ct = default);

    /// <summary>
    /// Ensures a usable access token is available, refreshing it when the stored
    /// token is missing or close to expiry. Background work uses this because the
    /// app may not have run in the foreground for longer than the token lifetime.
    /// </summary>
    Task<bool> EnsureValidAccessTokenAsync(CancellationToken ct = default);

    /// <summary>
    /// Gets the authenticated user ID persisted after login, or an empty string.
    /// The Kafka producer uses this for the X-User-Id header.
    /// </summary>
    Task<string> GetUserIdAsync(CancellationToken ct = default);

    Task<bool> RefreshTokenAsync(CancellationToken ct = default);

    Task LogoutAsync(CancellationToken ct = default);

    Task<bool> RevokeDeviceAsync(string deviceId, CancellationToken ct = default);

    /// <summary>
    /// Gets the stable installation identifier, creating and persisting one on first use.
    /// </summary>
    Task<string> GetOrCreateDeviceIdAsync(CancellationToken ct = default);
}
