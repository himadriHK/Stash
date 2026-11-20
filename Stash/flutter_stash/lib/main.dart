import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'routes.dart';
import 'providers/app_config.dart';
import 'providers/auth_provider.dart';
import 'services/database_helper.dart';
import 'repositories/file_repository.dart';
import 'repositories/folder_repository.dart';
import 'services/folder_scanner_service.dart';
import 'services/mega_http_service.dart';
import 'services/upload_manager.dart';
import 'services/background_upload_service.dart';
import 'services/kafka_http_transport.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  // Initialize sqflite FFI factory for the current platform (web/native)
  initializeSqflite().then((_) => runApp(const MyApp()));
}

class MyApp extends StatefulWidget {
  const MyApp({super.key});

  @override
  State<MyApp> createState() => _MyAppState();
}

class _MyAppState extends State<MyApp> {
  late final AppConfig _appConfig = AppConfig();
  late final AuthProvider _authProvider = AuthProvider();
  late final MegaHttpService _megaService =
      MegaHttpService(_appConfig, _authProvider);
  late final KafkaHttpTransport _kafkaTransport =
      KafkaHttpTransport(_appConfig, _authProvider);
  late final FileRepository _fileRepository =
      FileRepository(DatabaseHelper(), _megaService, _appConfig);
  late final FolderRepository _folderRepository =
      FolderRepository(DatabaseHelper());
  late final FolderScannerService _folderScanner = FolderScannerService();
  late final UploadManager _uploadManager = UploadManager(
    _fileRepository,
    _megaService,
    _appConfig,
    _authProvider,
  );
  late final BackgroundUploadService _backgroundService =
      BackgroundUploadService(
    _fileRepository,
    _uploadManager,
    _kafkaTransport,
    _appConfig,
    _authProvider,
  );

  bool _ready = false;

  @override
  void initState() {
    super.initState();
    _initializeServices();
  }

  Future<void> _initializeServices() async {
    try {
      await _appConfig.load();
      await _authProvider.initialize();
      // sqflite is not available on web; failures here are non-fatal.
      await _fileRepository.init();
      await _folderRepository.init();
    } catch (_) {
      // Keep the app usable even if local persistence is unavailable.
    }

    if (!mounted) return;
    setState(() => _ready = true);
  }

  @override
  Widget build(BuildContext context) {
    if (!_ready) {
      return MaterialApp(
        title: 'Stash',
        navigatorKey: Routes.navKey,
        home: const Scaffold(
          body: Center(child: CircularProgressIndicator()),
        ),
      );
    }

    return MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: _appConfig),
        ChangeNotifierProvider.value(value: _authProvider),
        Provider<FolderRepository>.value(value: _folderRepository),
        Provider<FileRepository>.value(value: _fileRepository),
      ],
      child: MaterialApp(
        title: 'Stash',
        navigatorKey: Routes.navKey,
        initialRoute: _authProvider.isAuthenticated ? '/main' : '/login',
        onGenerateRoute: Routes.generate,
      ),
    );
  }
}