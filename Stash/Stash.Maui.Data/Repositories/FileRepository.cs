using Microsoft.EntityFrameworkCore;
using Stash.Maui.Data.Entities;

namespace Stash.Maui.Data.Repositories;

/// <summary>
/// EF Core implementation of <see cref="IFileRepository"/>. Each operation uses a
/// fresh context from the factory so repositories are safe to use concurrently.
/// </summary>
public sealed class FileRepository : IFileRepository
{
    private readonly IDbContextFactory<StashDbContext> _contextFactory;

    public FileRepository(IDbContextFactory<StashDbContext> contextFactory)
    {
        _contextFactory = contextFactory ?? throw new ArgumentNullException(nameof(contextFactory));
    }

    public async Task<FileEntity?> GetByIdAsync(Guid id, CancellationToken ct = default)
    {
        await using var db = await _contextFactory.CreateDbContextAsync(ct);
        return await db.Files.AsNoTracking().FirstOrDefaultAsync(file => file.Id == id, ct);
    }

    public async Task<FileEntity?> GetByContentHashAsync(
        string contentHash,
        CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(contentHash);

        await using var db = await _contextFactory.CreateDbContextAsync(ct);
        return await db.Files
            .AsNoTracking()
            .FirstOrDefaultAsync(file => file.ContentHash == contentHash, ct);
    }

    public async Task<IReadOnlyList<FileEntity>> GetAllAsync(CancellationToken ct = default)
    {
        await using var db = await _contextFactory.CreateDbContextAsync(ct);
        return await db.Files
            .AsNoTracking()
            .OrderBy(file => file.DiscoveredAt)
            .ToListAsync(ct);
    }

    public async Task<bool> ExistsByContentHashAsync(
        string contentHash,
        CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(contentHash);

        await using var db = await _contextFactory.CreateDbContextAsync(ct);
        return await db.Files.AnyAsync(file => file.ContentHash == contentHash, ct);
    }

    public async Task AddAsync(FileEntity file, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(file);

        await using var db = await _contextFactory.CreateDbContextAsync(ct);
        db.Files.Add(file);
        await db.SaveChangesAsync(ct);
    }

    public async Task UpdateAsync(FileEntity file, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(file);

        await using var db = await _contextFactory.CreateDbContextAsync(ct);
        db.Files.Update(file);
        await db.SaveChangesAsync(ct);
    }

    public async Task<bool> DeleteAsync(Guid id, CancellationToken ct = default)
    {
        await using var db = await _contextFactory.CreateDbContextAsync(ct);
        var file = await db.Files.FindAsync(new object?[] { id }, ct);
        if (file is null)
            return false;

        db.Files.Remove(file);
        await db.SaveChangesAsync(ct);
        return true;
    }
}
