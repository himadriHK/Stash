using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using MegaConnectivity.Core;
using StashHost.Shared.Contracts;
using StashHost.Shared.Messages;

namespace StashHost.Shared.Services;

/// <summary>
/// Mega.io storage provider implementation backed by <see cref="MegaStorageClient"/>
/// from the MegaConnectivity.Core package.
///
/// Single shared implementation used by both Mobile App and StashHost backend.
/// All file data is transferred as binary streams — streams are never converted to text —
/// so the client is compatible with every file type (documents, images, archives, executables, etc.).
///
/// The Node.js runtime is bootstrapped per the "Embedding JS in .NET / Importing JS modules into .NET"
/// scenario:
/// https://microsoft.github.io/node-api-dotnet/scenarios/dotnet-js.html#importing-js-modules-into-net
/// </summary>
public class MegaStorageProvider : IStorageProvider, IAsyncDisposable
{
    private readonly MegaStorageOptions _options;
    private readonly ILogger<MegaStorageProvider> _logger;

    // MegaConnectivity.Core client (lazily initialized on first use).
    private MegaStorageClient? _client;
    private Task? _initializationTask;
    private readonly object _initLock = new();
    private bool _disposed;

    /// <summary>
    /// Initializes a new instance of MegaStorageProvider.
    /// </summary>
    public MegaStorageProvider(IOptions<MegaStorageOptions> options, ILogger<MegaStorageProvider> logger)
    {
        _options = options.Value;
        _logger = logger;
    }

    /// <summary>
    /// Ensures the MegaConnectivity.Core client is created and logged in.
    /// The initialization task is shared so concurrent activities do not create
    /// multiple Node runtimes or race the login sequence.
    /// </summary>
    private async Task<MegaStorageClient> EnsureInitializedAsync(CancellationToken ct)
    {
        if (_disposed)
            throw new ObjectDisposedException(nameof(MegaStorageProvider));

        MegaStorageClient client;
        Task initializationTask;

        lock (_initLock)
        {
            if (_disposed)
                throw new ObjectDisposedException(nameof(MegaStorageProvider));

            _client ??= new MegaStorageClient(_options.Email, _options.Password);
            client = _client;
            _initializationTask ??= client.InitializeAsync(CancellationToken.None);
            initializationTask = _initializationTask;
        }

        try
        {
            await initializationTask.WaitAsync(ct);
            return client;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // The caller stopped waiting; leave the shared initialization running.
            throw;
        }
        catch
        {
            // A failed initialization must not poison every later operation. Drop the
            // client so the next call can start a clean Node runtime/login attempt.
            lock (_initLock)
            {
                if (ReferenceEquals(_initializationTask, initializationTask))
                {
                    _initializationTask = null;
                    _client = null;
                }
            }

            client.Dispose();
            throw;
        }
    }

    /// <summary>
    /// Upload a file stream to Mega.io at the specified remote path.
    /// </summary>
    public async Task<string> UploadFileAsync(Stream fileStream, string remotePath, CancellationToken ct)
    {
        if (fileStream is null) throw new ArgumentNullException(nameof(fileStream));
        if (!fileStream.CanRead) throw new ArgumentException("Source stream must be readable.", nameof(fileStream));
        if (string.IsNullOrEmpty(remotePath)) throw new ArgumentException("Remote path cannot be empty.", nameof(remotePath));

        var client = await EnsureInitializedAsync(ct);

        var fileName = MegaPathMapper.GetPhysicalFileName(remotePath);
        long fileSize = fileStream.CanSeek ? fileStream.Length : 0;

        var info = await client.UploadFileAsync(fileName, fileStream, fileSize, ct);
        _logger.LogInformation("Uploaded file {FileName} ({Size} bytes) to {RemotePath}", fileName, info.Size, remotePath);
        return remotePath;
    }

    /// <summary>
    /// Delete a file at the specified remote path from Mega.io.
    /// </summary>
    public async Task<bool> DeleteFileAsync(string remotePath, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(remotePath)) throw new ArgumentException("Remote path cannot be empty.", nameof(remotePath));

        var client = await EnsureInitializedAsync(ct);

        var fileName = MegaPathMapper.GetPhysicalFileName(remotePath);

        // Check existence first so we can return false for missing files.
        var exists = await client.FileExistsAsync(fileName, ct);
        if (!exists) return false;

        await client.DeleteFileAsync(fileName, permanent: true, ct);
        _logger.LogInformation("Deleted file {FileName} from {RemotePath}", fileName, remotePath);
        return true;
    }

    /// <summary>
    /// Download a file from Mega.io at the specified remote path as a stream.
    /// </summary>
    public async Task<Stream> DownloadFileAsync(string remotePath, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(remotePath)) throw new ArgumentException("Remote path cannot be empty.", nameof(remotePath));

        var client = await EnsureInitializedAsync(ct);

        var fileName = MegaPathMapper.GetPhysicalFileName(remotePath);
        var exists = await client.FileExistsAsync(fileName, ct);
        if (!exists)
            throw new FileNotFoundException($"File not found: {fileName}", fileName);

        var destination = new MemoryStream();
        await client.DownloadFileAsync(fileName, destination, ct);
        destination.Position = 0;
        _logger.LogInformation("Downloaded file {FileName} ({Size} bytes) from {RemotePath}", fileName, destination.Length, remotePath);
        return destination;
    }

    /// <summary>
    /// Check if a file exists at the specified remote path in Mega.io.
    /// </summary>
    public async Task<bool> FileExistsAsync(string remotePath, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(remotePath)) throw new ArgumentException("Remote path cannot be empty.", nameof(remotePath));

        var client = await EnsureInitializedAsync(ct);

        var fileName = MegaPathMapper.GetPhysicalFileName(remotePath);
        return await client.FileExistsAsync(fileName, ct);
    }

    /// <summary>
    /// Get the size of a file at the specified remote path in Mega.io.
    /// </summary>
    public async Task<long> GetFileSizeAsync(string remotePath, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(remotePath)) throw new ArgumentException("Remote path cannot be empty.", nameof(remotePath));

        var client = await EnsureInitializedAsync(ct);

        var fileName = MegaPathMapper.GetPhysicalFileName(remotePath);
        return await client.GetFileSizeAsync(fileName, ct);
    }

    /// <summary>
    /// Closes the Mega.io session and disposes the Node.js runtime.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;

        if (_client is not null)
        {
            try
            {
                await _client.CloseAsync();
            }
            catch
            {
                // Swallow close errors — disposal should not throw.
            }
            _client.Dispose();
            _client = null;
        }
    }
}
