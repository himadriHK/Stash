using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;
using StashHost.IdentityApi.Models;
using StashHost.IdentityApi.Services;
using System.Net.Mail;
using System.Security.Claims;
using System.Text;

var builder = WebApplication.CreateBuilder(args);

// Configuration
var signingKey = builder.Configuration["Auth:Jwt:SigningKey"] ?? throw new InvalidOperationException("Auth:Jwt:SigningKey is not configured");
var issuer = builder.Configuration["Auth:Jwt:Issuer"] ?? "stash-auth";
var audience = builder.Configuration["Auth:Jwt:Audience"] ?? "stash-app";

// Services
builder.Services.AddSingleton<IPasswordHasher, PasswordHasher>();
builder.Services.AddSingleton<IJwtService, JwtService>();
builder.Services.AddSingleton<IUserStore, MongoUserStore>();

//CORS (native mobile clients do not need it, but browser-based tools/testing may)
//var allowedOrigins = ["http://localhost:8081"];//builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>() ?? [];
 //if (allowedOrigins.Length > 0)
 {
     builder.Services.AddCors(options =>
     {
         options.AddDefaultPolicy(policy =>
             policy.WithOrigins("http://localhost:8081")
                 .AllowAnyHeader()
                 .AllowAnyMethod());
     });
 }

// Authentication
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(signingKey)),
            ValidateIssuer = true,
            ValidIssuer = issuer,
            ValidateAudience = true,
            ValidAudience = audience,
            ValidateLifetime = true,
            ClockSkew = TimeSpan.Zero
        };
    });

builder.Services.AddAuthorization();

var app = builder.Build();

// Ensure MongoDB indexes exist before accepting requests.
await app.Services.GetRequiredService<IUserStore>().EnsureIndexesAsync();

// if (allowedOrigins.Length > 0)
app.UseCors();

// Authentication middleware
app.UseAuthentication();
app.UseAuthorization();

// POST /api/auth/register - Register a new user
app.MapPost("/api/auth/register", async (RegisterRequest req, IJwtService jwtService) =>
{
    var validationError = ValidateRegistration(req);
    if (validationError is not null)
        return Results.BadRequest(new { error = validationError });

    try
    {
        var tokens = await jwtService.RegisterAsync(req.Email, req.Password, req.DeviceId);
        return Results.Ok(tokens);
    }
    catch (EmailAlreadyRegisteredException ex)
    {
        return Results.Conflict(new { error = ex.Message });
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

// POST /api/auth/login - Authenticate a user
app.MapPost("/api/auth/login", async (LoginRequest req, IJwtService jwtService) =>
{
    if (string.IsNullOrWhiteSpace(req.Email)
        || string.IsNullOrWhiteSpace(req.Password)
        || string.IsNullOrWhiteSpace(req.DeviceId))
    {
        return Results.BadRequest(new { error = "Email, password and device ID are required" });
    }

    try
    {
        var tokens = await jwtService.LoginAsync(req.Email, req.Password, req.DeviceId);
        return Results.Ok(tokens);
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: 401);
    }
});

// POST /api/auth/refresh - Refresh an access token
app.MapPost("/api/auth/refresh", async (RefreshRequest req, IJwtService jwtService) =>
{
    if (string.IsNullOrWhiteSpace(req.RefreshToken))
        return Results.BadRequest(new { error = "Refresh token is required" });

    try
    {
        var tokens = await jwtService.RefreshTokensAsync(req.RefreshToken);
        return Results.Ok(tokens);
    }
    catch (InvalidOperationException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: 401);
    }
});

// POST /api/auth/revoke - Revoke a device owned by the authenticated user
app.MapPost("/api/auth/revoke", async (
    RevokeRequest req,
    ClaimsPrincipal principal,
    IJwtService jwtService) =>
{
    if (string.IsNullOrWhiteSpace(req.DeviceId))
        return Results.BadRequest(new { error = "Device ID is required" });

    var userId = principal.FindFirst("userId")?.Value
        ?? principal.FindFirst(ClaimTypes.NameIdentifier)?.Value;

    if (string.IsNullOrWhiteSpace(userId))
        return Results.Unauthorized();

    await jwtService.RevokeDeviceAsync(userId, req.DeviceId);
    return Results.Ok(new { message = "Device revoked successfully" });
}).RequireAuthorization();

// Health check endpoint
app.MapGet("/health", () => Results.Ok(new { status = "healthy", timestamp = DateTime.UtcNow }));

app.Run();

static string? ValidateRegistration(RegisterRequest req)
{
    if (string.IsNullOrWhiteSpace(req.Email) || string.IsNullOrWhiteSpace(req.Password))
        return "Email and password are required";

    if (string.IsNullOrWhiteSpace(req.DeviceId))
        return "Device ID is required";

    if (!MailAddress.TryCreate(req.Email, out _))
        return "Email is not valid";

    if (req.Password.Length < 8)
        return "Password must be at least 8 characters";

    return null;
}

// Exposed for integration tests (WebApplicationFactory).
public partial class Program
{
}
