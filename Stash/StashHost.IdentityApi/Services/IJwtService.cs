using System.Security.Claims;
using StashHost.IdentityApi.Models;

namespace StashHost.IdentityApi.Services;

/// <summary>
/// Service for JWT token generation, validation, refresh, and revocation.
/// </summary>
public interface IJwtService
{
    /// <summary>
    /// Registers a new user and device, then returns an access/refresh token pair.
    /// </summary>
    Task<JwtToken> RegisterAsync(string email, string password, string deviceId);

    /// <summary>
    /// Validates credentials and returns an access/refresh token pair, registering the
    /// device on first use.
    /// </summary>
    Task<JwtToken> LoginAsync(string email, string password, string deviceId);

    /// <summary>
    /// Generates an access token and refresh token for an existing user/device pair.
    /// </summary>
    Task<JwtToken> GenerateTokensAsync(string email, string deviceId);

    /// <summary>
    /// Refreshes an access token using a valid refresh token.
    /// </summary>
    Task<JwtToken> RefreshTokensAsync(string refreshToken);

    /// <summary>
    /// Revokes all tokens for a device owned by the user, logging the user out of that device.
    /// </summary>
    Task RevokeDeviceAsync(string userId, string deviceId);

    /// <summary>
    /// Validates a JWT token and returns the claims principal if valid.
    /// </summary>
    ClaimsPrincipal ValidateToken(string token);
}
