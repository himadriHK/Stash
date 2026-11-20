using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Stash.Maui.Data;
using Stash.Maui.Data.Entities;
using Stash.Maui.Data.Repositories;

namespace Stash.Maui.Tests;

public class Phase4LocalDatabaseTests
{
    [Fact]
    public async Task Migration_CreatesStandardSqliteDatabase_WithRequiredIndexes()
    {
        await using var database = new TemporaryDatabase();

        await using (var db = new StashDbContext(database.CreateOptions()))
        {
            await db.Database.MigrateAsync();
            var applied = await db.Database.GetAppliedMigrationsAsync();
            Assert.Contains(applied, migration => migration.EndsWith("InitialCreate", StringComparison.Ordinal));
        }

        Assert.True(File.Exists(database.DatabasePath));

        await using var connection = new SqliteConnection(database.ConnectionString);
        await connection.OpenAsync();

        var tables = await ReadStringsAsync(
            connection,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('Files', 'FolderConfigs') ORDER BY name;");

        Assert.Equal(new[] { "Files", "FolderConfigs" }, tables);

        var fileIndexes = await ReadIndexesAsync(connection, "Files");
        Assert.Contains(fileIndexes, index => index.Name == "IX_Files_ContentHash" && index.IsUnique);
        Assert.Contains(fileIndexes, index => index.Name == "IX_Files_Status" && !index.IsUnique);
        Assert.Contains(fileIndexes, index => index.Name == "IX_Files_DeviceId" && !index.IsUnique);
        Assert.Contains(fileIndexes, index => index.Name == "IX_Files_UserId" && !index.IsUnique);

        var contentHashColumns = await ReadIndexColumnsAsync(connection, "IX_Files_ContentHash");
        Assert.Equal(new[] { "ContentHash" }, contentHashColumns);

        var folderIndexes = await ReadIndexesAsync(connection, "FolderConfigs");
        Assert.Contains(folderIndexes, index => index.Name == "IX_FolderConfigs_FolderPath" && index.IsUnique);

        var folderPathColumns = await ReadIndexColumnsAsync(connection, "IX_FolderConfigs_FolderPath");
        Assert.Equal(new[] { "FolderPath" }, folderPathColumns);
    }

    [Fact]
    public async Task FileRepository_CRUD_RoundTrips()
    {
        await using var database = new TemporaryDatabase();
        await MigrateAsync(database);

        var repository = new FileRepository(new TestDbContextFactory(database.CreateOptions()));
        var original = CreateFile("photo.jpg", new string('a', 64));

        await repository.AddAsync(original);

        var byId = await repository.GetByIdAsync(original.Id);
        Assert.NotNull(byId);
        Assert.Equal(original.Id, byId!.Id);
        Assert.Equal(original.ContentHash, byId.ContentHash);

        var byHash = await repository.GetByContentHashAsync(original.ContentHash);
        Assert.NotNull(byHash);
        Assert.Equal(original.Id, byHash!.Id);
        Assert.True(await repository.ExistsByContentHashAsync(original.ContentHash));
        Assert.False(await repository.ExistsByContentHashAsync(new string('b', 64)));

        var all = await repository.GetAllAsync();
        Assert.Single(all);

        original.Status = UploadStatus.Uploaded;
        original.MegaTempPath = "/temp/uploads/device-1/photo.jpg";
        original.PermanentPath = "/backups/photo.jpg";
        original.Thumbnails["small"] = "/thumbs/small.jpg";
        original.RetryCount = 2;
        original.LastAttemptAt = DateTime.UtcNow;

        await repository.UpdateAsync(original);

        var updated = await repository.GetByIdAsync(original.Id);
        Assert.NotNull(updated);
        Assert.Equal(UploadStatus.Uploaded, updated!.Status);
        Assert.Equal("/backups/photo.jpg", updated.PermanentPath);
        Assert.Equal("/thumbs/small.jpg", updated.Thumbnails["small"]);
        Assert.Equal(2, updated.RetryCount);

        Assert.True(await repository.DeleteAsync(original.Id));
        Assert.Null(await repository.GetByIdAsync(original.Id));
        Assert.False(await repository.DeleteAsync(original.Id));
    }

    [Fact]
    public async Task FolderRepository_CRUD_RoundTrips()
    {
        await using var database = new TemporaryDatabase();
        await MigrateAsync(database);

        var repository = new FolderRepository(new TestDbContextFactory(database.CreateOptions()));
        var original = new FolderConfig
        {
            FolderPath = database.DatabasePath + ".photos",
            FolderName = "Photos",
            IncludePatterns = new List<string> { "*.jpg", "*.png" },
            ExcludePatterns = new List<string> { "*.tmp" }
        };

        await repository.AddAsync(original);

        var byId = await repository.GetByIdAsync(original.Id);
        Assert.NotNull(byId);
        Assert.Equal(original.Id, byId!.Id);
        Assert.Equal(new[] { "*.jpg", "*.png" }, byId.IncludePatterns);

        var byPath = await repository.GetByPathAsync(original.FolderPath);
        Assert.NotNull(byPath);
        Assert.Equal(original.Id, byPath!.Id);

        var all = await repository.GetAllAsync();
        Assert.Single(all);

        original.IsEnabled = false;
        original.IncludeSubfolders = false;
        original.LastScannedAt = DateTime.UtcNow;
        original.ExcludePatterns.Add("*.bak");

        await repository.UpdateAsync(original);

        var updated = await repository.GetByIdAsync(original.Id);
        Assert.NotNull(updated);
        Assert.False(updated!.IsEnabled);
        Assert.False(updated.IncludeSubfolders);
        Assert.NotNull(updated.LastScannedAt);
        Assert.Contains("*.bak", updated.ExcludePatterns);

        Assert.True(await repository.DeleteAsync(original.Id));
        Assert.Null(await repository.GetByIdAsync(original.Id));
        Assert.False(await repository.DeleteAsync(original.Id));
    }

    [Fact]
    public async Task UniqueIndexes_RejectDuplicateContentHashAndFolderPath()
    {
        await using var database = new TemporaryDatabase();
        await MigrateAsync(database);

        var fileRepository = new FileRepository(new TestDbContextFactory(database.CreateOptions()));
        await fileRepository.AddAsync(CreateFile("first.jpg", new string('c', 64)));

        var duplicateHash = CreateFile("second.jpg", new string('c', 64));
        await Assert.ThrowsAsync<DbUpdateException>(() => fileRepository.AddAsync(duplicateHash));

        var folderRepository = new FolderRepository(new TestDbContextFactory(database.CreateOptions()));
        var folderPath = Path.Combine(database.DirectoryPath, "photos");
        await folderRepository.AddAsync(new FolderConfig
        {
            FolderPath = folderPath,
            FolderName = "Photos"
        });

        var duplicatePath = new FolderConfig
        {
            FolderPath = folderPath,
            FolderName = "Photos duplicate"
        };

        await Assert.ThrowsAsync<DbUpdateException>(() => folderRepository.AddAsync(duplicatePath));
    }

    [Fact]
    public async Task AddStashData_RegistersRepositories_AndInitializesDatabase()
    {
        await using var database = new TemporaryDatabase();
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddStashData(database.DatabasePath);

        await using var provider = services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateOnBuild = true,
            ValidateScopes = true
        });

