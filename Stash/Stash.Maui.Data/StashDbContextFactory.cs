using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Stash.Maui.Data;

/// <summary>
/// Design-time factory used by <c>dotnet ef</c>. The runtime app supplies its
/// AppDataDirectory path through DI instead of using this factory.
/// </summary>
public sealed class StashDbContextFactory : IDesignTimeDbContextFactory<StashDbContext>
{
    public StashDbContext CreateDbContext(string[] args)
    {
        var databasePath = Environment.GetEnvironmentVariable("STASH_DESIGN_DB_PATH");
        if (string.IsNullOrWhiteSpace(databasePath))
            databasePath = Path.Combine(Path.GetTempPath(), "stash-design.db");

        var options = new DbContextOptionsBuilder<StashDbContext>()
            .UseSqlite($"Data Source={databasePath}")
            .Options;

        return new StashDbContext(options);
    }
}
