import '../models/upload_status.dart';

class FileEntity {
  final String id;
  final String fileName;
  final String filePath;
  final double fileSize;
  final String contentHash;
  final String mimeType;
  final DateTime createdAt;
  final DateTime modifiedAt;
  final DateTime discoveredAt;
  final UploadStatus status;
  final String? megaTempPath;
  final String? permanentPath;
  final String? errorMessage;
  final int retryCount;
  final DateTime? lastAttemptAt;
  final String deviceId;
  final String userId;
  final Map<String, String> thumbnails;
  final String? convertedFormat;
  final bool isDeduplicated;
  final String? correlationId;

  FileEntity({
    this.id = '',
    required this.fileName,
    required this.filePath,
    required this.fileSize,
    required this.contentHash,
    required this.mimeType,
    required this.createdAt,
    required this.modifiedAt,
    required this.discoveredAt,
    required this.status,
    this.megaTempPath,
    this.permanentPath,
    this.errorMessage,
    this.retryCount = 0,
    this.lastAttemptAt,
    required this.deviceId,
    required this.userId,
    this.thumbnails = const {},
    this.convertedFormat,
    this.isDeduplicated = false,
    this.correlationId,
  });

  FileEntity copyWith({
    String? id,
    String? fileName,
    String? filePath,
    double? fileSize,
    String? contentHash,
    String? mimeType,
    DateTime? createdAt,
    DateTime? modifiedAt,
    DateTime? discoveredAt,
    UploadStatus? status,
    String? megaTempPath,
    String? permanentPath,
    String? errorMessage,
    int? retryCount,
    DateTime? lastAttemptAt,
    String? deviceId,
    String? userId,
    Map<String, String>? thumbnails,
    String? convertedFormat,
    bool? isDeduplicated,
    String? correlationId,
  }) {
    return FileEntity(
      id: id ?? this.id,
      fileName: fileName ?? this.fileName,
      filePath: filePath ?? this.filePath,
      fileSize: fileSize ?? this.fileSize,
      contentHash: contentHash ?? this.contentHash,
      mimeType: mimeType ?? this.mimeType,
      createdAt: createdAt ?? this.createdAt,
      modifiedAt: modifiedAt ?? this.modifiedAt,
      discoveredAt: discoveredAt ?? this.discoveredAt,
      status: status ?? this.status,
      megaTempPath: megaTempPath ?? this.megaTempPath,
      permanentPath: permanentPath ?? this.permanentPath,
      errorMessage: errorMessage ?? this.errorMessage,
      retryCount: retryCount ?? this.retryCount,
      lastAttemptAt: lastAttemptAt ?? this.lastAttemptAt,
      deviceId: deviceId ?? this.deviceId,
      userId: userId ?? this.userId,
      thumbnails: thumbnails ?? this.thumbnails,
      convertedFormat: convertedFormat ?? this.convertedFormat,
      isDeduplicated: isDeduplicated ?? this.isDeduplicated,
      correlationId: correlationId ?? this.correlationId,
    );
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    if (other is! FileEntity) return false;
    return other.id == id &&
        other.fileName == fileName &&
        other.filePath == filePath &&
        other.fileSize == fileSize &&
        other.contentHash == contentHash &&
        other.mimeType == mimeType &&
        other.createdAt == createdAt &&
        other.modifiedAt == modifiedAt &&
        other.discoveredAt == discoveredAt &&
        other.status == status &&
        other.megaTempPath == megaTempPath &&
        other.permanentPath == permanentPath &&
        other.errorMessage == errorMessage &&
        other.retryCount == retryCount &&
        other.lastAttemptAt == lastAttemptAt &&
        other.deviceId == deviceId &&
        other.userId == userId &&
        _thumbnailsEquals(other.thumbnails) &&
        other.convertedFormat == convertedFormat &&
        other.isDeduplicated == isDeduplicated;
  }

  _thumbnailsEquals(Map<String, String> other) {
    if (thumbnails.length != other.length) return false;
    for (final key in thumbnails.keys) {
      if (!other.containsKey(key) || other[key] != thumbnails[key]) return false;
    }
    return true;
  }

  @override
  int get hashCode {
    return Object.hashAll([
      id,
      fileName,
      filePath,
      fileSize,
      contentHash,
      mimeType,
      createdAt,
      modifiedAt,
      discoveredAt,
      status,
      megaTempPath,
      permanentPath,
      errorMessage,
      retryCount,
      lastAttemptAt,
      deviceId,
      userId,
      thumbnails,
      convertedFormat,
      isDeduplicated,
    ]);
  }

  @override
  bool get stringify => true;

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'file_name': fileName,
      'file_path': filePath,
      'file_size': fileSize,
      'content_hash': contentHash,
      'mime_type': mimeType,
      'created_at': createdAt.toIso8601String(),
      'modified_at': modifiedAt.toIso8601String(),
      'discovered_at': discoveredAt.toIso8601String(),
      'status': status.toString().split('.').last,
      'mega_temp_path': megaTempPath,
      'permanent_path': permanentPath,
      'error_message': errorMessage,
      'retry_count': retryCount,
      'last_attempt_at': lastAttemptAt?.toIso8601String(),
      'device_id': deviceId,
      'user_id': userId,
      'thumbnails': thumbnails,
      'converted_format': convertedFormat,
      'is_deduplicated': isDeduplicated,
    };
  }

  factory FileEntity.fromJson(Map<String, dynamic> json) {
    return FileEntity(
      id: json['id'] as String? ?? '',
      fileName: json['file_name'] as String? ?? '',
      filePath: json['file_path'] as String? ?? '',
      fileSize: (json['file_size'] as num?)?.toDouble() ?? 0.0,
      contentHash: json['content_hash'] as String? ?? '',
      mimeType: json['mime_type'] as String? ?? '',
      createdAt: DateTime.parse(json['created_at'] as String? ?? DateTime.now().toIso8601String()),
      modifiedAt: DateTime.parse(json['modified_at'] as String? ?? DateTime.now().toIso8601String()),
      discoveredAt: DateTime.parse(json['discovered_at'] as String? ?? DateTime.now().toIso8601String()),
      status: UploadStatus.values
          .firstWhere((e) => e.toString() == 'UploadStatus.${json['status']}',
              orElse: () => UploadStatus.pending),
      megaTempPath: json['mega_temp_path'] as String?,
      permanentPath: json['permanent_path'] as String?,
      errorMessage: json['error_message'] as String?,
      retryCount: json['retry_count'] as int? ?? 0,
      lastAttemptAt: json['last_attempt_at'] != null
          ? DateTime.parse(json['last_attempt_at'] as String)
          : null,
      deviceId: json['device_id'] as String? ?? '',
      userId: json['user_id'] as String? ?? '',
      thumbnails: Map<String, String>.from(
        Map<String, dynamic>.from(json['thumbnails'] ?? {}),
      ),
      convertedFormat: json['converted_format'] as String?,
      isDeduplicated: json['is_deduplicated'] as bool? ?? false,
    );
  }
}