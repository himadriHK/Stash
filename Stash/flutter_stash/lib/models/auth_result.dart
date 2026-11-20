class AuthResult {
  final bool isSuccess;
  final String? error;
  final String? accessToken;
  final String? refreshToken;
  final String? userId;
  final String? deviceId;

  AuthResult({
    required this.isSuccess,
    this.error,
    this.accessToken,
    this.refreshToken,
    this.userId,
    this.deviceId,
  });

  AuthResult.success()
      : isSuccess = true,
        error = null,
        accessToken = null,
        refreshToken = null,
        userId = null,
        deviceId = null;

  AuthResult.failure([String? error])
      : isSuccess = false,
        error = error,
        accessToken = null,
        refreshToken = null,
        userId = null,
        deviceId = null;

  factory AuthResult.fromJson(Map<String, dynamic> json) {
    return AuthResult(
      isSuccess: json['isSuccess'] as bool? ?? false,
      error: json['error'] as String?,
      accessToken: json['accessToken'] as String?,
      refreshToken: json['refreshToken'] as String?,
      userId: json['userId'] as String?,
      deviceId: json['deviceId'] as String?,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'isSuccess': isSuccess,
      'error': error,
      'accessToken': accessToken,
      'refreshToken': refreshToken,
      'userId': userId,
      'deviceId': deviceId,
    };
  }
}