namespace StashHost.IdentityApi.Models;

/// <summary>
/// Request model for device revocation.
/// </summary>
public class RevokeRequest
{
    public string DeviceId { get; set; } = string.Empty;
}
