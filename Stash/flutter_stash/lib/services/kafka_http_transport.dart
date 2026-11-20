import 'dart:async';

import 'package:dio/dio.dart';
import 'package:uuid/uuid.dart';

import '../models/upload_request_message.dart';
import '../models/upload_response_message.dart';
import '../services/upload_result.dart';
import '../providers/app_config.dart';
import '../providers/auth_provider.dart';

class KafkaHttpTransport {
  final Dio _dio;
  final AppConfig _appConfig;
  final AuthProvider _authProvider;

  KafkaHttpTransport(this._appConfig, this._authProvider)
      : _dio = Dio(BaseOptions(
          baseUrl: _appConfig.restUrl,
          connectTimeout: const Duration(seconds: 30),
          receiveTimeout: const Duration(seconds: 30),
        )) {
    _dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) async {
        // Add auth token
        final token = await _authProvider.accessToken;
        if (token != null && token.isNotEmpty) {
          options.headers['Authorization'] = 'Bearer $token';
        }

        // Add correlation ID (generate new one for each request)
        options.headers['X-Correlation-Id'] = const Uuid().v4().toString();

        // Add message version
        options.headers['X-Message-Version'] = '1';

        // Add device ID if available
        options.headers['X-Device-Id'] = _authProvider.deviceId ?? '';

        // Add user ID if available
        options.headers['X-User-Id'] = _authProvider.userId ?? '';

        handler.next(options);
      },
      onError: (DioException error, ErrorInterceptorHandler handler) {
        // debugPrint('Kafka HTTP Error: ${error.message}');
        handler.next(error);
      },
    ));
  }

  /// Produce an upload request message to Kafka
  Future<UploadResult?> produceUploadRequest(UploadRequestMessage message) async {
    try {
      final response = await _dio.post(
        '/kafka/${_appConfig.kafkaTopicUploadRequest}',
        data: message.toJson(),
        options: Options(
          headers: {
            'Authorization': _authProvider.accessToken ?? '',
            'Content-Type': 'application/json',
          },
        ),
      );

      if (response.statusCode == 200 || response.statusCode == 201) {
        // Success - message accepted by Kafka
        return UploadResult(
          fileId: message.fileId,
          success: true,
          megaTempPath: message.megaTempPath,
          errorMessage: null,
        );
      }

      // Kafka returned error response
      return UploadResult(
        fileId: message.fileId,
        success: false,
        megaTempPath: message.megaTempPath,
        errorMessage: response.data['error'] ?? 'Kafka request failed',
      );
    } on DioException catch (e) {
      return UploadResult(
        fileId: message.fileId,
        success: false,
        megaTempPath: message.megaTempPath,
        errorMessage: e.message ?? 'Dio error producing Kafka request',
      );
    } catch (e) {
      return UploadResult(
        fileId: message.fileId,
        success: false,
        megaTempPath: message.megaTempPath,
        errorMessage: 'Unexpected error: $e',
      );
    }
  }

  /// Consume upload response messages from Kafka (polling-based)
  Stream<UploadResponseMessage> consumeUploadResponses({
    required Function(UploadResponseMessage) onRecord,
  }) async* {
    while (true) {
      await Future.delayed(const Duration(seconds: 5));

      try {
        final response = await _dio.get(
          '/kafka/${_appConfig.kafkaTopicUploadResponse}',
          options: Options(
            headers: {
              'Authorization': _authProvider.accessToken ?? '',
            },
          ),
        );

        if (response.statusCode == 200 && response.data != null) {
          // Parse the response - could be a single message or list
          final List<dynamic> messagesData = (response.data is List)
              ? response.data
              : (response.data['messages'] as List? ?? []);

          for (final messageData in messagesData) {
            final message = UploadResponseMessage.fromJson(messageData);
            onRecord(message);
            yield message;
          }
        }
      } catch (e) {
        // Log error but continue streaming
        // debugPrint('Kafka consume error: $e');
      }
    }
  }

  /// Produce a dead letter queue entry for failed uploads
  Future<void> produceDeadLetter({
    required String key, // file content hash
    required String payload, // JSON string of failure details
    required String reason, // Human-readable reason
  }) async {
    try {
      await _dio.post(
        '/kafka/${_appConfig.kafkaTopicDeadLetter}',
        data: {
          'key': key,
          'payload': payload,
          'reason': reason,
        },
        options: Options(
          headers: {
            'Authorization': _authProvider.accessToken ?? '',
            'x-dlq-reason': reason,
            'Content-Type': 'application/json',
          },
        ),
      );
    } catch (e) {
      // debugPrint('DLQ production error: $e');
      // Don't throw - DLQ failure should not block main flow
    }
  }
}