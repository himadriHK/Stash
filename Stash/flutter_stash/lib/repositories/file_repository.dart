import 'package:sqflite_common/sqflite.dart';

import '../models/file_entity.dart';
import '../models/upload_status.dart';
import '../services/database_helper.dart';
import '../services/mega_http_service.dart';
import '../providers/app_config.dart';

abstract class IFileRepository {
  Future<FileEntity?> getByIdAsync(String id);
  Future<FileEntity?> getByContentHashAsync(String contentHash);
  Future<List<FileEntity>> getAllAsync();
  Future<bool> existsByContentHashAsync(String contentHash);
  Future<int> addAsync(FileEntity file);
  Future<String> updateAsync(FileEntity file);
  Future<String> deleteAsync(String id);
}

class FileRepository implements IFileRepository {
  final DatabaseHelper _dbHelper;
  final MegaHttpService _megaService;
  final AppConfig _appConfig;

  FileRepository(this._dbHelper, this._megaService, this._appConfig);

  @override
  Future<void> init() async {
    // Initialize database - accessed lazily via _dbHelper.database
    await _dbHelper.database;
  }

  @override
  Future<FileEntity?> getByIdAsync(String id) async {
    final Database db = await _dbHelper.database;
    final List<Map<String, dynamic>> maps = await db.query(
      'files',
      columns: _columns,
      where: 'id = ?',
      whereArgs: [id],
    );

    if (maps.isEmpty) return null;
    return _mapFileEntity(maps.first);
  }

  @override
  Future<FileEntity?> getByContentHashAsync(String contentHash) async {
    final Database db = await _dbHelper.database;
    final List<Map<String, dynamic>> maps = await db.query(
      'files',
      columns: _columns,
      where: 'content_hash = ?',
      whereArgs: [contentHash],
    );

    if (maps.isEmpty) return null;
    return _mapFileEntity(maps.first);
  }

  @override
  Future<List<FileEntity>> getAllAsync() async {
    final Database db = await _dbHelper.database;
    final List<Map<String, dynamic>> maps = await db.query('files');
    return maps.map(_mapFileEntity).toList();
  }

  @override
  Future<bool> existsByContentHashAsync(String contentHash) async {
    final Database db = await _dbHelper.database;
    final List<Map<String, dynamic>> maps = await db.rawQuery(
      'SELECT COUNT(*) FROM files WHERE content_hash = ?',
      [contentHash],
    );
    if (maps.isEmpty) return false;
    // Sqflite.firstIntValue is not available in sqflite_common; inline it:
    final count = maps.first.values.first as int?;
    return (count ?? 0) > 0;
  }

  @override
  Future<int> addAsync(FileEntity file) async {
    final Database db = await _dbHelper.database;
    final json = file.toJson();
    final id = await db.insert('files', json,
        conflictAlgorithm: ConflictAlgorithm.replace);
    return id;
  }

  @override
  Future<String> updateAsync(FileEntity file) async {
    final Database db = await _dbHelper.database;
    final json = file.toJson();
    final result = await db.update(
      'files',
      json,
      where: 'id = ?',
      whereArgs: [file.id],
    );
    return result.toString();
  }

  @override
  Future<String> deleteAsync(String id) async {
    final Database db = await _dbHelper.database;
    final result = await db.delete(
      'files',
      where: 'id = ?',
      whereArgs: [id],
    );
    return result.toString();
  }

  List<String> get _columns => [
    'id',
    'file_name',
    'file_path',
    'file_size',
    'content_hash',
    'mime_type',
    'created_at',
    'modified_at',
    'discovered_at',
    'status',
    'mega_temp_path',
    'permanent_path',
    'error_message',
    'retry_count',
    'last_attempt_at',
    'device_id',
    'user_id',
    'thumbnails',
  ];

  FileEntity _mapFileEntity(Map<String, dynamic> map) {
    return FileEntity(
      id: map['id'] as String,
      fileName: map['file_name'] as String,
      filePath: map['file_path'] as String,
      fileSize: (map['file_size'] as num).toDouble(),
      contentHash: map['content_hash'] as String,
      mimeType: map['mime_type'] as String,
      createdAt: DateTime.parse(map['created_at'] as String),
      modifiedAt: DateTime.parse(map['modified_at'] as String),
      discoveredAt: DateTime.parse(map['discovered_at'] as String),
      status: UploadStatus.values
          .firstWhere((e) => e.toString() == 'UploadStatus.${map['status']}',
              orElse: () => UploadStatus.pending),
      megaTempPath: map['mega_temp_path'] as String?,
      permanentPath: map['permanent_path'] as String?,
      errorMessage: map['error_message'] as String?,
      retryCount: (map['retry_count'] as int?) ?? 0,
      lastAttemptAt: map['last_attempt_at'] != null
          ? DateTime.parse(map['last_attempt_at'] as String)
          : null,
      deviceId: map['device_id'] as String,
      userId: map['user_id'] as String,
      thumbnails: Map<String, String>.from(
        Map<String, dynamic>.from(map['thumbnails'] ?? {}),
      ),
      convertedFormat: map['converted_format'] as String?,
      isDeduplicated: map['is_deduplicated'] as bool? ?? false,
    );
  }
}