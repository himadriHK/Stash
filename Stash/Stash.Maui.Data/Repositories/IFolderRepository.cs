using Stash.Maui.Data.Entities;

namespace Stash.Maui.Data.Repositories;

/// <summary>
/// Persistence operations for configured scan folders.
/// </summary>
public interface IFolderRepository
{
    Task<FolderConfig?> GetByIdAsync(Guid id, CancellationToken ct = default);

    Task<FolderConfig?> GetByPathAsync(string folderPath, CancellationToken ct = default);

    Task<IReadOnlyList<FolderConfig>> GetAllAsync(CancellationToken ct = default);

    Task AddAsync(FolderConfig folder, CancellationToken ct = default);

    Task UpdateAsync(FolderConfig folder, CancellationToken ct = default);

    Task<bool> DeleteAsync(Guid id, CancellationToken ct = default);
}
