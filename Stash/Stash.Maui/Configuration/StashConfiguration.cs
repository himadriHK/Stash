using System.Reflection;
using Microsoft.Extensions.Configuration;

namespace Stash.Maui.Configuration;

/// <summary>
/// Loads the mobile app's configuration. The JSON file is embedded in the app
/// assembly because MAUI asset paths differ between Android, iOS, and Windows.
/// </summary>
public static class StashConfiguration
{
    public const string AppSettingsResourceName = "Stash.Maui.appsettings.json";

    /// <summary>
    /// Builds configuration from a JSON stream.
    /// </summary>
    public static IConfigurationRoot Load(Stream jsonStream)
    {
        ArgumentNullException.ThrowIfNull(jsonStream);

        return new ConfigurationBuilder()
            .AddJsonStream(jsonStream)
            .Build();
    }

    /// <summary>
    /// Loads the appsettings.json embedded in the supplied assembly.
    /// </summary>
    public static IConfigurationRoot LoadEmbedded(Assembly assembly)
    {
        ArgumentNullException.ThrowIfNull(assembly);

        using var stream = assembly.GetManifestResourceStream(AppSettingsResourceName)
            ?? throw new InvalidOperationException(
                $"Embedded configuration resource '{AppSettingsResourceName}' was not found in '{assembly.FullName}'.");

        return Load(stream);
    }
}
