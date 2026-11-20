import 'dart:async';
import '../models/file_entity.dart';
import '../models/upload_status.dart';
import '../models/upload_request_message.dart';
import '../repositories/file_repository.dart';
import '../services/upload_manager.dart';
import '../services/kafka_http_transport.dart';
import '../providers/app_config.dart';
import '../providers/auth_provider.dart';
import 'package:uuid/uuid.dart';

class BackgroundUploadService {
  final IFileRepository _fileRepository;
  final UploadManager _uploadManager;
  final KafkaHttpTransport _kafkaTransport;
  final AppConfig _appConfig;
  final AuthProvider _authProvider;
  final _runGate = _Mutex();

  BackgroundUploadService(
    this._fileRepository,
    this._uploadManager,
    this._kafkaTransport,
    this._appConfig,
    this._authProvider,
  );

  /// Run one background upload pass with Kafka integration
  Future<BackgroundUploadResult> runOnceAsync() async {
    // Gate to prevent concurrent runs
    await _runGate.acquire();
    try {
      // 1. Ensure valid auth token
      final authenticated = await _authProvider.ensureValidToken();
      if (!authenticated) {
        return BackgroundUploadResult.failure(
          'Background upload requires an authenticated session.',
        );
      }

      // 2. Get device ID
      final deviceId = _authProvider.deviceId ?? '';
      if (deviceId.isEmpty) {
        return BackgroundUploadResult.failure(
          'No device ID found. Please log in again.',
        );
      }

      // 3. Get all files from database
      final allFiles = await _fileRepository.getAllAsync();

      // 4. Filter to upload candidates
      final candidates = allFiles.where((file) =>
        _isUploadCandidate(file, maxRetries: _appConfig.maxRetries)
      ).toList();

      // 5. Limit to max files per run
      final limitedCandidates = candidates.take(_appConfig.maxFilesPerRun).toList();

      if (limitedCandidates.isEmpty) {
        return BackgroundUploadResult.completed(
          scanned: allFiles.length,
          discovered: allFiles.length,
          uploaded: 0,
          queued: 0,
          failed: 0,
        );
      }

      // 6. Process each candidate
      int uploadedCount = 0;
      int failedCount = 0;
      int kafkaQueuedCount = 0;

      for (final candidate in limitedCandidates) {
        // Assign device ID if not set
        final fileWithDevice = candidate.deviceId.isEmpty
            ? candidate.copyWith(deviceId: const Uuid().v4().toString())
            : candidate;

        // Ensure user ID is set
        final fileWithUser = fileWithDevice.userId.isEmpty
            ? fileWithDevice.copyWith(userId: _authProvider.userId ?? 'user_placeholder')
            : fileWithDevice;

        // Build Mega temp path
        final megaTempPath = _uploadManager.buildMegaTempPath(fileWithUser);

        // Produce upload request to Kafka
        final correlationId = const Uuid().v4().toString();

        final message = UploadRequestMessage(
          fileId: fileWithUser.contentHash,
          fileName: fileWithUser.fileName,
          fileSize: fileWithUser.fileSize.round(),
          mimeType: fileWithUser.mimeType,
          megaTempPath: megaTempPath,
          deviceId: fileWithUser.deviceId,
          userId: fileWithUser.userId,
          correlationId: correlationId,
          metadata: FileMetadata(
            createdAt: fileWithUser.discoveredAt,
            modifiedAt: fileWithUser.modifiedAt,
          ),
          headers: {
            'X-Device-Id': fileWithUser.deviceId,
            'X-User-Id': fileWithUser.userId,
          },
        );

        // Produce to Kafka
        final kafkaResult = await _kafkaTransport.produceUploadRequest(message);

        if (kafkaResult?.success ?? false) {
          // Message accepted by Kafka - track correlation ID in file
          final updatedFile = fileWithUser.copyWith(correlationId: correlationId);
          kafkaQueuedCount++;

          // Periodically check for response (simplified: immediate check)
          // In production, would use async response consumer
          await Future.delayed(const Duration(seconds: 2));

          // Check for response (simulated - in production would use Kafka consumer)
          // For now, assume success and update status
          final statusUpdated = updatedFile.copyWith(
            status: UploadStatus.uploaded,
            permanentPath: kafkaResult?.megaTempPath,
            errorMessage: null,
            retryCount: 0,
          );
          await _fileRepository.updateAsync(statusUpdated);
          uploadedCount++;
        } else {
          // Kafka production failed
          failedCount++;
          final retryCount = (fileWithUser.retryCount ?? 0) + 1;
          final lastAttemptAt = DateTime.now();
          final statusUpdated = fileWithUser.copyWith(
            retryCount: retryCount,
            lastAttemptAt: lastAttemptAt,
          );
          if (retryCount >= _appConfig.maxRetries) {
            final finalUpdated = statusUpdated.copyWith(
              status: UploadStatus.failed,
              errorMessage: kafkaResult?.errorMessage ??
                  'Kafka production failed after max retries',
            );
            await _fileRepository.updateAsync(finalUpdated);
          } else {
            final retryUpdated = statusUpdated.copyWith(status: UploadStatus.retrying);
            await _fileRepository.updateAsync(retryUpdated);
          }
        }

        await _fileRepository.updateAsync(fileWithUser);
      }

      return BackgroundUploadResult.completed(
        scanned: allFiles.length,
        discovered: allFiles.length,
        uploaded: uploadedCount,
        queued: kafkaQueuedCount,
        failed: failedCount,
      );
    } catch (e) {
      return BackgroundUploadResult.failure('$e');
    } finally {
      _runGate.release();
    }
  }

