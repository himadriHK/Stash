using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.IdentityModel.Tokens;
using StashHost.IdentityApi.Models;

namespace StashHost.IdentityApi.Services;

/// <summary>
/// Implementation of JWT token generation, validation, refresh, and revocation.
/// </summary>
public class JwtService : IJwtService
{
    private readonly IUserStore _userStore;
    private readonly IPasswordHasher _passwordHasher;
    private readonly string _signingKey;
    private readonly string _issuer;
    private readonly string _audience;
    private readonly int _accessTokenExpiryMinutes;
    private readonly int _refreshTokenExpiryDays;

    public JwtService(IConfiguration configuration, IUserStore userStore, IPasswordHasher passwordHasher)
    {
        _userStore = userStore;
        _passwordHasher = passwordHasher;
        _signingKey = configuration["Auth:Jwt:SigningKey"] ?? throw new InvalidOperationException("Auth:Jwt:SigningKey is not configured");
        _issuer = configuration["Auth:Jwt:Issuer"] ?? "stash-auth";
        _audience = configuration["Auth:Jwt:Audience"] ?? "stash-app";
        _accessTokenExpiryMinutes = int.Parse(configuration["Auth:Jwt:AccessTokenExpiryMinutes"] ?? "15");
        _refreshTokenExpiryDays = int.Parse(configuration["Auth:Jwt:RefreshTokenExpiryDays"] ?? "7");
    }

    public async Task<JwtToken> RegisterAsync(string email, string password, string deviceId)
    {
        var normalizedEmail = NormalizeEmail(email);

        var existingUser = await _userStore.FindUserByEmailAsync(normalizedEmail);
        if (existingUser is not null)
            throw new EmailAlreadyRegisteredException("A user with this email already exists");

        var user = await _userStore.CreateUserAsync(normalizedEmail, _passwordHasher.Hash(password));
        await _userStore.CreateDeviceAsync(user.Id, deviceId);

        return await IssueTokensAsync(user, deviceId);
    }

    public async Task<JwtToken> LoginAsync(string email, string password, string deviceId)
    {
        var normalizedEmail = NormalizeEmail(email);
        var user = await _userStore.FindUserByEmailAsync(normalizedEmail);

        if (user is null || !user.IsActive || !_passwordHasher.Verify(password, user.PasswordHash))
            throw new InvalidOperationException("Invalid email or password");

        var device = await _userStore.FindDeviceAsync(user.Id, deviceId);
        if (device is null)
        {
            // First login from a new device: register it for this user.
            device = await _userStore.CreateDeviceAsync(user.Id, deviceId);
        }
        else if (device.IsRevoked)
        {
            throw new InvalidOperationException("Device has been revoked");
        }

        return await IssueTokensAsync(user, deviceId);
    }

    public async Task<JwtToken> GenerateTokensAsync(string email, string deviceId)
    {
        var user = await _userStore.FindUserByEmailAsync(NormalizeEmail(email));
        if (user == null || !user.IsActive)
            throw new InvalidOperationException("User not found or inactive");

        var device = await _userStore.FindDeviceAsync(user.Id, deviceId);
        if (device == null || device.IsRevoked)
            throw new InvalidOperationException("Device not found or revoked");

        return await IssueTokensAsync(user, deviceId);
    }

    private async Task<JwtToken> IssueTokensAsync(User user, string deviceId)
    {
        var accessToken = GenerateAccessToken(user.Id, user.Email, deviceId);
        var refreshTokenString = GenerateRefreshToken();
        await _userStore.CreateRefreshTokenAsync(
            user.Id, deviceId, refreshTokenString, DateTime.UtcNow.AddDays(_refreshTokenExpiryDays));

        return new JwtToken
        {
            AccessToken = accessToken,
            RefreshToken = refreshTokenString,
            ExpiresAt = DateTime.UtcNow.AddMinutes(_accessTokenExpiryMinutes),
            UserId = user.Id,
            DeviceId = deviceId
        };
    }

    private static string NormalizeEmail(string email) => email.Trim().ToLowerInvariant();

    public async Task<JwtToken> RefreshTokensAsync(string refreshToken)
    {
        var storedToken = await _userStore.FindRefreshTokenAsync(refreshToken);
        if (storedToken == null || storedToken.IsRevoked || storedToken.ExpiresAt < DateTime.UtcNow)
            throw new InvalidOperationException("Invalid or expired refresh token");

        // Revoke the old refresh token
        await _userStore.RevokeRefreshTokenAsync(refreshToken);

        // Find the user
        var user = await _userStore.FindUserByIdAsync(storedToken.UserId);
        if (user == null || !user.IsActive)
            throw new InvalidOperationException("User not found or inactive");

        // Find the device
        var device = await _userStore.FindDeviceAsync(user.Id, storedToken.DeviceId);
        if (device == null || device.IsRevoked)
            throw new InvalidOperationException("Device not found or revoked");

        // Generate new tokens
        return await IssueTokensAsync(user, storedToken.DeviceId);
    }

    public Task RevokeDeviceAsync(string userId, string deviceId)
    {
        return _userStore.RevokeDeviceAsync(userId, deviceId);
    }

    public ClaimsPrincipal ValidateToken(string token)
    {
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

        return tokenHandler.ValidateToken(token, validationParameters, out _);
    }

    private string GenerateAccessToken(string userId, string email, string deviceId)
    {
        var tokenHandler = new JwtSecurityTokenHandler();
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_signingKey));
        var credentials = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        var claims = new[]
        {
            new Claim(ClaimTypes.NameIdentifier, userId),
            new Claim("userId", userId),
            new Claim(ClaimTypes.Email, email),
            new Claim("deviceId", deviceId),
            new Claim("device_id", deviceId),
            new Claim(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
            new Claim(JwtRegisteredClaimNames.Iat, DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(), ClaimValueTypes.Integer64)
        };

        var token = new JwtSecurityToken(
            issuer: _issuer,
            audience: _audience,
            claims: claims,
            expires: DateTime.UtcNow.AddMinutes(_accessTokenExpiryMinutes),
            signingCredentials: credentials
        );

        return tokenHandler.WriteToken(token);
    }

    private string GenerateRefreshToken()
    {
        var randomNumber = new byte[64];
        using var rng = RandomNumberGenerator.Create();
        rng.GetBytes(randomNumber);
        return Convert.ToBase64String(randomNumber);
    }
}
