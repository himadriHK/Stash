using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using StashHost.Functions.Middleware;
using StashHost.IdentityApi.Models;
using StashHost.IdentityApi.Services;

namespace StashHost.Tests;

public sealed class IdentityApiFactory : WebApplicationFactory<Program>
{
    public InMemoryUserStore Store { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");
        builder.ConfigureServices(services =>
        {
            services.RemoveAll<IUserStore>();
            services.AddSingleton<IUserStore>(Store);
        });
    }
}

/// <summary>
/// In-memory IUserStore used to exercise the Identity API endpoints without MongoDB.
/// </summary>
public sealed class InMemoryUserStore : IUserStore
{
    private readonly object _gate = new();
    private readonly List<User> _users = [];
    private readonly List<Device> _devices = [];
    private readonly List<RefreshToken> _refreshTokens = [];

    public IReadOnlyList<User> Users
    {
        get { lock (_gate) return _users.ToList(); }
    }

    public IReadOnlyList<Device> Devices
    {
        get { lock (_gate) return _devices.ToList(); }
    }

    public Task EnsureIndexesAsync() => Task.CompletedTask;

    public Task<User?> FindUserByEmailAsync(string email)
    {
        lock (_gate)
            return Task.FromResult(_users.FirstOrDefault(u => u.Email == email));
    }

    public Task<User?> FindUserByIdAsync(string userId)
    {
        lock (_gate)
            return Task.FromResult(_users.FirstOrDefault(u => u.Id == userId));
    }

    public Task<User> CreateUserAsync(string email, string passwordHash)
    {
        var user = new User
        {
            Id = Guid.NewGuid().ToString("N"),
            Email = email,
            PasswordHash = passwordHash,
            CreatedAt = DateTime.UtcNow,
            IsActive = true
        };

        lock (_gate) _users.Add(user);
        return Task.FromResult(user);
    }

    public Task<Device?> FindDeviceAsync(string userId, string deviceId)
    {
        lock (_gate)
        {
            return Task.FromResult(_devices.FirstOrDefault(
                d => d.UserId == userId && d.DeviceId == deviceId));
        }
    }

    public Task<Device> CreateDeviceAsync(string userId, string deviceId)
    {
        var device = new Device
        {
            Id = Guid.NewGuid().ToString("N"),
            UserId = userId,
            DeviceId = deviceId,
            IsRevoked = false,
            CreatedAt = DateTime.UtcNow
        };

        lock (_gate) _devices.Add(device);
        return Task.FromResult(device);
    }

    public Task RevokeDeviceAsync(string userId, string deviceId)
    {
        lock (_gate)
        {
            foreach (var device in _devices.Where(d => d.UserId == userId && d.DeviceId == deviceId))
                device.IsRevoked = true;

            foreach (var token in _refreshTokens.Where(t => t.UserId == userId && t.DeviceId == deviceId))
                token.IsRevoked = true;
        }

        return Task.CompletedTask;
    }

    public Task<RefreshToken?> FindRefreshTokenAsync(string token)
    {
        lock (_gate)
            return Task.FromResult(_refreshTokens.FirstOrDefault(t => t.Token == token));
    }

    public Task<RefreshToken> CreateRefreshTokenAsync(
        string userId, string deviceId, string token, DateTime expiresAt)
    {
        var refreshToken = new RefreshToken
        {
            Id = Guid.NewGuid().ToString("N"),
            UserId = userId,
            DeviceId = deviceId,
            Token = token,
            ExpiresAt = expiresAt,
            IsRevoked = false,
            CreatedAt = DateTime.UtcNow
        };

        lock (_gate) _refreshTokens.Add(refreshToken);
        return Task.FromResult(refreshToken);
    }

    public Task RevokeRefreshTokenAsync(string token)
    {
        lock (_gate)
        {
            var stored = _refreshTokens.FirstOrDefault(t => t.Token == token);
            if (stored is not null)
                stored.IsRevoked = true;
        }

        return Task.CompletedTask;
    }
}

