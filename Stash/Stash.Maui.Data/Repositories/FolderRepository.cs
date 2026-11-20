using Microsoft.EntityFrameworkCore;
using Stash.Maui.Data.Entities;

namespace Stash.Maui.Data.Repositories;

/// <summary>
/// EF Core implementation of <see cref="IFolderRepository"/>.
/// </summary>
public sealed class FolderRepository : IFolderRepository
{
    private readonly IDbContextFactory<StashDbContext> _contextFactory;

    public FolderRepository(IDbContextFactory<StashDbContext> contextFactory)
    {
        _contextFactory = contextFactory ?? throw new ArgumentNullException(nameof(contextFactory));
    }

    public async Task<FolderConfig?> GetByIdAsync(Guid id, CancellationToken ct = default)
    {
        await using var db = await _contextFactory.CreateDbContextAsync(ct);
        return await db.FolderConfigs
            .AsNoTracking()
            .FirstOrDefaultAsync(folder => folder.Id == id, ct);
    }

    public async Task<FolderConfig?> GetByPathAsync(
        string folderPath,
        CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(folderPath);

        await using var db = await _contextFactory.CreateDbContextAsync(ct);
        return await db.FolderConfigs
            .AsNoTracking()
            .FirstOrDefaultAsync(folder => folder.FolderPath == folderPath, ct);
    }

    public async Task<IReadOnlyList<FolderConfig>> GetAllAsync(CancellationToken ct = default)
    {
        await using var db = await _contextFactory.CreateDbContextAsync(ct);
        return await db.FolderConfigs
            .AsNoTracking()
            .OrderBy(folder => folder.AddedAt)
            .ToListAsync(ct);
    }

    public async Task AddAsync(FolderConfig folder, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(folder);

        await using var db = await _contextFactory.CreateDbContextAsync(ct);
        db.FolderConfigs.Add(folder);
        await db.SaveChangesAsync(ct);
    }

    public async Task UpdateAsync(FolderConfig folder, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(folder);

        await using var db = await _contextFactory.CreateDbContextAsync(ct);
        db.FolderConfigs.Update(folder);
        await db.SaveChangesAsync(ct);
    }

    public async Task<bool> DeleteAsync(Guid id, CancellationToken ct = default)
    {
        await using var db = await _contextFactory.CreateDbContextAsync(ct);
        var folder = await db.FolderConfigs.FindAsync(new object?[] { id }, ct);
        if (folder is null)
            return false;

        db.FolderConfigs.Remove(folder);
        await db.SaveChangesAsync(ct);
        return true;
    }
}
