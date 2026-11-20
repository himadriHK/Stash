using System.Text.Json;

namespace Stash.Maui.Auth;

/// <summary>
/// Token pair returned by the Identity API.
/// </summary>
public sealed class JwtToken
{
    public string AccessToken { get; set; } = string.Empty;

    public string RefreshToken { get; set; } = string.Empty;

    public DateTime ExpiresAt { get; set; }

    public string UserId { get; set; } = string.Empty;

    public string DeviceId { get; set; } = string.Empty;
}

/// <summary>
/// Response envelope returned by the Identity API's register/login/refresh endpoints.
/// </summary>
public sealed class AuthResult
{
    public bool IsSuccess { get; set; }

    public JwtToken? Token { get; set; }

    public string? Error { get; set; }

    public static AuthResult Success(JwtToken token) => new()
    {
        IsSuccess = true,
        Token = token
    };

    public static AuthResult Failed(string error) => new()
    {
        IsSuccess = false,
        Error = error
    };
}

/// <summary>
/// Shared JSON options for Identity API requests and responses. ASP.NET Core uses
/// camelCase by default; the web defaults match that contract.
/// </summary>
internal static class AuthJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);
}

internal sealed record CredentialsRequest(string Email, string Password, string DeviceId);

internal sealed record RefreshRequest(string RefreshToken);

internal sealed record RevokeRequest(string DeviceId);
