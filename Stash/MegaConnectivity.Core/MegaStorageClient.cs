using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.JavaScript.NodeApi;
using Microsoft.JavaScript.NodeApi.Runtime;

namespace MegaConnectivity.Core;

/// <summary>
/// .NET client for Mega.io file operations using megajs via Microsoft.JavaScript.NodeApi.
///
/// All file data is transferred as binary streams — streams are never converted to text — so the
/// client is compatible with every file type (documents, images, archives, executables, etc.).
///
/// The Node.js runtime is bootstrapped per the "Embedding JS in .NET / Importing JS modules into .NET"
/// scenario:
/// https://microsoft.github.io/node-api-dotnet/scenarios/dotnet-js.html#importing-js-modules-into-net
///
/// Supported operations:
///   - Login (email/password)
///   - Upload file from a .NET Stream (binary, no text conversion)
///   - Download file to a .NET Stream (binary, no text conversion)
///   - Ranged/resume download (start/end byte offsets)
///   - File existence check
///   - File size
///   - Delete file
///   - List/navigate files
/// </summary>
public sealed class MegaStorageClient : IAsyncDisposable, IDisposable
{
    private const int UploadChunkSize = 64 * 1024; // 64 KB

    private readonly string _email;
    private readonly string _password;

    // Node.js runtime (one platform per process; one thread runtime per client).
    private NodeEmbeddingPlatform? _platform;
    private NodeEmbeddingThreadRuntime? _runtime;

    // megajs module + authenticated Storage instance (kept alive across scope boundaries).
    private JSReference? _megaJsRef;
    private JSReference? _storageRef;

    private bool _disposed;

    /// <summary>Creates a client for the given Mega.io account.</summary>
    public MegaStorageClient(string email, string password)
    {
        _email = email ?? throw new ArgumentNullException(nameof(email));
        _password = password ?? throw new ArgumentNullException(nameof(password));
    }

