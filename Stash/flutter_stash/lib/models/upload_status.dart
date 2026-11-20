import 'package:flutter/material.dart';

enum UploadStatus {
  pending,
  scanning,
  hashing,
  uploading,
  uploaded,
  processing,
  completed,
  failed,
  retrying,
  deduplicated;

  String get displayName {
    switch (this) {
      case UploadStatus.pending:
        return 'Pending';
      case UploadStatus.scanning:
        return 'Scanning';
      case UploadStatus.hashing:
        return 'Hashing';
      case UploadStatus.uploading:
        return 'Uploading';
      case UploadStatus.uploaded:
        return 'Uploaded';
      case UploadStatus.processing:
        return 'Processing';
      case UploadStatus.completed:
        return 'Completed';
      case UploadStatus.failed:
        return 'Failed';
      case UploadStatus.retrying:
        return 'Retrying';
      case UploadStatus.deduplicated:
        return 'Deduplicated';
    }
  }

  Color get statusColor {
    switch (this) {
      case UploadStatus.pending:
        return Colors.grey;
      case UploadStatus.scanning:
        return Colors.blue;
      case UploadStatus.hashing:
        return Colors.orange;
      case UploadStatus.uploading:
        return Colors.purple;
      case UploadStatus.uploaded:
        return Colors.green;
      case UploadStatus.processing:
        return Colors.indigo;
      case UploadStatus.completed:
        return Colors.teal;
      case UploadStatus.failed:
        return Colors.red;
      case UploadStatus.retrying:
        return Colors.orange;
      case UploadStatus.deduplicated:
        return Colors.grey;
    }
  }
}