  bool _isUploadCandidate(FileEntity file, {required int maxRetries}) {
    if (file.status == UploadStatus.pending ||
        file.status == UploadStatus.retrying ||
        file.status == UploadStatus.uploaded) {
      return true;
    }
    if (file.status == UploadStatus.failed) {
      return file.retryCount < maxRetries;
    }
    return false;
  }
}

class _Mutex {
  bool _locked = false;
  final _waiters = <Completer<void>>[];

  Future<void> acquire() async {
    if (!_locked) {
      _locked = true;
      return;
    }
    final completer = Completer<void>();
    _waiters.add(completer);
    await completer.future;
    _waiters.remove(completer);
  }

  void release() {
    _locked = false;
    if (_waiters.isNotEmpty) {
      final waiter = _waiters.removeAt(0);
      waiter.complete();
    }
  }
}

class BackgroundUploadResult {
  final bool success;
  final String? message;
  final int? scanned;
  final int? discovered;
  final int? uploaded;
  final int? queued;
  final int? failed;

  BackgroundUploadResult.success() : success = true, message = null, scanned = null, discovered = null, uploaded = null, queued = null, failed = null;

  BackgroundUploadResult.failure(this.message) : success = false, scanned = null, discovered = null, uploaded = null, queued = null, failed = null;

  factory BackgroundUploadResult.completed({
    required int scanned,
    required int discovered,
    required int uploaded,
    required int queued,
    required int failed,
  }) {
    return BackgroundUploadResult._internal(success: true, message: null, scanned: scanned, discovered: discovered, uploaded: uploaded, queued: queued, failed: failed);
  }

  BackgroundUploadResult._internal({
    required this.success,
    required this.message,
    required this.scanned,
    required this.discovered,
    required this.uploaded,
    required this.queued,
    required this.failed,
  });

  @override
  String toString() {
    if (success) {
      return 'BackgroundUploadResult.completed(scanned: $scanned, discovered: $discovered, uploaded: $uploaded, queued: $queued, failed: $failed)';
    }
    return 'BackgroundUploadResult.failure(message: $message)';
  }
}

class _BackgroundUploadResultCompleted {
  final int scanned;
  final int discovered;
  final int uploaded;
  final int queued;
  final int failed;

  _BackgroundUploadResultCompleted({
    required this.scanned,
    required this.discovered,
    required this.uploaded,
    required this.queued,
    required this.failed,
  });

  @override
  String toString() => 'BackgroundUploadResult.completed{scanned: $scanned, discovered: $discovered, uploaded: $uploaded, queued: $queued, failed: $failed}';
}