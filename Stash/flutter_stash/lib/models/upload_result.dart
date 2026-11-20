class UploadResult {
  final String fileId;
  final bool success;
  final String megaTempPath;
  final String? errorMessage;

  UploadResult({
    required this.fileId,
    required this.success,
    required this.megaTempPath,
    this.errorMessage,
  });
}