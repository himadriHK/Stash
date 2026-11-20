using StashHost.IdentityApi.Models;

namespace StashHost.IdentityApi.Services;

/// <summary>
/// Store for user, device, and refresh token data in MongoDB.
/// </summary>
public interface IUserStore
{
    /// <summary>
    /// Creates required indexes (for example, a unique index on user email).
    /// </summary>
    Task EnsureIndexesAsync();

    /// <summary>
    /// Finds a user by email address.
    /// </summary>
    Task<User?> FindUserByEmailAsync(string email);

    /// <summary>
    /// Finds a user by ID.
    /// </summary>
    Task<User?> FindUserByIdAsync(string userId);

    /// <summary>
    /// Creates a new user with the given email and password hash.
    /// </summary>
    Task<User> CreateUserAsync(string email, string passwordHash);

    /// <summary>
    /// Finds a device by device ID and user ID.
    /// </summary>
    Task<Device?> FindDeviceAsync(string userId, string deviceId);

    /// <summary>
    /// Creates a new device registration for a user.
    /// </summary>
    Task<Device> CreateDeviceAsync(string userId, string deviceId);

    /// <summary>
    /// Revokes a device owned by the specified user, invalidating all its refresh tokens.
    /// </summary>
    Task RevokeDeviceAsync(string userId, string deviceId);

    /// <summary>
    /// Finds a refresh token by its token value.
    /// </summary>
    Task<RefreshToken?> FindRefreshTokenAsync(string token);

    /// <summary>
    /// Creates a new refresh token for a user/device pair.
    /// </summary>
    Task<RefreshToken> CreateRefreshTokenAsync(string userId, string deviceId, string token, DateTime expiresAt);

    /// <summary>
    /// Revokes a refresh token.
    /// </summary>
    Task RevokeRefreshTokenAsync(string token);
}
