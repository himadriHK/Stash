import 'package:flutter/material.dart';

import 'views/login_page.dart';
import 'views/register_page.dart';
import 'views/main_page.dart';
import 'views/file_list_page.dart';
import 'views/folder_config_page.dart';

class Routes {
  static final navigatorKey = GlobalKey<NavigatorState>();
  static GlobalKey<NavigatorState> get navKey => navigatorKey;

  static const String login = '/login';
  static const String register = '/register';
  static const String main = '/main';
  static const String files = '/files';
  static const String folders = '/folders';

  static Route<dynamic> generate(RouteSettings settings) {
    switch (settings.name) {
      case login:
        return MaterialPageRoute(builder: (_) => const LoginPage());
      case register:
        return MaterialPageRoute(builder: (_) => const RegisterPage());
      case main:
        return MaterialPageRoute(builder: (_) => const MainPage());
      case files:
        return MaterialPageRoute(builder: (_) => const FileListPage());
      case folders:
        return MaterialPageRoute(builder: (_) => const FolderConfigPage());
      default:
        return _unknownRoute(settings);
    }
  }

  static Route<dynamic> _unknownRoute(RouteSettings settings) {
    return MaterialPageRoute(
      builder: (_) => Scaffold(
        appBar: AppBar(title: const Text('Unknown Route')),
        body: const Center(child: Text('Route not found')),
      ),
    );
  }
}