import 'dart:io';

import 'package:dio/dio.dart';

import '../models/upload_result.dart';
import '../providers/app_config.dart';
import '../providers/auth_provider.dart';

class MegaHttpService {
  final Dio _dio;
  final AppConfig _appConfig;
  final AuthProvider _authProvider;

  MegaHttpService(this._appConfig, this._authProvider)
      : _dio = Dio(BaseOptions(
          baseUrl: _appConfig.restUrl,
          connectTimeout: const Duration(seconds: 30),
          receiveTimeout: const Duration(seconds: 30),
        )) {
    _dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) async {
        // Add auth token if available
        final token = await _authProvider.accessToken;
        if (token != null && token.isNotEmpty) {
          options.headers['Authorization'] = 'Bearer $token';
        }
        // Add common headers
        options.headers['X-Message-Version'] = '1';
        options.headers['Content-Type'] = 'application/json';
        handler.next(options);
      },
      onError: (DioException error, handler) {
        // Log errors for debugging
        // debugPrint('Mega HTTP Error: ${error.message}');
        handler.next(error);
      },
    ));
  }

  /// Upload a file to Mega.io
  Future<UploadResult?> uploadFile({
    required String filePath,
    required String remotePath,
  }) async {
    try {
      final file = File(filePath);
      if (!await file.exists()) {
        return null;
      }

      final fileName = remotePath.split('/').last;
      final fileSize = await file.length();

      // Multipart form data upload
      final formData = FormData.fromMap({
        'file': await MultipartFile.fromFile(filePath, filename: fileName),
        'path': remotePath,
        'size': fileSize,
      });

      final response = await _dio.post(
        '/api/mega/upload',
        data: formData,
        options: Options(
          headers: {
            'Authorization': 'Bearer ???', // Will be filled by interceptor
            'Content-Type': 'multipart/form-data',
          },
        ),
      );

      if (response.statusCode == 200 || response.statusCode == 201) {
        final data = response.data;
        return UploadResult(
          fileId: data['contentHash'] ?? '',
          success: true,
          megaTempPath: remotePath,
          errorMessage: null,
        );
      }

      return UploadResult(
        fileId: '',
        success: false,
        megaTempPath: remotePath,
        errorMessage: response.data['error'] ?? 'Upload failed',
      );
    } on DioException catch (e) {
      return UploadResult(
        fileId: '',
        success: false,
        megaTempPath: remotePath,
        errorMessage: e.message ?? 'Dio error during upload',
      );
    } catch (e) {
      return UploadResult(
        fileId: '',
        success: false,
        megaTempPath: remotePath,
        errorMessage: 'Unexpected error: $e',
      );
    }
  }

  /// Download a file from Mega.io
  Future<DownloadResult?> downloadFile({
    required String remotePath,
    required String destinationPath,
  }) async {
    try {
      final response = await _dio.get(
        '/api/mega/download/$remotePath',
        options: Options(
          responseType: ResponseType.bytes,
        ),
      );

      if (response.statusCode == 200) {
        final bytes = response.data;
        await File(destinationPath).writeAsBytes(bytes);
        return DownloadResult(
          success: true,
          fileSize: bytes.length,
        );
      }

      return DownloadResult(
        success: false,
        error: 'Download failed with status ${response.statusCode}',
      );
    } on DioException catch (e) {
      return DownloadResult(
        success: false,
        error: e.message ?? 'Dio error during download',
      );
    } catch (e) {
      return DownloadResult(
        success: false,
        error: 'Unexpected error: $e',
      );
    }
  }

  /// Check if file exists in Mega.io
  Future<bool> fileExists({
    required String remotePath,
  }) async {
    try {
      final response = await _dio.head(
        '/api/mega/$remotePath',
      );
      return response.statusCode == 200;
    } on DioException {
      return false;
    }
  }
}

class DownloadResult {
  final bool success;
  final int? fileSize;
  final String? error;

  DownloadResult({
    required this.success,
    this.fileSize,
    this.error,
  });
}