using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Stash.Maui.Auth;
using Stash.Maui.Navigation;

namespace Stash.Maui.ViewModels;

/// <summary>
/// Drives account creation. Registration signs the new user in immediately because
/// the Identity API returns a token pair from /api/auth/register.
/// </summary>
public partial class RegisterViewModel : ObservableObject
{
    private readonly IAuthenticationService _authenticationService;
    private bool _initialized;

    [ObservableProperty]
    public partial string Email { get; set; }

    [ObservableProperty]
    public partial string Password { get; set; }

    [ObservableProperty]
    public partial string ConfirmPassword { get; set; }

    [ObservableProperty]
    public partial string DeviceId { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsNotBusy))]
    public partial bool IsBusy { get; set; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError))]
    public partial string? ErrorMessage { get; set; }

    public RegisterViewModel(IAuthenticationService authenticationService)
    {
        _authenticationService = authenticationService;
        Email = string.Empty;
        Password = string.Empty;
        ConfirmPassword = string.Empty;
        DeviceId = string.Empty;
    }

    public bool IsNotBusy => !IsBusy;

    public bool HasError => !string.IsNullOrWhiteSpace(ErrorMessage);

    public async Task InitializeAsync(CancellationToken ct = default)
    {
        if (_initialized)
            return;

        try
        {
            if (string.IsNullOrWhiteSpace(DeviceId))
                DeviceId = await _authenticationService.GetOrCreateDeviceIdAsync(ct);

            _initialized = true;
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Secure storage is unavailable: {ex.Message}";
        }
    }

    [RelayCommand]
    private async Task RegisterAsync()
    {
        if (IsBusy)
            return;

        if (!string.Equals(Password, ConfirmPassword, StringComparison.Ordinal))
        {
            ErrorMessage = "Passwords do not match.";
            return;
        }

        if (Password.Length < 8)
        {
            ErrorMessage = "Password must be at least 8 characters.";
            return;
        }

        IsBusy = true;
        ErrorMessage = null;

        try
        {
            await InitializeAsync();

            if (string.IsNullOrWhiteSpace(DeviceId))
            {
                ErrorMessage ??= "A device ID is required.";
                return;
            }

            var result = await _authenticationService.RegisterAsync(
                Email.Trim(),
                Password,
                DeviceId.Trim(),
                CancellationToken.None);

            if (!result.IsSuccess)
            {
                ErrorMessage = result.Error ?? "Registration failed.";
                return;
            }

            Password = string.Empty;
            ConfirmPassword = string.Empty;
            await Shell.Current.GoToAsync($"//{StashRoutes.Main}");
        }
        catch (Exception ex)
        {
            ErrorMessage = ex.Message;
        }
        finally
        {
            IsBusy = false;
        }
    }

    [RelayCommand]
    private Task GoBackAsync()
    {
        return Shell.Current.GoToAsync("..");
    }
}
