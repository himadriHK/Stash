namespace StashHost.IdentityApi.Models;

/// <summary>
/// Request model for user registration.
/// </summary>
public class RegisterRequest
{
    public string Email { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;
    public string DeviceId { get; set; } = string.Empty;
}
