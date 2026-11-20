using Stash.Maui.Auth;
using Stash.Maui.Navigation;

namespace Stash.Maui;

public partial class MainPage : ContentPage
{
    private readonly IAuthenticationService _authenticationService;

    public MainPage(IAuthenticationService authenticationService)
    {
        InitializeComponent();
        _authenticationService = authenticationService;
    }

    private async void OnLogoutClicked(object? sender, EventArgs e)
    {
        try
        {
            await _authenticationService.LogoutAsync();
            await Shell.Current.GoToAsync($"//{StashRoutes.Login}");
        }
        catch (Exception ex)
        {
            await DisplayAlertAsync("Logout failed", ex.Message, "OK");
        }
    }
}
