namespace StashHost.IdentityApi.Models;

/// <summary>
/// JWT token pair returned by register/login/refresh endpoints.
/// </summary>
public class JwtToken
{
    public string AccessToken { get; set; } = string.Empty;
    public string RefreshToken { get; set; } = string.Empty;
    public DateTime ExpiresAt { get; set; }
    public string UserId { get; set; } = string.Empty;
    public string DeviceId { get; set; } = string.Empty;
}
