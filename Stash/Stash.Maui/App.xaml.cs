using Microsoft.Extensions.DependencyInjection;

namespace Stash.Maui;

public partial class App : Application
{
	private readonly IServiceProvider _services;

	public App(IServiceProvider services)
	{
		InitializeComponent();
		_services = services;
	}

	protected override Window CreateWindow(IActivationState? activationState)
	{
		// Resolve the shell after App.InitializeComponent has loaded application
		// resources; resolving it in App's constructor would construct MainPage too
		// early and its StaticResource lookups would fail.
		return new Window(_services.GetRequiredService<AppShell>());
	}
}
