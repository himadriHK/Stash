import 'dart:async';
import 'dart:io';

import '../models/file_entity.dart';
import '../models/upload_status.dart';
import '../repositories/file_repository.dart';
import 'upload_result.dart';
import '../services/mega_http_service.dart';
import '../providers/app_config.dart';
import '../providers/auth_provider.dart';

class UploadManager {
  final IFileRepository _fileRepository;
  final MegaHttpService _megaService;
  final AppConfig _appConfig;
  final AuthProvider _authProvider;

  UploadManager(
    this._fileRepository,
    this._megaService,
    this._appConfig,
    this._authProvider,
  );

  /// Upload a single file with full status tracking
  Future<UploadResult> uploadFileAsync(FileEntity file) async {
    // Check if file exists locally
    if (!await File(file.filePath).exists()) {
      return UploadResult(
        fileId: file.id,
        success: false,
        megaTempPath: buildMegaTempPath(file),
        errorMessage: 'Local file not found: ${file.filePath}',
      );
    }

    // Check file size limit
    final fileSize = await File(file.filePath).length();
    if (_appConfig.maxFileSizeBytes > 0 && fileSize > _appConfig.maxFileSizeBytes) {
      return UploadResult(
        fileId: file.id,
        success: false,
        megaTempPath: buildMegaTempPath(file),
        errorMessage: 'File size ${fileSize} exceeds limit of ${_appConfig.maxFileSizeBytes} bytes',
      );
    }

    try {
      final accessToken = await _authProvider.accessToken;
      if (accessToken == null || accessToken.isEmpty) {
        return UploadResult(
          fileId: file.id,
          success: false,
          megaTempPath: buildMegaTempPath(file),
          errorMessage: 'No authenticated access token available',
        );
      }

      final result = await _megaService.uploadFile(
            filePath: file.filePath,
            remotePath: buildMegaTempPath(file),
          ) ??
          UploadResult(
            fileId: file.id,
            success: false,
            megaTempPath: buildMegaTempPath(file),
            errorMessage: 'No response from Mega service',
          );

      if (result.success) {
        // Update file status to uploaded using copyWith
        final updatedFile = file.copyWith(
          status: UploadStatus.uploaded,
          permanentPath: result.megaTempPath,
          errorMessage: null,
          retryCount: 0,
        );
        await _fileRepository.updateAsync(updatedFile);

        return UploadResult(
          fileId: file.id,
          success: true,
          megaTempPath: result.megaTempPath,
          errorMessage: null,
        );
      } else {
        // Increment retry count using copyWith
        final updatedFile = file.copyWith(
          retryCount: file.retryCount + 1,
          lastAttemptAt: DateTime.now(),
        );
        if (updatedFile.retryCount >= _appConfig.maxRetries) {
          final retryUpdatedFile = updatedFile.copyWith(status: UploadStatus.failed, errorMessage: result.errorMessage);
          await _fileRepository.updateAsync(retryUpdatedFile);
          return UploadResult(
            fileId: file.id,
            success: false,
            megaTempPath: result.megaTempPath,
            errorMessage: result.errorMessage,
          );
        } else {
          final retryUpdatedFile = updatedFile.copyWith(status: UploadStatus.retrying);
          await _fileRepository.updateAsync(retryUpdatedFile);
          return UploadResult(
            fileId: file.id,
            success: false,
            megaTempPath: result.megaTempPath,
            errorMessage: result.errorMessage,
          );
        }
      }
    } catch (e) {
      // Increment retry count using copyWith
      final updatedFile = file.copyWith(
        retryCount: file.retryCount + 1,
        lastAttemptAt: DateTime.now(),
      );
      await _fileRepository.updateAsync(updatedFile);

      return UploadResult(
        fileId: file.id,
        success: false,
        megaTempPath: buildMegaTempPath(file),
        errorMessage: 'Upload error: $e',
      );
    }
  }

  /// Upload batch of files with progress tracking
  Future<UploadBatchResult> uploadBatchAsync(Iterable<FileEntity> files) async {
    final fileList = files.toList();
    if (fileList.isEmpty) {
      return UploadBatchResult(
        results: [],
        batchSize: _appConfig.batchSize,
        batchCount: 0,
        totalCount: 0,
        successCount: 0,
        failureCount: 0,
        allSucceeded: true,
      );
    }

    final results = <UploadResult>[];
    var successCount = 0;
    var failureCount = 0;

    // Process each file (could be batched for concurrency)
    for (final file in fileList) {
      final result = await uploadFileAsync(file);
      results.add(result);

      if (result.success) {
        successCount++;
      } else {
        failureCount++;
      }
    }

    return UploadBatchResult(
      results: results,
      batchSize: _appConfig.batchSize,
      batchCount: (fileList.length / _appConfig.batchSize).ceil(),
      totalCount: results.length,
      successCount: successCount,
      failureCount: failureCount,
      allSucceeded: failureCount == 0,
    );
  }

  /// Build Mega temporary path for a file
  String buildMegaTempPath(FileEntity file) {
    return '/temp/uploads/${file.deviceId}/${file.fileName}';
  }
}

class UploadBatchResult {
  final List<UploadResult> results;
  final int batchSize;
  final int batchCount;
  final int totalCount;
  final int successCount;
  final int failureCount;
  final bool allSucceeded;

  UploadBatchResult({
    required this.results,
    required this.batchSize,
    required this.batchCount,
    required this.totalCount,
    required this.successCount,
    required this.failureCount,
    required this.allSucceeded,
  });
}