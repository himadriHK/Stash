import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../routes.dart';
import '../providers/auth_provider.dart';
import '../providers/app_config.dart';

class RegisterPage extends StatelessWidget {
  const RegisterPage({super.key});

  @override
  Widget build(BuildContext context) {
    final authProvider = context.watch<AuthProvider>();
    final appConfig = context.watch<AppConfig>();

    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 480),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Stash logo/text
                const Text(
                  'Stash',
                  style: TextStyle(
                    fontSize: 32,
                    fontWeight: FontWeight.bold,
                    color: Color(0xFF190649), // MidnightBlue
                    fontFamily: 'OpenSans',
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 8),
                const Text(
                  'Register this device for Stash backups',
                  style: TextStyle(
                    fontSize: 24,
                    color: Color(0xFF190649), // MidnightBlue
                    fontFamily: 'OpenSans',
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 32),

                // Email field
                TextFormField(
                  decoration: InputDecoration(
                    labelText: 'Email',
                    labelStyle: TextStyle(
                      color: Theme.of(context).colorScheme.primary,
                      fontFamily: 'OpenSans',
                    ),
                    hintText: 'Enter your email',
                    hintStyle: TextStyle(
                      color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.5),
                      fontFamily: 'OpenSans',
                    ),
                    border: OutlineInputBorder(
                      borderSide: BorderSide(
                        color: Theme.of(context).colorScheme.secondary,
                      ),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderSide: BorderSide(
                        color: Theme.of(context).colorScheme.secondary,
                      ),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderSide: BorderSide(
                        color: Theme.of(context).colorScheme.primary,
                        width: 2,
                      ),
                    ),
                  ),
                  keyboardType: TextInputType.emailAddress,
                  onChanged: (value) {
                    // Update email
                  },
                ),
                const SizedBox(height: 14),

                // Password field
                TextFormField(
                  decoration: InputDecoration(
                    labelText: 'Password (minimum 8 characters)',
                    labelStyle: TextStyle(
                      color: Theme.of(context).colorScheme.primary,
                      fontFamily: 'OpenSans',
                    ),
                    hintText: 'Create a password',
                    hintStyle: TextStyle(
                      color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.5),
                      fontFamily: 'OpenSans',
                    ),
                    border: OutlineInputBorder(
                      borderSide: BorderSide(
                        color: Theme.of(context).colorScheme.secondary,
                      ),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderSide: BorderSide(
                        color: Theme.of(context).colorScheme.secondary,
                      ),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderSide: BorderSide(
                        color: Theme.of(context).colorScheme.primary,
                        width: 2,
                      ),
                    ),
                  ),
                  obscureText: true,
                  onChanged: (value) {
                    // Update password
                  },
                ),
                const SizedBox(height: 14),

                // Confirm password field
                TextFormField(
                  decoration: InputDecoration(
                    labelText: 'Confirm password',
                    labelStyle: TextStyle(
                      color: Theme.of(context).colorScheme.primary,
                      fontFamily: 'OpenSans',
                    ),
                    hintText: 'Confirm your password',
                    hintStyle: TextStyle(
                      color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.5),
                      fontFamily: 'OpenSans',
                    ),
                    border: OutlineInputBorder(
                      borderSide: BorderSide(
                        color: Theme.of(context).colorScheme.secondary,
                      ),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderSide: BorderSide(
                        color: Theme.of(context).colorScheme.secondary,
                      ),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderSide: BorderSide(
                        color: Theme.of(context).colorScheme.primary,
                        width: 2,
                      ),
                    ),
                  ),
                  obscureText: true,
                  onChanged: (value) {
                    // Update confirm password
                  },
                ),
                const SizedBox(height: 14),

                // Device ID field
                TextFormField(
                  decoration: InputDecoration(
                    labelText: 'Device ID',
                    labelStyle: TextStyle(
                      color: Theme.of(context).colorScheme.primary,
                      fontFamily: 'OpenSans',
                    ),
                    hintText: 'Device ID (auto-generated)',
                    hintStyle: TextStyle(
                      color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.5),
                      fontFamily: 'OpenSans',
                      fontStyle: FontStyle.italic,
                    ),
                    border: OutlineInputBorder(
                      borderSide: BorderSide(
                        color: Theme.of(context).colorScheme.secondary,
                      ),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderSide: BorderSide(
                        color: Theme.of(context).colorScheme.secondary,
                      ),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderSide: BorderSide(
                        color: Theme.of(context).colorScheme.primary,
                        width: 2,
                      ),
                    ),
                  ),
                  initialValue: authProvider.deviceId ?? '',
                  readOnly: authProvider.deviceId?.isNotEmpty ?? false,
                  onChanged: (value) {
                    // Update device ID
                  },
                ),
                const SizedBox(height: 8),

                // Error label
                if (authProvider.errorMessage != null) ...[
                  Container(
                    margin: const EdgeInsets.only(bottom: 8),
                    padding: const EdgeInsets.all(8),
                    color: const Color(0xFFB00020).withValues(alpha: 0.1),
                    child: Row(
                      children: [
                        const Icon(Icons.error, color: Color(0xFFB00020), size: 20),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            authProvider.errorMessage!,
                            style: const TextStyle(
                              color: Color(0xFFB00020),
                              fontFamily: 'OpenSans',
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],

                // Activity indicator
                if (authProvider.isBusy) ...[
                  Padding(
                    padding: EdgeInsets.only(top: 8),
                    child: CircularProgressIndicator(),
                  ),
                ],

                // Register button
                ElevatedButton(
                  onPressed: authProvider.isBusy ? null : () async {
                    final result = await authProvider.register(
                      email: '', // Would get from text fields
                      password: '', // Would get from text fields
                      confirmPassword: '', // Would get from text fields
                    );
                    if (!result) {
                      // Registration failed - error message already set by AuthProvider
                      authProvider.notifyListeners();
                    } else {
                      // Navigate to main
                      Routes.navKey.currentState?.pushNamed('/main');
                    }
                  },
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF512BD4), // Primary
                    foregroundColor: Colors.white,
                    minimumSize: const Size(double.infinity, 44),
                  ),
                  child: const Text('Create account'),
                ),
                const SizedBox(height: 14),

                // Back to login link
                TextButton(
                  onPressed: authProvider.isBusy ? null : () {
                    Routes.navKey.currentState?.pushNamed('/login');
                  },
                  child: const Text(
                    'Back to sign in',
                    style: TextStyle(
                      color: Color(0xFF512BD4), // Primary
                      fontFamily: 'OpenSans',
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}