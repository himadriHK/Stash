namespace MegaConnectivity.Core;

/// <summary>Exception thrown by the Mega.io storage client for operational failures.</summary>
[Serializable]
public sealed class MegaStorageException : Exception
{
    /// <summary>Creates a new instance with the specified message.</summary>
    public MegaStorageException(string message) : base(message) { }

    /// <summary>Creates a new instance with the specified message and inner exception.</summary>
    public MegaStorageException(string message, Exception inner) : base(message, inner) { }
}
