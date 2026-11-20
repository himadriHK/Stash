using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.IdentityModel.Tokens;

namespace StashHost.Functions.Middleware;

/// <summary>
/// Interface for JWT token validation from Kafka headers.
/// </summary>
public interface IJwtValidator
{
    /// <summary>
    /// Validates a JWT token from Kafka message headers.
    /// </summary>
    /// <param name="headers">Kafka message headers containing the Authorization header.</param>
    /// <returns>The validated ClaimsPrincipal if the token is valid, null otherwise.</returns>
    ClaimsPrincipal? Validate(IDictionary<string, object> headers);
}

/// <summary>
/// Implementation of JWT token validation using Microsoft.IdentityModel.Tokens.
/// </summary>
public class JwtValidator : IJwtValidator
{
    private readonly string _signingKey;
    private readonly string _issuer;
    private readonly string _audience;

    public JwtValidator(string signingKey, string issuer, string audience)
    {
        _signingKey = signingKey;
        _issuer = issuer;
        _audience = audience;
    }

    public ClaimsPrincipal? Validate(IDictionary<string, object> headers)
    {
        if (headers is null || !TryGetHeader(headers, "Authorization", out var authHeader))
            return null;

        var headerValue = NormalizeHeaderValue(authHeader);
        if (string.IsNullOrWhiteSpace(headerValue)) return null;

        var token = headerValue.Trim();
        if (token.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            token = token["Bearer ".Length..].Trim();

        if (string.IsNullOrEmpty(token)) return null;

        var tokenHandler = new JwtSecurityTokenHandler();
        var validationParameters = new TokenValidationParameters
        {
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_signingKey)),
            ValidateIssuer = true,
            ValidIssuer = _issuer,
            ValidateAudience = true,
            ValidAudience = _audience,
            ValidateLifetime = true,
            ClockSkew = TimeSpan.Zero
        };

        try
        {
            return tokenHandler.ValidateToken(token, validationParameters, out _);
        }
        catch
        {
            return null;
        }
    }

    private static bool TryGetHeader(
        IDictionary<string, object> headers,
        string name,
        out object? value)
    {
        if (headers.TryGetValue(name, out value))
            return true;

        foreach (var header in headers)
        {
            if (string.Equals(header.Key, name, StringComparison.OrdinalIgnoreCase))
            {
                value = header.Value;
                return true;
            }
        }

        value = null;
        return false;
    }

    private static string? NormalizeHeaderValue(object? value) => value switch
    {
        null => null,
        string text => text,
        byte[] bytes => Encoding.UTF8.GetString(bytes),
        _ => value.ToString()
    };
}
