namespace StashHost.IdentityApi.Models;

/// <summary>
/// Authentication result returned by auth endpoints.
/// </summary>
public class AuthResult
{
    public bool IsSuccess { get; set; }
    public JwtToken? Token { get; set; }
    public string? Error { get; set; }
}
