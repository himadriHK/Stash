using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Maui.Storage;
using Stash.Maui.Auth;
using Stash.Maui.Configuration;
using Stash.Maui.Data;
using Stash.Maui.Services;
using Stash.Maui.ViewModels;
using Stash.Maui.Views;

namespace Stash.Maui;

public static class MauiProgram
{
	public static MauiApp CreateMauiApp()
	{
		var builder = MauiApp.CreateBuilder();
		builder
			.UseMauiApp<App>()
			.ConfigureFonts(fonts =>
			{
				fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
				fonts.AddFont("OpenSans-Semibold.ttf", "OpenSansSemibold");
			});

		var configuration = StashConfiguration.LoadEmbedded(typeof(MauiProgram).Assembly);

		builder.Services.AddSingleton<ISecureStorageService, MauiSecureStorage>();
		builder.Services.AddStashServices(configuration);

		var databasePath = Path.Combine(FileSystem.AppDataDirectory, StashDatabase.FileName);
		builder.Services.AddStashData(databasePath);
		builder.Services.AddStashUploadServices();
		builder.Services.AddStashKafkaServices();
		builder.Services.AddStashBackgroundUploadServices();

		builder.Services.AddTransient<LoginViewModel>();
		builder.Services.AddTransient<RegisterViewModel>();
		builder.Services.AddTransient<LoginPage>();
		builder.Services.AddTransient<RegisterPage>();

		// Resolve the shell and its first page through the container so future
		// pages and view models can use constructor injection.
		builder.Services.AddSingleton<AppShell>();
		builder.Services.AddTransient<MainPage>();

#if DEBUG
		builder.Logging.AddDebug();
#endif

		var app = builder.Build();

		// Apply migrations before any repository is used. The database is small and
		// this runs once at startup; tests await MigrateAsync against temp databases.
		app.Services.InitializeStashDatabase();

		// Register the platform worker during startup. iOS requires its BGTask
		// handler to be registered before FinishedLaunching returns.
		var scheduler = app.Services.GetService<IBackgroundUploadScheduler>();
		if (scheduler is not null)
		{
			try
			{
				scheduler.ScheduleAsync().GetAwaiter().GetResult();
			}
			catch (Exception ex)
			{
				app.Services.GetService<ILogger<App>>()?.LogWarning(
					ex,
					"Failed to schedule the background upload worker.");
			}
		}

		return app;
	}
}