    /// <summary>Initializes the Node.js runtime, imports megajs, and logs in.</summary>
    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(MegaStorageClient));
        if (_runtime is not null) return; // already initialized

        // --- Load libnode.dll and initialize a Node.js platform + runtime ---
        string baseDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)!;
        string libnodePath = ResolveLibNodePath(baseDir);

        var platformSettings = new NodeEmbeddingPlatformSettings { LibNodePath = libnodePath };
        _platform = new NodeEmbeddingPlatform(platformSettings);

        var runtimeSettings = new NodeEmbeddingRuntimeSettings
        {
            // Wire up a CommonJS require so npm modules resolve from node_modules (baseDir or a parent).
            MainScript = "globalThis.require = require('module').createRequire(process.execPath);\n"
        };
        _runtime = _platform.CreateThreadRuntime(baseDir, runtimeSettings);

        // All JavaScript operations must run on the JS thread. RunAsync marshals async continuations
        // back to the JS thread via the runtime's SynchronizationContext.
        await RunOnJsThreadAsync(async () =>
        {
            // Import megajs.
            JSValue megaJs = _runtime!.Import("megajs", null, false);
            if (megaJs.IsUndefined())
            {
                throw new MegaStorageException("megajs module not found. Run 'npm install megajs' in the app directory.");
            }
            _megaJsRef = new JSReference(megaJs, true);

            // Get Storage class.
            JSValue storageClass = megaJs.GetProperty("Storage");
            if (storageClass.IsUndefined())
            {
                throw new MegaStorageException("Storage class not found in megajs");
            }

            // Create Storage instance: new Storage({ email, password, keepalive: false })
            JSValue options = JSValue.CreateObject();
            options.SetProperty(JSValue.CreateStringUtf16("email"), JSValue.CreateStringUtf16(_email));
            options.SetProperty(JSValue.CreateStringUtf16("password"), JSValue.CreateStringUtf16(_password));
            // Disable the background keepalive long-poll so the runtime exits cleanly.
            options.SetProperty(JSValue.CreateStringUtf16("keepalive"), JSValue.False);

            JSValue storageVal = storageClass.CallAsConstructor(options);
            _storageRef = new JSReference(storageVal, true);
            JSValue storage = _storageRef.GetValue();

            // Wait for storage.ready promise.
            JSValue ready = storage.GetProperty("ready");
            var readyPromise = ready.As<JSPromise>();
            if (!readyPromise.HasValue)
            {
                throw new MegaStorageException("Could not get promise from Storage.ready");
            }
            await readyPromise.Value.AsTask();
        }, cancellationToken);
    }

    /// <summary>Checks whether a file exists in the account root.</summary>
    public async Task<bool> FileExistsAsync(string fileName, CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        return await RunOnJsThreadAsync(async () =>
        {
            JSValue storage = _storageRef!.GetValue();
            JSValue found = storage.CallMethod("find", fileName);
            return !(found == JSValue.Null);
        }, cancellationToken);
    }

    /// <summary>Gets the size (in bytes) of a file in the account root.</summary>
    public async Task<long> GetFileSizeAsync(string fileName, CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        return await RunOnJsThreadAsync(async () =>
        {
            JSValue storage = _storageRef!.GetValue();
            JSValue found = storage.CallMethod("find", fileName);
            if (found.IsUndefined())
            {
                throw new FileNotFoundException($"File not found: {fileName}", fileName);
            }
            return GetValueInt64(found.GetProperty("size"));
        }, cancellationToken);
    }

    /// <summary>
    /// Uploads a file from a .NET Stream as binary (no text conversion).
    ///
    /// The stream is read into a binary buffer and uploaded as a JS Uint8Array to megajs, which
    /// calls stream.end(buffer) internally — the file is uploaded as-is with no text conversion.
    /// </summary>
    /// <param name="fileName">Destination file name in Mega.io.</param>
    /// <param name="source">Source stream containing the file data (binary).</param>
    /// <param name="size">Size of the source stream in bytes. If null, <see cref="Stream.Length"/>
    /// is used when available.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Information about the uploaded file.</returns>
    public async Task<MegaFileInfo> UploadFileAsync(
        string fileName,
        Stream source,
        long? size = null,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        if (source is null) throw new ArgumentNullException(nameof(source));
        if (!source.CanRead) throw new ArgumentException("Source stream must be readable.", nameof(source));

        long fileSize = size ?? (source.CanSeek ? source.Length : throw new MegaStorageException(
            "Stream size is unknown. Please provide the 'size' parameter or use a seekable stream."));

        // Read the entire stream into a binary buffer. megajs accepts a Buffer/Uint8Array as the
        // upload source and calls stream.end(buffer) internally, so no text conversion occurs —
        // the file is uploaded as-is. Buffering in memory avoids the JS-thread deadlock that occurs
        // when pumping a .NET Stream through a Node.js PassThrough from within RunAsync.
        byte[] buffer;
        using (var ms = new MemoryStream())
        {
            await source.CopyToAsync(ms, UploadChunkSize, cancellationToken);
            buffer = ms.ToArray();
        }

        return await RunOnJsThreadAsync(async () =>
        {
            JSValue storage = _storageRef!.GetValue();

            // megajs Storage.upload(opt, source, cb) — when source is a Buffer (not a stream),
            // megajs treats it as binary buffer data and ends the encrypter stream with it.
            JSValue uploadOpt = JSValue.CreateObject();
            uploadOpt.SetProperty(JSValue.CreateStringUtf16("name"), JSValue.CreateStringUtf16(fileName));
            uploadOpt.SetProperty(JSValue.CreateStringUtf16("size"), JSValue.CreateNumber(fileSize));

            // Create a JS Uint8Array from the .NET byte buffer.
            JSValue arrayBuffer = JSValue.CreateArrayBuffer(buffer.AsSpan());
            JSValue uint8Array = JSValue.CreateTypedArray(JSTypedArrayType.UInt8, buffer.Length, arrayBuffer, 0);

            // Kick off the megajs upload (pass the Uint8Array as the binary source).
            JSValue uploadResult = storage.CallMethod("upload", uploadOpt, uint8Array);
            JSValue complete = uploadResult.GetProperty("complete");
            var completePromise = complete.As<JSPromise>();
            if (!completePromise.HasValue)
            {
                throw new MegaStorageException("Could not get promise from upload result");
            }
            JSValue uploadedFileRaw = await completePromise.Value.AsTask();
            using var uploadedFileRef = new JSReference(uploadedFileRaw, false);
            return ReadFileInfo(uploadedFileRef.GetValue());
        }, cancellationToken);
    }

    /// <summary>
    /// Downloads a file to a .NET Stream as binary (no text conversion).
    ///
    /// The file is streamed from Mega.io through a Node.js readable stream and copied directly to
    /// the destination .NET Stream.
    /// </summary>
    /// <param name="fileName">Source file name in Mega.io.</param>
    /// <param name="destination">Destination stream to receive the file data (binary).</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    public async Task DownloadFileAsync(
        string fileName,
        Stream destination,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        if (destination is null) throw new ArgumentNullException(nameof(destination));
        if (!destination.CanWrite) throw new ArgumentException("Destination stream must be writable.", nameof(destination));

        await DownloadFileRangeAsync(fileName, destination, 0, null, cancellationToken);
    }

    /// <summary>
    /// Downloads a byte range of a file to a .NET Stream as binary (no text conversion).
    ///
    /// This supports resume-after-interruption: download [0, mid), then [mid, end) and concatenate.
    /// </summary>
    /// <param name="fileName">Source file name in Mega.io.</param>
    /// <param name="destination">Destination stream to receive the file data (binary).</param>
    /// <param name="start">First byte offset to download (inclusive).</param>
    /// <param name="end">Last byte offset to download (inclusive), or null to download to EOF.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    public async Task DownloadFileRangeAsync(
        string fileName,
        Stream destination,
        long start,
        long? end = null,
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        if (destination is null) throw new ArgumentNullException(nameof(destination));
        if (!destination.CanWrite) throw new ArgumentException("Destination stream must be writable.", nameof(destination));
        if (start < 0) throw new ArgumentOutOfRangeException(nameof(start), "start must be >= 0");

        await RunOnJsThreadAsync(async () =>
        {
            JSValue storage = _storageRef!.GetValue();
            JSValue foundRaw = storage.CallMethod("find", fileName);
            using var foundRef = new JSReference(foundRaw, false);
            JSValue file = foundRef.GetValue();
            if (file == JSValue.Null)
            {
                throw new FileNotFoundException($"File not found: {fileName}", fileName);
            }

            // megajs File.downloadBuffer(options) returns a promise resolving to the file Buffer.
            // Pass start/end options for ranged/resume downloads.
            JSValue downloadOpt = JSValue.CreateObject();
            downloadOpt.SetProperty(JSValue.CreateStringUtf16("start"), JSValue.CreateNumber(start));
            if (end.HasValue)
            {
                downloadOpt.SetProperty(JSValue.CreateStringUtf16("end"), JSValue.CreateNumber(end.Value));
            }
            JSValue downloadBufferPromise = file.CallMethod("downloadBuffer", downloadOpt);
            var promise = downloadBufferPromise.As<JSPromise>();
            if (!promise.HasValue)
            {
                throw new MegaStorageException("File.downloadBuffer did not return a promise");
            }
            JSValue buffer = await promise.Value!.AsTask();
            int byteLength = buffer.GetProperty("byteLength").GetValueInt32();
            byte[] data = new byte[byteLength];
            var typedArray = buffer.As<JSTypedArray<byte>>();
            if (typedArray.HasValue)
            {
                var value = typedArray.Value;
                for (int i = 0; i < byteLength; i++)
                {
                    data[i] = value[i];
                }
            }
            await destination.WriteAsync(data, 0, data.Length, cancellationToken);
        }, cancellationToken);
    }

    /// <summary>Deletes a file from the account.</summary>
    /// <param name="fileName">File name to delete.</param>
    /// <param name="permanent">When true, permanently deletes; otherwise moves to trash.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    public async Task DeleteFileAsync(string fileName, bool permanent = false, CancellationToken cancellationToken = default)
    {
        EnsureInitialized();
        await RunOnJsThreadAsync(async () =>
        {
            JSValue storage = _storageRef!.GetValue();
            JSValue file = storage.CallMethod("find", fileName);
            if (file == JSValue.Null)
            {
                throw new FileNotFoundException($"File not found: {fileName}", fileName);
            }

            // megajs File.delete(permanent, cb) — permanent=true deletes outright.
            JSValue deleteResult = file.CallMethod("delete", permanent ? JSValue.True : JSValue.False);
            var deletePromise = deleteResult.As<JSPromise>();
            if (!deletePromise.HasValue)
            {
                throw new MegaStorageException("Could not get promise from delete");
            }
            await deletePromise.Value.AsTask();
        }, cancellationToken);
    }

    /// <summary>Lists files in a directory (defaults to root "/").</summary>
    public async Task<IReadOnlyList<MegaFileInfo>> ListFilesAsync(
        string path = "/",
        CancellationToken cancellationToken = default)
    {
        EnsureInitialized();

        return await RunOnJsThreadAsync(async () =>
        {
            JSValue storage = _storageRef!.GetValue();

            // megajs storage.root is the root directory; its children are the entries.
            JSValue root = storage.GetProperty("root");
            JSValue children = root.GetProperty("children");
            int count = children.GetProperty("length").GetValueInt32();

            var results = new List<MegaFileInfo>(count);
            for (int i = 0; i < count; i++)
            {
                JSValue child = children.GetProperty(JSValue.CreateNumber(i));
                results.Add(ReadFileInfo(child));
            }
            return results;
        }, cancellationToken);
    }

    /// <summary>Closes the Mega.io session and disposes the Node.js runtime.</summary>
    public async Task CloseAsync(CancellationToken cancellationToken = default)
    {
        if (_disposed) return;

        try
        {
            if (_storageRef is not null && _runtime is not null)
            {
                await RunOnJsThreadAsync(async () =>
                {
                    JSValue storage = _storageRef.GetValue();
                    JSValue closeResult = storage.CallMethod("close");
                    var closePromise = closeResult.As<JSPromise>();
                    if (closePromise.HasValue)
                    {
                        await closePromise.Value.AsTask();
                    }
                }, cancellationToken);
            }
        }
        catch
        {
            // Swallow close errors — disposal should not throw.
        }
        finally
        {
            await DisposeAsyncCore();
        }
    }

    /// <summary>Reads a Mega File JS object into a .NET MegaFileInfo.</summary>
    private static MegaFileInfo ReadFileInfo(JSValue file)
    {
        return new MegaFileInfo
        {
            Name = file.GetProperty("name").GetValueStringUtf16(),
            NodeId = file.GetProperty("nodeId").GetValueStringUtf16(),
            Size = GetValueInt64(file.GetProperty("size")),
            Type = file.GetProperty("type").GetValueInt32(),
            Directory = file.GetProperty("directory").GetValueBool(),
        };
    }

    /// <summary>Gets a 64-bit integer from a JS value, falling back to 32-bit read when needed.</summary>
    private static long GetValueInt64(JSValue value)
    {
        try
        {
            return value.GetValueInt64();
        }
        catch (MissingMethodException)
        {
            return value.GetValueInt32();
        }
    }

    private void EnsureInitialized()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(MegaStorageClient));
        if (_runtime is null || _storageRef is null)
        {
            throw new InvalidOperationException("Client not initialized. Call InitializeAsync() first.");
        }
    }

    private static string ResolveLibNodePath(string baseDir)
    {
        string[] candidates =
        {
            Path.Combine(baseDir, "libnode.dll"),
            Path.Combine(baseDir, "runtimes", GetRid(), "native", "libnode.dll")
        };
        foreach (string candidate in candidates)
        {
            if (File.Exists(candidate)) return candidate;
        }
        throw new MegaStorageException(
            $"libnode.dll not found. Restore the Microsoft.JavaScript.LibNode NuGet package. " +
            $"Searched: {string.Join("; ", candidates)}");
    }

    private static string GetRid()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return RuntimeInformation.ProcessArchitecture switch
            {
                Architecture.X64 or Architecture.X86 => "win-x64",
                Architecture.Arm64 => "win-arm64",
                _ => "win-x64"
            };
        }
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux)) return "linux-x64";
        return "osx-x64";
    }

    /// <summary>Runs a void-returning function on the JS thread, then waits with cancellation.</summary>
    private async Task RunOnJsThreadAsync(Func<Task> func, CancellationToken cancellationToken)
    {
        await _runtime!.RunAsync(func).WaitAsync(cancellationToken);
    }

    /// <summary>Runs a value-returning function on the JS thread, then waits with cancellation.</summary>
    private async Task<T> RunOnJsThreadAsync<T>(Func<Task<T>> func, CancellationToken cancellationToken)
    {
        return await _runtime!.RunAsync(func).WaitAsync(cancellationToken);
    }

    private async ValueTask DisposeAsyncCore()
    {
        if (_disposed) return;
        _disposed = true;

        _storageRef?.Dispose();
        _megaJsRef?.Dispose();
        _runtime?.Dispose();
        _platform?.Dispose();
    }

    public async ValueTask DisposeAsync()
    {
        await DisposeAsyncCore();
    }

    public void Dispose()
    {
        _storageRef?.Dispose();
        _megaJsRef?.Dispose();
        _runtime?.Dispose();
        _platform?.Dispose();
        _disposed = true;
        GC.SuppressFinalize(this);
    }
}
