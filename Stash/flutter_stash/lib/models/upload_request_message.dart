import 'package:uuid/uuid.dart';

class UploadRequestMessage {
  final String fileId; // content hash
  final String fileName;
  final int fileSize;
  final String mimeType;
  final String megaTempPath;
  final String deviceId;
  final String userId;
  final String correlationId;
  final FileMetadata metadata;
  final Map<String, String> headers;

  UploadRequestMessage({
    required this.fileId,
    required this.fileName,
    required this.fileSize,
    required this.mimeType,
    required this.megaTempPath,
    required this.deviceId,
    required this.userId,
    String? correlationId,
    required this.metadata,
    Map<String, String>? headers,
  })  : correlationId = correlationId ?? const Uuid().v4().toString(),
        headers = headers ?? {};

  Map<String, dynamic> toJson() {
    return {
      'fileId': fileId,
      'fileName': fileName,
      'fileSize': fileSize,
      'mimeType': mimeType,
      'megaTempPath': megaTempPath,
      'deviceId': deviceId,
      'userId': userId,
      'correlationId': correlationId,
      'metadata': metadata.toJson(),
      'headers': headers,
    };
  }

  static UploadRequestMessage fromJson(Map<String, dynamic> json) {
    return UploadRequestMessage(
      fileId: json['fileId'] as String? ?? '',
      fileName: json['fileName'] as String? ?? '',
      fileSize: json['fileSize'] as int? ?? 0,
      mimeType: json['mimeType'] as String? ?? '',
      megaTempPath: json['megaTempPath'] as String? ?? '',
      deviceId: json['deviceId'] as String? ?? '',
      userId: json['userId'] as String? ?? '',
      correlationId: json['correlationId'] as String?,
      metadata: FileMetadata.fromJson(json['metadata'] as Map<String, dynamic>),
      headers: Map<String, String>.from(
        Map<String, dynamic>.from(json['headers'] ?? {}),
      ),
    );
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    if (other is! UploadRequestMessage) return false;
    return other.fileId == fileId &&
        other.fileName == fileName &&
        other.fileSize == fileSize &&
        other.mimeType == mimeType &&
        other.megaTempPath == megaTempPath &&
        other.deviceId == deviceId &&
        other.userId == userId &&
        other.correlationId == correlationId &&
        other.metadata == metadata &&
        _mapsEqual(other.headers, headers);
  }

  _mapsEqual(Map<String, String> other, Map<String, String> thisMap) {
    if (headers.length != other.length) return false;
    for (final key in headers.keys) {
      if (!other.containsKey(key) || other[key] != headers[key]) return false;
    }
    return true;
  }

  @override
  int get hashCode {
    return Object.hashAll([
      fileId,
      fileName,
      fileSize,
      mimeType,
      megaTempPath,
      deviceId,
      userId,
      correlationId,
      metadata,
      headers,
    ]);
  }

  @override
  bool get stringify => true;
}

class FileMetadata {
  final DateTime createdAt;
  final DateTime modifiedAt;

  FileMetadata({
    required this.createdAt,
    required this.modifiedAt,
  });

  Map<String, dynamic> toJson() {
    return {
      'createdAt': createdAt.toIso8601String(),
      'modifiedAt': modifiedAt.toIso8601String(),
    };
  }

  static FileMetadata fromJson(Map<String, dynamic> json) {
    return FileMetadata(
      createdAt: DateTime.parse(json['createdAt'] as String),
      modifiedAt: DateTime.parse(json['modifiedAt'] as String),
    );
  }
}