using Microsoft.Extensions.Configuration;
using MongoDB.Bson.Serialization.Conventions;
using MongoDB.Driver;
using StashHost.IdentityApi.Models;

namespace StashHost.IdentityApi.Services;

/// <summary>
/// MongoDB implementation of IUserStore.
/// </summary>
public class MongoUserStore : IUserStore
{
    private static readonly object ConventionLock = new();
    private static bool _conventionsRegistered;

    private readonly IMongoCollection<User> _users;
    private readonly IMongoCollection<Device> _devices;
    private readonly IMongoCollection<RefreshToken> _refreshTokens;

    public MongoUserStore(IConfiguration configuration)
    {
        RegisterCamelCaseConventions();

        var connectionString = configuration["MongoDB:ConnectionString"] ?? "mongodb://localhost:27017";
        var databaseName = configuration["MongoDB:DatabaseName"] ?? "stash";

        var client = new MongoClient(connectionString);
        var database = client.GetDatabase(databaseName);

        _users = database.GetCollection<User>("users");
        _devices = database.GetCollection<Device>("devices");
        _refreshTokens = database.GetCollection<RefreshToken>("refresh_tokens");
    }

    public async Task EnsureIndexesAsync()
    {
        var emailIndex = new CreateIndexModel<User>(
            Builders<User>.IndexKeys.Ascending(u => u.Email),
            new CreateIndexOptions { Unique = true, Name = "ux_users_email" });

        await _users.Indexes.CreateOneAsync(emailIndex);
    }

    public async Task<User?> FindUserByEmailAsync(string email)
    {
        return await _users.Find(u => u.Email == email).FirstOrDefaultAsync();
    }

    public async Task<User?> FindUserByIdAsync(string userId)
    {
        return await _users.Find(u => u.Id == userId).FirstOrDefaultAsync();
    }

    public async Task<User> CreateUserAsync(string email, string passwordHash)
    {
        var user = new User
        {
            Email = email,
            PasswordHash = passwordHash,
            CreatedAt = DateTime.UtcNow,
            IsActive = true
        };
        try
        {
            await _users.InsertOneAsync(user);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Code == 11000)
        {
            // Unique email index rejected a concurrent duplicate registration.
            throw new EmailAlreadyRegisteredException("A user with this email already exists");
        }

        return user;
    }

    public async Task<Device?> FindDeviceAsync(string userId, string deviceId)
    {
        return await _devices.Find(d => d.UserId == userId && d.DeviceId == deviceId).FirstOrDefaultAsync();
    }

    public async Task<Device> CreateDeviceAsync(string userId, string deviceId)
    {
        var device = new Device
        {
            UserId = userId,
            DeviceId = deviceId,
            IsRevoked = false,
            CreatedAt = DateTime.UtcNow
        };
        await _devices.InsertOneAsync(device);
        return device;
    }

    public async Task RevokeDeviceAsync(string userId, string deviceId)
    {
        var filter = Builders<Device>.Filter.And(
            Builders<Device>.Filter.Eq(d => d.UserId, userId),
            Builders<Device>.Filter.Eq(d => d.DeviceId, deviceId));
        var update = Builders<Device>.Update.Set(d => d.IsRevoked, true);
        await _devices.UpdateManyAsync(filter, update);

        // Also revoke all refresh tokens for this user/device pair.
        var tokenFilter = Builders<RefreshToken>.Filter.And(
            Builders<RefreshToken>.Filter.Eq(t => t.UserId, userId),
            Builders<RefreshToken>.Filter.Eq(t => t.DeviceId, deviceId));
        var tokenUpdate = Builders<RefreshToken>.Update.Set(t => t.IsRevoked, true);
        await _refreshTokens.UpdateManyAsync(tokenFilter, tokenUpdate);
    }

    public async Task<RefreshToken?> FindRefreshTokenAsync(string token)
    {
        return await _refreshTokens.Find(t => t.Token == token).FirstOrDefaultAsync();
    }

    public async Task<RefreshToken> CreateRefreshTokenAsync(string userId, string deviceId, string token, DateTime expiresAt)
    {
        var refreshToken = new RefreshToken
        {
            UserId = userId,
            DeviceId = deviceId,
            Token = token,
            ExpiresAt = expiresAt,
            IsRevoked = false,
            CreatedAt = DateTime.UtcNow
        };
        await _refreshTokens.InsertOneAsync(refreshToken);
        return refreshToken;
    }

    public async Task RevokeRefreshTokenAsync(string token)
    {
        var filter = Builders<RefreshToken>.Filter.Eq(t => t.Token, token);
        var update = Builders<RefreshToken>.Update.Set(t => t.IsRevoked, true);
        await _refreshTokens.UpdateOneAsync(filter, update);
    }

    private static void RegisterCamelCaseConventions()
    {
        if (_conventionsRegistered)
            return;

        lock (ConventionLock)
        {
            if (_conventionsRegistered)
                return;

            var pack = new ConventionPack { new CamelCaseElementNameConvention() };
            ConventionRegistry.Register(
                "stash-identity-camel-case",
                pack,
                type => type.Namespace == typeof(User).Namespace);

            _conventionsRegistered = true;
        }
    }
}
