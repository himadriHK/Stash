using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace StashHost.IdentityApi.Models;

/// <summary>
/// MongoDB document representing a registered device.
/// </summary>
public class Device
{
    [BsonId]
    [BsonRepresentation(BsonType.ObjectId)]
    public string Id { get; set; } = ObjectId.GenerateNewId().ToString();

    public string UserId { get; set; } = string.Empty;
    public string DeviceId { get; set; } = string.Empty;
    public bool IsRevoked { get; set; } = false;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
