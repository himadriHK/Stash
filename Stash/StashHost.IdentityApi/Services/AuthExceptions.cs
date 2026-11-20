namespace StashHost.IdentityApi.Services;

/// <summary>
/// Thrown when registering an email address that is already in use.
/// </summary>
public sealed class EmailAlreadyRegisteredException : Exception
{
    public EmailAlreadyRegisteredException(string message) : base(message)
    {
    }
}
