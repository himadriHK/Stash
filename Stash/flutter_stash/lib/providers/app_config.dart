import 'package:flutter/foundation.dart';

class AppConfig extends ChangeNotifier {
  bool _isDarkMode = false;
  final _listeners = <Function>[];
  
  // Configuration fields
  late final String _restUrl;
  late final String _kafkaBootstrapServers;
  late final String _kafkaUsername;
  late final String _kafkaPassword;
  late final String _kafkaTopicUploadRequest;
  late final String _kafkaTopicUploadResponse;
  late final String _kafkaTopicDeadLetter;
  late final String _restUsername;
  late final String _restPassword;
  late final String _identityApiBaseUrl;
  late final int _identityApiTimeoutSeconds;
  late final int _batchSize;
  late final int _maxRetries;
  late final int _maxFileSizeBytes;
  late final int _intervalMinutes;
  late final int _maxFilesPerRun;

  AppConfig() {
    _restUrl = '';
    _kafkaBootstrapServers = '';
    _kafkaTopicUploadRequest = '';
    _kafkaTopicUploadResponse = '';
    _kafkaTopicDeadLetter = '';
    _restUsername = '';
    _restPassword = '';
    _identityApiBaseUrl = 'http://localhost:5000/api';
    _identityApiTimeoutSeconds = 30;
    _batchSize = 10;
    _maxRetries = 3;
    _maxFileSizeBytes = 524288000;
    _intervalMinutes = 15;
    _maxFilesPerRun = 50;
  }

  String get restUrl => _restUrl;
  String get kafkaBootstrapServers => _kafkaBootstrapServers;
  String get kafkaUsername => _kafkaUsername;
  String get kafkaPassword => _kafkaPassword;
  String get restUsername => _restUsername;
  String get restPassword => _restPassword;
  String get identityApiBaseUrl => _identityApiBaseUrl;
  int get identityApiTimeoutSeconds => _identityApiTimeoutSeconds;
  int get batchSize => _batchSize;
  int get maxRetries => _maxRetries;
  int get maxFileSizeBytes => _maxFileSizeBytes;
  int get intervalMinutes => _intervalMinutes;
  int get maxFilesPerRun => _maxFilesPerRun;
  String get kafkaTopicUploadRequest => _kafkaTopicUploadRequest;
  String get kafkaTopicUploadResponse => _kafkaTopicUploadResponse;
  String get kafkaTopicDeadLetter => _kafkaTopicDeadLetter;
  bool get isDarkMode => _isDarkMode;
  
  set isDarkMode(bool value) {
    _isDarkMode = value;
    notifyListeners();
  }
  
  void addListener(Function listener) {
    _listeners.add(listener);
  }
  
  void removeListener(Function listener) {
    _listeners.remove(listener);
  }
  
  void notifyListeners() {
    for (final listener in _listeners) {
      listener();
    }
  }
  
  Future<void> load() async {
    // Load config from local storage
    // In a real app, this would read from shared preferences or similar
    await Future<void>.delayed(const Duration(milliseconds: 100));
  }
}