        Assert.IsType<FileRepository>(provider.GetRequiredService<IFileRepository>());
        Assert.IsType<FolderRepository>(provider.GetRequiredService<IFolderRepository>());

        provider.InitializeStashDatabase();

        Assert.True(File.Exists(database.DatabasePath));
        await using var db = new StashDbContext(database.CreateOptions());
        Assert.Empty(await db.Database.GetPendingMigrationsAsync());
    }

    private static async Task MigrateAsync(TemporaryDatabase database)
    {
        await using var db = new StashDbContext(database.CreateOptions());
        await db.Database.MigrateAsync();
    }

    private static FileEntity CreateFile(string fileName, string contentHash)
    {
        return new FileEntity
        {
            FileName = fileName,
            FilePath = $"/photos/{fileName}",
            FileSize = 1024,
            ContentHash = contentHash,
            MimeType = "image/jpeg",
            DeviceId = "device-1",
            UserId = "user-1"
        };
    }

    private static async Task<List<string>> ReadStringsAsync(
        SqliteConnection connection,
        string commandText)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = commandText;
        await using var reader = await command.ExecuteReaderAsync();

        var values = new List<string>();
        while (await reader.ReadAsync())
            values.Add(reader.GetString(0));

        return values;
    }

    private static async Task<List<(string Name, bool IsUnique)>> ReadIndexesAsync(
        SqliteConnection connection,
        string tableName)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = $"PRAGMA index_list('{tableName}');";
        await using var reader = await command.ExecuteReaderAsync();

        var indexes = new List<(string Name, bool IsUnique)>();
        while (await reader.ReadAsync())
            indexes.Add((reader.GetString(1), reader.GetInt64(2) != 0));

        return indexes;
    }

    private static async Task<List<string>> ReadIndexColumnsAsync(
        SqliteConnection connection,
        string indexName)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = $"PRAGMA index_info('{indexName}');";
        await using var reader = await command.ExecuteReaderAsync();

        var columns = new List<string>();
        while (await reader.ReadAsync())
            columns.Add(reader.GetString(2));

        return columns;
    }

    private sealed class TestDbContextFactory : IDbContextFactory<StashDbContext>
    {
        private readonly DbContextOptions<StashDbContext> _options;

        public TestDbContextFactory(DbContextOptions<StashDbContext> options)
        {
            _options = options;
        }

        public StashDbContext CreateDbContext() => new(_options);
    }

    private sealed class TemporaryDatabase : IAsyncDisposable
    {
        public TemporaryDatabase()
        {
            DirectoryPath = Path.Combine(
                Path.GetTempPath(),
                "stash-maui-tests",
                Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(DirectoryPath);
            DatabasePath = Path.Combine(DirectoryPath, "stash.db");
        }

        public string DirectoryPath { get; }

        public string DatabasePath { get; }

        public string ConnectionString => new SqliteConnectionStringBuilder
        {
            DataSource = DatabasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Pooling = false
        }.ToString();

        public DbContextOptions<StashDbContext> CreateOptions()
        {
            return new DbContextOptionsBuilder<StashDbContext>()
                .UseSqlite(ConnectionString)
                .Options;
        }

        public ValueTask DisposeAsync()
        {
            SqliteConnection.ClearAllPools();

            try
            {
                if (Directory.Exists(DirectoryPath))
                    Directory.Delete(DirectoryPath, recursive: true);
            }
            catch (IOException)
            {
                // A transient SQLite handle should not fail the test result.
            }

            return ValueTask.CompletedTask;
        }
    }
}
