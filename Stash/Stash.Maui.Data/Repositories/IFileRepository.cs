using Stash.Maui.Data.Entities;

namespace Stash.Maui.Data.Repositories;

/// <summary>
/// Persistence operations for discovered files.
/// </summary>
public interface IFileRepository
{
    Task<FileEntity?> GetByIdAsync(Guid id, CancellationToken ct = default);

    Task<FileEntity?> GetByContentHashAsync(string contentHash, CancellationToken ct = default);

    Task<IReadOnlyList<FileEntity>> GetAllAsync(CancellationToken ct = default);

    Task<bool> ExistsByContentHashAsync(string contentHash, CancellationToken ct = default);

    Task AddAsync(FileEntity file, CancellationToken ct = default);

    Task UpdateAsync(FileEntity file, CancellationToken ct = default);

    Task<bool> DeleteAsync(Guid id, CancellationToken ct = default);
}
