using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using Stash.Maui.Data.Entities;

namespace Stash.Maui.Data;

/// <summary>
/// SQLite database for local file metadata. The database path is supplied through
/// <see cref="DbContextOptions{TContext}"/> so MAUI owns the platform-specific
/// AppDataDirectory path while tests can use a temporary directory.
/// </summary>
public sealed class StashDbContext : DbContext
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public StashDbContext(DbContextOptions<StashDbContext> options)
        : base(options)
    {
    }

    public DbSet<FileEntity> Files => Set<FileEntity>();

    public DbSet<FolderConfig> FolderConfigs => Set<FolderConfig>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        var thumbnailsConverter = new ValueConverter<Dictionary<string, string>, string>(
            value => JsonSerializer.Serialize(value, JsonOptions),
            value => JsonSerializer.Deserialize<Dictionary<string, string>>(value, JsonOptions)
                ?? new Dictionary<string, string>());

        var thumbnailsComparer = new ValueComparer<Dictionary<string, string>>(
            (left, right) => left != null && right != null
                ? left.Count == right.Count && !left.Except(right).Any()
                : ReferenceEquals(left, right),
            value => value == null
                ? 0
                : value.Aggregate(0, (hash, pair) => HashCode.Combine(hash, pair.Key, pair.Value)),
            value => value == null
                ? new Dictionary<string, string>()
                : new Dictionary<string, string>(value));

        var stringListConverter = new ValueConverter<List<string>, string>(
            value => JsonSerializer.Serialize(value, JsonOptions),
            value => JsonSerializer.Deserialize<List<string>>(value, JsonOptions) ?? new List<string>());

        var stringListComparer = new ValueComparer<List<string>>(
            (left, right) => left != null && right != null
                ? left.SequenceEqual(right)
                : ReferenceEquals(left, right),
            value => value == null
                ? 0
                : value.Aggregate(0, (hash, item) => HashCode.Combine(hash, item)),
            value => value == null
                ? new List<string>()
                : new List<string>(value));

        modelBuilder.Entity<FileEntity>(entity =>
        {
            entity.ToTable("Files");
            entity.HasKey(e => e.Id).HasName("PK_Files");

            entity.Property(e => e.FileName).IsRequired().HasMaxLength(512);
            entity.Property(e => e.FilePath).IsRequired().HasMaxLength(2048);
            entity.Property(e => e.ContentHash).IsRequired().HasMaxLength(64);
            entity.Property(e => e.MimeType).IsRequired().HasMaxLength(128);
            entity.Property(e => e.DeviceId).IsRequired().HasMaxLength(128);
            entity.Property(e => e.UserId).IsRequired().HasMaxLength(128);
            entity.Property(e => e.MegaTempPath).HasMaxLength(2048);
            entity.Property(e => e.PermanentPath).HasMaxLength(2048);
            entity.Property(e => e.ErrorMessage).HasMaxLength(2048);
            entity.Property(e => e.ConvertedFormat).HasMaxLength(32);
            entity.Property(e => e.Status).HasConversion<string>().HasMaxLength(32);
            entity.Property(e => e.Thumbnails)
                .HasConversion(thumbnailsConverter, thumbnailsComparer)
                .HasColumnType("TEXT");

            entity.HasIndex(e => e.ContentHash)
                .IsUnique()
                .HasDatabaseName("IX_Files_ContentHash");
            entity.HasIndex(e => e.Status).HasDatabaseName("IX_Files_Status");
            entity.HasIndex(e => e.DeviceId).HasDatabaseName("IX_Files_DeviceId");
            entity.HasIndex(e => e.UserId).HasDatabaseName("IX_Files_UserId");
        });

        modelBuilder.Entity<FolderConfig>(entity =>
        {
            entity.ToTable("FolderConfigs");
            entity.HasKey(e => e.Id).HasName("PK_FolderConfigs");

            entity.Property(e => e.FolderPath).IsRequired().HasMaxLength(2048);
            entity.Property(e => e.FolderName).IsRequired().HasMaxLength(256);
            entity.Property(e => e.IncludePatterns)
                .HasConversion(stringListConverter, stringListComparer)
                .HasColumnType("TEXT");
            entity.Property(e => e.ExcludePatterns)
                .HasConversion(stringListConverter, stringListComparer)
                .HasColumnType("TEXT");

            entity.HasIndex(e => e.FolderPath)
                .IsUnique()
                .HasDatabaseName("IX_FolderConfigs_FolderPath");
        });
    }
}
