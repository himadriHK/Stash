namespace StashHost.IdentityApi.Models;

/// <summary>
/// Request model for token refresh.
/// </summary>
public class RefreshRequest
{
    public string RefreshToken { get; set; } = string.Empty;
}
