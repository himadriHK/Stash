using Stash.Maui.Navigation;
using Stash.Maui.Views;

namespace Stash.Maui;

public partial class AppShell : Shell
{
    public AppShell(LoginPage loginPage, MainPage mainPage)
    {
        InitializeComponent();

        Items.Add(new ShellContent
        {
            Title = "Sign in",
            Route = StashRoutes.Login,
            Content = loginPage
        });

        Items.Add(new ShellContent
        {
            Title = "Home",
            Route = StashRoutes.Main,
            Content = mainPage
        });

        Routing.RegisterRoute(
            StashRoutes.Register,
            new ServiceProviderRouteFactory<RegisterPage>());
    }
}
