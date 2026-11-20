import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../routes.dart';
import '../providers/auth_provider.dart';
import '../providers/app_config.dart';

class LoginPage extends StatelessWidget {
  const LoginPage({super.key});

  @override
  Widget build(BuildContext context) {
    final authProvider = context.watch<AuthProvider>();
    final appConfig = context.watch<AppConfig>();
    final deviceId = authProvider.deviceId ?? '';

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
                  'Sign in to your backup account',
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
                    // Update email in view model
                  },
                ),
                const SizedBox(height: 14),

                // Password field
                TextFormField(
                  decoration: InputDecoration(
                    labelText: 'Password',
                    labelStyle: TextStyle(
                      color: Theme.of(context).colorScheme.primary,
                      fontFamily: 'OpenSans',
                    ),
                    hintText: 'Enter your password',
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
                    // Update password in view model
                  },
                ),
                const SizedBox(height: 14),

                // Device ID field (prefilled)
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
                  initialValue: deviceId,
                  readOnly: deviceId.isNotEmpty,
                  onChanged: (value) {
                    // Update device ID
                  },
                ),
                const SizedBox(height: 8),

                // Device ID note
                Padding(
                  padding: const EdgeInsets.only(left: 4),
                  child: Text(
                    'The device ID identifies this installation. It is generated automatically and can be left unchanged.',
                    style: TextStyle(
                      fontSize: 12,
                      color: Color(0xFF121212),
                      fontFamily: 'OpenSans',
                      fontStyle: FontStyle.italic,
                    ),
                  ),
                ),
                const SizedBox(height: 24),

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

                // Sign in button
                ElevatedButton(
                  onPressed: authProvider.isBusy ? null : () async {
                    final result = await authProvider.login(
                      email: '',
                      password: '',
                    );
                    if (result) {
                      // Login successful - notify auth provider
                      authProvider.notifyListeners();
                    } else {
                      // Login failed - error message already set by AuthProvider
                      authProvider.notifyListeners();
                    }
                  },
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF512BD4), // Primary
                    foregroundColor: Colors.white,
                    minimumSize: const Size(double.infinity, 44),
                  ),
                  child: const Text('Sign in'),
                ),
                const SizedBox(height: 14),

                // Create account link
                TextButton(
                  onPressed: authProvider.isBusy ? null : () {
                    Routes.navKey.currentState?.pushNamed('/register');
                  },
                  child: const Text(
                    'Create account',
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