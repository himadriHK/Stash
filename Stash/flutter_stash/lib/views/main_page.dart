import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../routes.dart';
import '../providers/auth_provider.dart';
import '../providers/app_config.dart';

class MainPage extends StatelessWidget {
  const MainPage({super.key});

  @override
  Widget build(BuildContext context) {
    final authProvider = context.watch<AuthProvider>();
    final appConfig = context.watch<AppConfig>();

    // Check if authenticated
    if (!authProvider.isAuthenticated) {
      // Redirect to login if not authenticated
      WidgetsBinding.instance.addPostFrameCallback((_) {
        Routes.navKey.currentState?.pushNamedAndRemoveUntil('/login', (route) => false);
      });
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('Stash'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: () async {
              await authProvider.logout();
              Routes.navKey.currentState?.pushNamedAndRemoveUntil('/login', (route) => false);
            },
          ),
        ],
      ),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Text(
              'Welcome to Stash!',
              style: TextStyle(
                fontSize: 24,
                color: Color(0xFF190649), // MidnightBlue
                fontFamily: 'OpenSans',
              ),
            ),
            const SizedBox(height: 16),
            Text(
              'Logged in as: ${authProvider.userId ?? 'Unknown'}',
              style: const TextStyle(
                fontSize: 16,
                color: Colors.grey,
                fontFamily: 'OpenSans',
              ),
            ),
            const SizedBox(height: 32),
            ElevatedButton(
              onPressed: () {
                // Navigate to upload screen or other features
                Routes.navKey.currentState?.pushNamed('/upload');
              },
              child: const Text('Upload Files'),
            ),
            const SizedBox(height: 16),
            ElevatedButton(
              onPressed: () {
                // Navigate to folder configuration
                Routes.navKey.currentState?.pushNamed('/folders');
              },
              child: const Text('Configure Folders'),
            ),
          ],
        ),
      ),
    );
  }
}