import 'package:uuid/uuid.dart';

class UploadResponseMessage {
  final String fileId; // content hash
  final String status; // 'COMPLETED' or 'FAILED'
  final String? permanentPath;
  final Map<String, String>? thumbnails;
  final String? convertedFormat;
  final bool? deduplicated;
  final String? error;
  final String messageId;
  final String correlationId;

  UploadResponseMessage({
    required this.fileId,
    required this.status,
    this.permanentPath,
    this.thumbnails,
    this.convertedFormat,
    this.deduplicated,
    this.error,
    String? messageId,
    required this.correlationId,
  }) : messageId = messageId ?? const Uuid().v4().toString();

  Map<String, dynamic> toJson() {
    return {
      'fileId': fileId,
      'status': status,
      'permanentPath': permanentPath,
      'thumbnails': thumbnails,
      'convertedFormat': convertedFormat,
      'deduplicated': deduplicated,
      'error': error,
      'messageId': messageId,
      'correlationId': correlationId,
    };
  }

  static UploadResponseMessage fromJson(Map<String, dynamic> json) {
    return UploadResponseMessage(
      fileId: json['fileId'] as String? ?? '',
      status: json['status'] as String? ?? '',
      permanentPath: json['permanentPath'] as String?,
      thumbnails: json['thumbnails'] != null
          ? Map<String, String>.from(json['thumbnails'] as Map<String, dynamic>)
          : null,
      convertedFormat: json['convertedFormat'] as String?,
      deduplicated: json['deduplicated'] as bool?,
      error: json['error'] as String?,
      messageId: json['messageId'] as String?,
      correlationId: json['correlationId'] as String? ?? '',
    );
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    if (other is! UploadResponseMessage) return false;
    return other.fileId == fileId &&
        other.status == status &&
        other.permanentPath == permanentPath &&
        _mapsEqual(other.thumbnails, thumbnails) &&
        other.convertedFormat == convertedFormat &&
        other.deduplicated == deduplicated &&
        other.error == error &&
        other.messageId == messageId &&
        other.correlationId == correlationId;
  }

  bool _mapsEqual(Map<String, String>? other, Map<String, String>? thisMap) {
    if (other == null && thisMap == null) return true;
    if (other == null || thisMap == null) return false;
    if (other.length != thisMap.length) return false;
    for (final key in thisMap.keys) {
      if (!other.containsKey(key) || other[key] != thisMap[key]) return false;
    }
    return true;
  }

  @override
  int get hashCode {
    return Object.hashAll([
      fileId,
      status,
      permanentPath,
      thumbnails,
      convertedFormat,
      deduplicated,
      error,
      messageId,
      correlationId,
    ]);
  }
}