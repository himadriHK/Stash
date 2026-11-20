using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace StashHost.IdentityApi.Models;

/// <summary>
/// MongoDB document representing a registered user.
/// </summary>
public class User
{
    [BsonId]
    [BsonRepresentation(BsonType.ObjectId)]
    public string Id { get; set; } = ObjectId.GenerateNewId().ToString();

    public string Email { get; set; } = string.Empty;
    public string PasswordHash { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public bool IsActive { get; set; } = true;
}
