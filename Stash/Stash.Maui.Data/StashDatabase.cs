using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Stash.Maui.Data.Repositories;

namespace Stash.Maui.Data;

/// <summary>
/// Registers and initializes the local SQLite database.
/// </summary>
public static class StashDatabase
{
    public const string FileName = "stash.db";

    /// <summary>
    /// Registers a standard SQLite database at <paramref name="databasePath"/>.
    /// The path is explicit so the MAUI app can use <c>FileSystem.AppDataDirectory</c>
    /// while tests use an isolated temporary directory.
    /// </summary>
    public static IServiceCollection AddStashData(
        this IServiceCollection services,
        string databasePath)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentException.ThrowIfNullOrWhiteSpace(databasePath);

        var fullPath = Path.GetFullPath(databasePath);
        var directory = Path.GetDirectoryName(fullPath);
        if (!string.IsNullOrWhiteSpace(directory))
            Directory.CreateDirectory(directory);

        // Standard SQLite: no encryption/key pragmas. The connection only specifies
        // the file path and a normal read/write/create mode.
        var connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = fullPath,
            Mode = SqliteOpenMode.ReadWriteCreate
        }.ToString();

        services.AddDbContextFactory<StashDbContext>(options =>
            options.UseSqlite(
                connectionString,
                sqliteOptions => sqliteOptions.CommandTimeout(30)));

        services.AddTransient<IFileRepository, FileRepository>();
        services.AddTransient<IFolderRepository, FolderRepository>();

        return services;
    }

    /// <summary>
    /// Applies pending migrations synchronously. Called once from app startup before
    /// any repository is used. Tests normally call <c>Database.MigrateAsync</c>
    /// directly so they can await it.
    /// </summary>
    public static void InitializeStashDatabase(this IServiceProvider services)
    {
        ArgumentNullException.ThrowIfNull(services);

        using var scope = services.CreateScope();
        var factory = scope.ServiceProvider.GetRequiredService<IDbContextFactory<StashDbContext>>();
        using var db = factory.CreateDbContext();
        db.Database.Migrate();
    }
}
