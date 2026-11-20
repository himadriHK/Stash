import 'package:sqflite_common/sqflite.dart';

import '../models/folder_config.dart';
import '../models/upload_status.dart';
import '../services/database_helper.dart';

abstract class IFolderRepository {
  Future<FolderConfig?> getByIdAsync(String id);
  Future<FolderConfig?> getByPathAsync(String folderPath);
  Future<List<FolderConfig>> getAllAsync();
  Future<int> addAsync(FolderConfig folder);
  Future<String> updateAsync(FolderConfig folder);
  Future<String> deleteAsync(String id);
}

class FolderRepository implements IFolderRepository {
  final DatabaseHelper _dbHelper;

  FolderRepository(this._dbHelper);

  @override
  Future<void> init() async {
    // Initialize database - accessed lazily via _dbHelper.database
    await _dbHelper.database;
  }

  @override
  Future<FolderConfig?> getByIdAsync(String id) async {
    final Database db = await _dbHelper.database;
    final List<Map<String, dynamic>> maps = await db.query(
      'folder_configs',
      where: 'id = ?',
      whereArgs: [id],
    );

    if (maps.isEmpty) return null;
    return _mapFolderConfig(maps.first);
  }

  @override
  Future<FolderConfig?> getByPathAsync(String folderPath) async {
    final Database db = await _dbHelper.database;
    final List<Map<String, dynamic>> maps = await db.query(
      'folder_configs',
      where: 'folder_path = ?',
      whereArgs: [folderPath],
    );

    if (maps.isEmpty) return null;
    return _mapFolderConfig(maps.first);
  }

  @override
  Future<List<FolderConfig>> getAllAsync() async {
    final Database db = await _dbHelper.database;
    final List<Map<String, dynamic>> maps = await db.query('folder_configs');
    return maps.map(_mapFolderConfig).toList();
  }

  @override
  Future<int> addAsync(FolderConfig folder) async {
    final Database db = await _dbHelper.database;
    final json = folder.toJson();
    final id = await db.insert('folder_configs', json,
        conflictAlgorithm: ConflictAlgorithm.replace);
    return id;
  }

  @override
  Future<String> updateAsync(FolderConfig folder) async {
    final Database db = await _dbHelper.database;
    final json = folder.toJson();
    final result = await db.update(
      'folder_configs',
      json,
      where: 'id = ?',
      whereArgs: [folder.id],
    );
    return result.toString();
  }

  @override
  Future<String> deleteAsync(String id) async {
    final Database db = await _dbHelper.database;
    final result = await db.delete(
      'folder_configs',
      where: 'id = ?',
      whereArgs: [id],
    );
    return result.toString();
  }

  FolderConfig _mapFolderConfig(Map<String, dynamic> map) {
    return FolderConfig(
      id: map['id'] as String,
      folderPath: map['folder_path'] as String,
      folderName: map['folder_name'] as String,
      isEnabled: map['is_enabled'] as int == 1,
      addedAt: DateTime.parse(map['added_at'] as String),
      lastScannedAt: map['last_scanned_at'] != null
          ? DateTime.parse(map['last_scanned_at'] as String)
          : null,
      includePatterns: List<String>.from(
        (map['include_patterns'] as dynamic) ?? [],
      ),
      excludePatterns: List<String>.from(
        (map['exclude_patterns'] as dynamic) ?? [],
      ),
      includeSubfolders: map['include_subfolders'] as int == 1,
    );
  }
}