public class Phase2IdentityApiTests
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    [Fact]
    public async Task Health_ReturnsHealthy()
    {
        using var factory = new IdentityApiFactory();
        using var client = factory.CreateClient();

        var response = await client.GetAsync("/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal("healthy", json.RootElement.GetProperty("status").GetString());
    }

    [Fact]
    public async Task Register_NewUser_ReturnsTokensAndPersistsUser()
    {
        using var factory = new IdentityApiFactory();
        using var client = factory.CreateClient();

        var tokens = await RegisterAsync(client, "new@example.com", "Password123!", "device-1");

        Assert.False(string.IsNullOrWhiteSpace(tokens.AccessToken));
        Assert.False(string.IsNullOrWhiteSpace(tokens.RefreshToken));
        Assert.False(string.IsNullOrWhiteSpace(tokens.UserId));
        Assert.Equal("device-1", tokens.DeviceId);

        var user = Assert.Single(factory.Store.Users);
        Assert.Equal("new@example.com", user.Email);
        Assert.NotEqual("Password123!", user.PasswordHash);
        Assert.StartsWith("pbkdf2-sha256$", user.PasswordHash);
    }

    [Fact]
    public async Task Register_DuplicateEmail_ReturnsConflict()
    {
        using var factory = new IdentityApiFactory();
        using var client = factory.CreateClient();

        await RegisterAsync(client, "duplicate@example.com", "Password123!", "device-1");

        var response = await client.PostAsJsonAsync("/api/auth/register", new RegisterRequest
        {
            Email = "DUPLICATE@example.com",
            Password = "Password123!",
            DeviceId = "device-2"
        });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
    }

    [Fact]
    public async Task Register_InvalidInput_ReturnsBadRequest()
    {
        using var factory = new IdentityApiFactory();
        using var client = factory.CreateClient();

        var response = await client.PostAsJsonAsync("/api/auth/register", new RegisterRequest
        {
            Email = "not-an-email",
            Password = "short",
            DeviceId = "device-1"
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Login_ValidCredentials_ReturnsTokens()
    {
        using var factory = new IdentityApiFactory();
        using var client = factory.CreateClient();

        await RegisterAsync(client, "login@example.com", "Password123!", "device-1");

        var response = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest
        {
            Email = "login@example.com",
            Password = "Password123!",
            DeviceId = "device-1"
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var tokens = await response.Content.ReadFromJsonAsync<JwtToken>(JsonOptions);
        Assert.NotNull(tokens);
        Assert.False(string.IsNullOrWhiteSpace(tokens!.AccessToken));
    }

    [Fact]
    public async Task Login_InvalidPassword_ReturnsUnauthorized()
    {
        using var factory = new IdentityApiFactory();
        using var client = factory.CreateClient();

        await RegisterAsync(client, "wrong-password@example.com", "Password123!", "device-1");

        var response = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest
        {
            Email = "wrong-password@example.com",
            Password = "WrongPassword!",
            DeviceId = "device-1"
        });

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Login_NewDevice_RegistersDevice()
    {
        using var factory = new IdentityApiFactory();
        using var client = factory.CreateClient();

        await RegisterAsync(client, "new-device@example.com", "Password123!", "device-1");

        var response = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest
        {
            Email = "new-device@example.com",
            Password = "Password123!",
            DeviceId = "device-2"
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains(factory.Store.Devices, d => d.DeviceId == "device-2" && !d.IsRevoked);
    }

    [Fact]
    public async Task Refresh_ValidToken_RotatesTokenAndRejectsReuse()
    {
        using var factory = new IdentityApiFactory();
        using var client = factory.CreateClient();

        var original = await RegisterAsync(client, "refresh@example.com", "Password123!", "device-1");

        var refreshResponse = await client.PostAsJsonAsync("/api/auth/refresh", new RefreshRequest
        {
            RefreshToken = original.RefreshToken
        });

        Assert.Equal(HttpStatusCode.OK, refreshResponse.StatusCode);
        var refreshed = await refreshResponse.Content.ReadFromJsonAsync<JwtToken>(JsonOptions);
        Assert.NotNull(refreshed);
        Assert.NotEqual(original.RefreshToken, refreshed!.RefreshToken);

        var reuseResponse = await client.PostAsJsonAsync("/api/auth/refresh", new RefreshRequest
        {
            RefreshToken = original.RefreshToken
        });

        Assert.Equal(HttpStatusCode.Unauthorized, reuseResponse.StatusCode);
    }

    [Fact]
    public async Task Refresh_InvalidToken_ReturnsUnauthorized()
    {
        using var factory = new IdentityApiFactory();
        using var client = factory.CreateClient();

        var response = await client.PostAsJsonAsync("/api/auth/refresh", new RefreshRequest
        {
            RefreshToken = "not-a-real-token"
        });

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Revoke_Device_InvalidatesRefreshAndLogin()
    {
        using var factory = new IdentityApiFactory();
        using var client = factory.CreateClient();

        var tokens = await RegisterAsync(client, "revoke@example.com", "Password123!", "device-1");
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", tokens.AccessToken);

        var revokeResponse = await client.PostAsJsonAsync("/api/auth/revoke", new RevokeRequest
        {
            DeviceId = "device-1"
        });
        Assert.Equal(HttpStatusCode.OK, revokeResponse.StatusCode);

        var refreshResponse = await client.PostAsJsonAsync("/api/auth/refresh", new RefreshRequest
        {
            RefreshToken = tokens.RefreshToken
        });
        Assert.Equal(HttpStatusCode.Unauthorized, refreshResponse.StatusCode);

        var loginResponse = await client.PostAsJsonAsync("/api/auth/login", new LoginRequest
        {
            Email = "revoke@example.com",
            Password = "Password123!",
            DeviceId = "device-1"
        });
        Assert.Equal(HttpStatusCode.Unauthorized, loginResponse.StatusCode);
    }

    [Fact]
    public async Task Revoke_WithoutAuthentication_ReturnsUnauthorized()
    {
        using var factory = new IdentityApiFactory();
        using var client = factory.CreateClient();

        var response = await client.PostAsJsonAsync("/api/auth/revoke", new RevokeRequest
        {
            DeviceId = "device-1"
        });

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Revoke_IsScopedToTheAuthenticatedUser()
    {
        using var factory = new IdentityApiFactory();
        using var client = factory.CreateClient();

        var alice = await RegisterAsync(client, "alice@example.com", "Password123!", "shared-device");
        var bob = await RegisterAsync(client, "bob@example.com", "Password123!", "shared-device");

        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", alice.AccessToken);

        var revokeResponse = await client.PostAsJsonAsync("/api/auth/revoke", new RevokeRequest
        {
            DeviceId = "shared-device"
        });
        Assert.Equal(HttpStatusCode.OK, revokeResponse.StatusCode);

        var aliceRefresh = await client.PostAsJsonAsync("/api/auth/refresh", new RefreshRequest
        {
            RefreshToken = alice.RefreshToken
        });
        Assert.Equal(HttpStatusCode.Unauthorized, aliceRefresh.StatusCode);

        // Bob registered the same device id under a different userId; Alice must not
        // be able to revoke Bob's device or refresh tokens.
        var bobRefresh = await client.PostAsJsonAsync("/api/auth/refresh", new RefreshRequest
        {
            RefreshToken = bob.RefreshToken
        });
        Assert.Equal(HttpStatusCode.OK, bobRefresh.StatusCode);
    }

    [Fact]
    public async Task AccessToken_ContainsUserIdDeviceIdAndExpectedIssuerAudience()
    {
        using var factory = new IdentityApiFactory();
        using var client = factory.CreateClient();

        var tokens = await RegisterAsync(client, "claims@example.com", "Password123!", "device-claims");
        var jwt = new JwtSecurityTokenHandler().ReadJwtToken(tokens.AccessToken);

        Assert.Equal("stash-auth", jwt.Issuer);
        Assert.Contains("stash-app", jwt.Audiences);
        Assert.Equal(tokens.UserId, jwt.Claims.Single(c => c.Type == "userId").Value);
        Assert.Equal("device-claims", jwt.Claims.Single(c => c.Type == "deviceId").Value);
    }

    [Fact]
    public async Task AccessToken_ValidatesWithStashHostJwtValidationMiddleware()
    {
        using var factory = new IdentityApiFactory();
        using var client = factory.CreateClient();

        var tokens = await RegisterAsync(client, "middleware-valid@example.com", "Password123!", "device-1");
        var signingKey = factory.Services.GetRequiredService<IConfiguration>()["Auth:Jwt:SigningKey"];
        Assert.False(string.IsNullOrWhiteSpace(signingKey));

        var middleware = new JwtValidationMiddleware(signingKey!, "stash-auth", "stash-app");
        var headers = new Dictionary<string, object>
        {
            ["Authorization"] = $"Bearer {tokens.AccessToken}"
        };

        Assert.True(middleware.Validate(headers));
    }

    [Fact]
    public async Task AccessToken_SignedWithDifferentKey_IsRejectedByStashHostJwtValidationMiddleware()
    {
        using var factory = new IdentityApiFactory();
        using var client = factory.CreateClient();

        var tokens = await RegisterAsync(client, "middleware-invalid@example.com", "Password123!", "device-1");
        var middleware = new JwtValidationMiddleware(
            "a-different-signing-key-that-is-at-least-32-characters",
            "stash-auth",
            "stash-app");

        var headers = new Dictionary<string, object>
        {
            ["Authorization"] = $"Bearer {tokens.AccessToken}"
        };

        Assert.False(middleware.Validate(headers));
    }

    [Fact]
    public async Task Cors_PreflightForConfiguredOrigin_IsAllowed()
    {
        using var factory = new IdentityApiFactory();
        using var client = factory.CreateClient();

        using var request = new HttpRequestMessage(HttpMethod.Options, "/api/auth/login");
        request.Headers.Add("Origin", "http://localhost:5102");
        request.Headers.Add("Access-Control-Request-Method", "POST");

        var response = await client.SendAsync(request);

        Assert.True(response.Headers.TryGetValues("Access-Control-Allow-Origin", out var origins));
        Assert.Contains("http://localhost:5102", origins);
    }

    private static async Task<JwtToken> RegisterAsync(
        HttpClient client, string email, string password, string deviceId)
    {
        var response = await client.PostAsJsonAsync("/api/auth/register", new RegisterRequest
        {
            Email = email,
            Password = password,
            DeviceId = deviceId
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var tokens = await response.Content.ReadFromJsonAsync<JwtToken>(JsonOptions);
        Assert.NotNull(tokens);
        return tokens!;
    }
}

public class PasswordHasherTests
{
    private readonly PasswordHasher _hasher = new();

    [Fact]
    public void Hash_DoesNotContainPlaintextAndUsesSalt()
    {
        var first = _hasher.Hash("Password123!");
        var second = _hasher.Hash("Password123!");

        Assert.DoesNotContain("Password123!", first);
        Assert.NotEqual(first, second);
        Assert.StartsWith("pbkdf2-sha256$", first);
    }

    [Fact]
    public void Verify_AcceptsCorrectPassword_RejectsWrongPassword()
    {
        var hash = _hasher.Hash("Password123!");

        Assert.True(_hasher.Verify("Password123!", hash));
        Assert.False(_hasher.Verify("Password124!", hash));
        Assert.False(_hasher.Verify("Password123!", "not-a-valid-hash"));
    }
}
