import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:sqflite_common_ffi_web/sqflite_ffi_web.dart';
import 'package:path/path.dart';
import 'package:path_provider/path_provider.dart';

/// Initialize the sqflite FFI factory for the current platform.
/// Must be called before any database operations.
Future<void> initializeSqflite() async {
  if (identical(0, 0.0)) {
    // Running on web (dart2js / WASM) - use the WASM SQLite build.
    final factory = databaseFactoryFfiWeb;
    databaseFactory = factory;
  } else {
    // Running on native (Android, iOS, desktop) - use FFI to native SQLite.
    sqfliteFfiInit();
  }
}

class DatabaseHelper {
  static final DatabaseHelper _instance = DatabaseHelper._internal();
  factory DatabaseHelper() => _instance;
  DatabaseHelper._internal();

  Database? _database;

  Future<Database> get database async {
    if (_database != null) return _database!;
    _database = await _initDB();
    return _database!;
  }

  Future<Database> _initDB() async {
    final directory = await getApplicationDocumentsDirectory();
    final path = join(directory.path, 'stash.db');

    // Use the global database factory (set by initializeSqflite())
    return await databaseFactory.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: 2,
        onCreate: _onCreate,
        onUpgrade: _onUpgrade,
      ),
    );
  }

  Future<void> _onCreate(Database db, int version) async {
    // Version 1: Initial tables
    await db.execute('''
      CREATE TABLE files (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size REAL NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        mime_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        modified_at TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        status TEXT NOT NULL,
        mega_temp_path TEXT,
        permanent_path TEXT,
        error_message TEXT,
        retry_count INTEGER DEFAULT 0,
        last_attempt_at TEXT,
        device_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        thumbnails TEXT DEFAULT '{}'
      )
    ''');

    await db.execute('''
      CREATE TABLE folder_configs (
        id TEXT PRIMARY KEY,
        folder_path TEXT NOT NULL UNIQUE,
        folder_name TEXT NOT NULL,
        is_enabled INTEGER DEFAULT 1,
        added_at TEXT NOT NULL,
        last_scanned_at TEXT,
        include_patterns TEXT DEFAULT '[]',
        exclude_patterns TEXT DEFAULT '[]',
        include_subfolders INTEGER DEFAULT 1
      )
    ''');
  }

  Future<void> _onUpgrade(Database db, int oldVersion, int newVersion) async {
    if (oldVersion < 2) {
      // Add any new columns or tables for v2
      // Example: await db.execute('ALTER TABLE files ADD COLUMN new_column TEXT');
    }
  }
}