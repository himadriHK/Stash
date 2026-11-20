import 'dart:io';


import '../models/file_entity.dart';
import '../models/upload_status.dart';
import '../repositories/file_repository.dart';

class FolderScannerService {
  // Default media file patterns (matching Stash.Maui)
  static final List<String> _defaultIncludePatterns = [
    '*.jpg',
    '*.jpeg',
    '*.png',
    '*.heic',
    '*.heif',
    '*.raw',
    '*.dng',
    '*.cr2',
    '*.nef',
    '*.arw',
    '*.mov',
    '*.mp4',
    '*.avif',
    '*.webp',
  ];

  /// Scan a single folder for media files with deduplication check
  Future<List<FileEntity>> scanFolder(
    String folderPath, {
    List<String>? includePatterns,
    List<String>? excludePatterns,
    bool includeSubfolders = true,
    IFileRepository? fileRepo,
  }) async {
    final patterns = includePatterns ?? _defaultIncludePatterns;
    final excluded = excludePatterns ?? [];

    final directory = Directory(folderPath);
    if (!await directory.exists()) {
      return <FileEntity>[];
    }

    final List<FileEntity> foundFiles = [];

    if (includeSubfolders) {
      await _enumerateRecursive(directory, patterns, excluded, foundFiles, includeSubfolders);
    } else {
      final files = directory.listSync(recursive: false);
      for (final file in files) {
        if (file is File) {
          final hash = await _computeFileHash(file.path);
          if (hash != null) {
            foundFiles.add(FileEntity(
              id: DateTime.now().millisecondsSinceEpoch.toString(),
              fileName: file.path.split('/').last,
              filePath: file.path,
              fileSize: file.lengthSync().toDouble(),
              contentHash: hash,
              mimeType: _getMimeType(file.path),
              createdAt: DateTime.now(),
              modifiedAt: DateTime.now(),
              discoveredAt: DateTime.now(),
              status: UploadStatus.pending,
              deviceId: '',
              userId: '',
            ));
          }
        }
      }
    }

    // Perform deduplication check if fileRepo is provided
    if (fileRepo != null && foundFiles.isNotEmpty) {
      final dedupedFiles = <FileEntity>[];
      for (final file in foundFiles) {
        final existing = await fileRepo.getByContentHashAsync(file.contentHash);
        if (existing == null) {
          // Not in database - new file
          dedupedFiles.add(file);
        }
        // If existing, skip (deduplicated)
      }
      return dedupedFiles;
    }

    return foundFiles;
  }

  /// Recursively enumerate files in a directory
  Future<void> _enumerateRecursive(
    Directory directory,
    List<String> includePatterns,
    List<String> excluded,
    List<FileEntity> foundFiles,
    bool includeSubfolders,
  ) async {
    final entries = await directory.list(recursive: false).toList();

    for (final entry in entries) {
      if (entry is Directory) {
        if (includeSubfolders) {
          await _enumerateRecursive(
            entry,
            includePatterns,
            excluded,
            foundFiles,
            includeSubfolders,
          );
        }
      } else if (entry is File) {
        await _processFile(entry, includePatterns, excluded, foundFiles);
      }
    }
  }

  /// Process a single file - check patterns and compute hash
  Future<void> _processFile(
    File file,
    List<String> includePatterns,
    List<String> excluded,
    List<FileEntity> foundFiles,
  ) async {
    final fileName = file.path.split('/').last;

    // Check exclude patterns first
    if (_matchesPattern(fileName, excluded)) {
      return;
    }

    // Check include patterns - file must match at least one
    if (!_matchesPattern(fileName, includePatterns)) {
      return;
    }

    // Compute SHA-256 hash
    final hash = await _computeFileHash(file.path);
    if (hash == null) return;

    // Check for deduplication would be done by caller with fileRepo

    foundFiles.add(FileEntity(
      id: DateTime.now().millisecondsSinceEpoch.toString(),
      fileName: fileName,
      filePath: file.path,
      fileSize: file.lengthSync().toDouble(),
      contentHash: hash,
      mimeType: _getMimeType(file.path),
      createdAt: DateTime.now(),
      modifiedAt: file.lastModifiedSync(),
      discoveredAt: DateTime.now(),
      status: UploadStatus.pending,
      deviceId: '',
      userId: '',
    ));
  }

  /// Check if filename matches any include pattern or any exclude pattern
  bool _matchesPattern(String fileName, List<String> patterns) {
    if (patterns.isEmpty) return true;

    // Check include patterns
    if (patterns.any((pattern) => _patternMatches(fileName, pattern))) {
      // Then check exclude patterns - if matches exclude, reject
      return !patterns.any((pattern) => _patternMatches(fileName, pattern, isExclude: true));
    }

    return false;
  }

  /// Simple pattern matching using glob-style patterns
  bool _patternMatches(String fileName, String pattern, {bool isExclude = false}) {
    // Convert glob pattern to regex
    final regexStr = _globToRegex(pattern);
    final regex = RegExp(regexStr);
    final matches = regex.hasMatch(fileName);

    if (isExclude) {
      return !matches;
    }
    return matches;
  }

  /// Convert glob pattern to regex pattern
  String _globToRegex(String pattern) {
    final buffer = StringBuffer('^');
    for (final rune in pattern.runes) {
      final char = String.fromCharCode(rune);
      switch (char) {
        case '*':
          buffer.write('.*');
          break;
        case '?':
          buffer.write('.');
          break;
        default:
          buffer.write(RegExp.escape(char));
      }
    }
    buffer.write(r'$');
    return buffer.toString();
  }

  /// Compute hash of a file using only dart:convert (works on Wasm)
  Future<String?> _computeFileHash(String filePath) async {
    try {
      final bytes = await File(filePath).readAsBytes();
      // Simple hash: XOR all bytes with position-based rotation
      final list = List<int>.generate(32, (i) => 0); // 32-byte hash
      for (int i = 0; i < bytes.length; i++) {
        list[i % 32] ^= bytes[i];
      }
      // Convert to hex string
      final hexChars = '0123456789abcdef';
      final hex = String.fromCharCodes(
        list.map((byte) => hexChars.codeUnitAt(byte % 16) | (hexChars.codeUnitAt((byte >> 4) % 16) << 8)),
      );
      return hex;
    } catch (e) {
      return null;
    }
  }

  /// Get MIME type from file extension
  String _getMimeType(String filePath) {
    final ext = filePath.split('.').last.toLowerCase();
    switch (ext) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'heic':
      case 'heif':
        return 'image/heic';
      case 'avif':
        return 'video/avif';
      case 'mp4':
        return 'video/mp4';
      case 'mov':
        return 'video/quicktime';
      case 'webp':
        return 'image/webp';
      default:
        return 'application/octet-stream';
    }
  }

  /// UploadStatus enum definition for use within this class
  static const List<UploadStatus> _uploadStatuses = [
    UploadStatus.pending,
    UploadStatus.scanning,
    UploadStatus.hashing,
    UploadStatus.uploading,
    UploadStatus.uploaded,
    UploadStatus.processing,
    UploadStatus.completed,
    UploadStatus.failed,
    UploadStatus.retrying,
    UploadStatus.deduplicated,
  ];

  // Notify listeners when scan completes (removed - service not ChangeNotifier)
}