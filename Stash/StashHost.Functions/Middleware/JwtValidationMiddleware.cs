namespace StashHost.Functions.Middleware;

/// <summary>
/// Middleware-style wrapper around <see cref="JwtValidator"/> for callers that only need
/// a boolean result (for example, the Identity API integration tests).
/// </summary>
public class JwtValidationMiddleware
{
    private readonly JwtValidator _validator;

    public JwtValidationMiddleware(string signingKey, string issuer, string audience)
    {
        _validator = new JwtValidator(signingKey, issuer, audience);
    }

    public bool Validate(IDictionary<string, object> headers) =>
        _validator.Validate(headers) is not null;
}
