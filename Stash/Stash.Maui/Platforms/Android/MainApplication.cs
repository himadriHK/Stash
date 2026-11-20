using Android.App;
using Android.Runtime;
using AndroidX.Work;

namespace Stash.Maui;

[Application]
public class MainApplication : MauiApplication
{
	public MainApplication(IntPtr handle, JniHandleOwnership ownership)
		: base(handle, ownership)
	{
	}

	protected override MauiApp CreateMauiApp() => MauiProgram.CreateMauiApp();

	public override void OnCreate()
	{
		try
		{
			// AndroidX Startup normally initializes WorkManager before
			// Application.OnCreate. Initialize explicitly when the provider is
			// absent so MauiProgram can schedule work during app construction.
			WorkManager.Initialize(this, new AndroidX.Work.Configuration.Builder().Build());
		}
		catch (Java.Lang.IllegalStateException)
		{
			// Already initialized by AndroidX Startup.
		}

		base.OnCreate();
	}
}
