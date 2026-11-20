using Stash.Maui.Data.Entities;

namespace Stash.Maui.Services;

/// <summary>
/// Uploads local files to the configured storage provider and tracks their state.
/// </summary>
public interface IUploadManager
{
    Task<UploadResult> UploadFileAsync(
        FileEntity file,
        string megaTempPath,
        CancellationToken ct = default);

    Task<UploadResult> UploadFileAsync(
        FileEntity file,
        CancellationToken ct = default);

    Task<UploadBatchResult> UploadBatchAsync(
        IEnumerable<FileEntity> files,
        CancellationToken ct = default);

    Task<bool> IsUploadInProgressAsync(Guid fileId);
}
