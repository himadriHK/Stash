
class FolderConfig {
  final String id;
  final String folderPath;
  final String folderName;
  final bool isEnabled;
  final DateTime addedAt;
  final DateTime? lastScannedAt;
  final List<String> includePatterns;
  final List<String> excludePatterns;
  final bool includeSubfolders;

  FolderConfig({
    this.id = '',
    required this.folderPath,
    required this.folderName,
    this.isEnabled = true,
    DateTime? addedAt,
    this.lastScannedAt,
    List<String>? includePatterns,
    List<String>? excludePatterns,
    bool? includeSubfolders,
  })  : addedAt = addedAt ?? DateTime.now(),
        includePatterns = includePatterns ?? ['*.jpg', '*.jpeg', '*.png', '*.heic', '*.heif', '*.raw', '*.dng', '*.cr2', '*.nef', '*.arw', '*.mov', '*.mp4', '*.avif', '*.webp'],
        excludePatterns = excludePatterns ?? [],
        includeSubfolders = includeSubfolders ?? true;

  FolderConfig copyWith({
    String? id,
    String? folderPath,
    String? folderName,
    bool? isEnabled,
    DateTime? addedAt,
    DateTime? lastScannedAt,
    List<String>? includePatterns,
    List<String>? excludePatterns,
    bool? includeSubfolders,
  }) {
    return FolderConfig(
      id: id ?? this.id,
      folderPath: folderPath ?? this.folderPath,
      folderName: folderName ?? this.folderName,
      isEnabled: isEnabled ?? this.isEnabled,
      addedAt: addedAt ?? this.addedAt,
      lastScannedAt: lastScannedAt ?? this.lastScannedAt,
      includePatterns: includePatterns ?? this.includePatterns,
      excludePatterns: excludePatterns ?? this.excludePatterns,
      includeSubfolders: includeSubfolders ?? this.includeSubfolders,
    );
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    if (other is! FolderConfig) return false;
    return other.id == id &&
        other.folderPath == folderPath &&
        other.folderName == folderName &&
        other.isEnabled == isEnabled &&
        other.addedAt == addedAt &&
        other.lastScannedAt == lastScannedAt &&
        _listEquals(other.includePatterns) &&
        _listEquals(other.excludePatterns) &&
        other.includeSubfolders == includeSubfolders;
  }

  _listEquals(List<String> other) {
    if (includePatterns.length != other.length) return false;
    for (int i = 0; i < includePatterns.length; i++) {
      if (includePatterns[i] != other[i]) return false;
    }
    return true;
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'folder_path': folderPath,
      'folder_name': folderName,
      'is_enabled': isEnabled,
      'added_at': addedAt.toIso8601String(),
      'last_scanned_at': lastScannedAt?.toIso8601String(),
      'include_patterns': includePatterns,
      'exclude_patterns': excludePatterns,
      'include_subfolders': includeSubfolders,
    };
  }
}