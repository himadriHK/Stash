import 'package:uuid/uuid.dart';
import 'package:flutter/foundation.dart';

class AuthProvider extends ChangeNotifier {
  bool _isBusy = false;
  String? _errorMessage;
  String? _accessToken;
  String? _deviceId;
  String? _userId;
  final _listeners = <Function>[];

  bool get isBusy => _isBusy;
  String? get errorMessage => _errorMessage;
  String? get accessToken => _accessToken;
  String? get deviceId => _deviceId;
  String? get userId => _userId;
  bool get isAuthenticated => _accessToken != null && _accessToken!.isNotEmpty;

  set errorMessage(String? value) {
    _errorMessage = value;
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

  Future<void> initialize() async {
    // Initialize auth state - in a real app, this would check local storage
    _isBusy = false;
  }

  Future<bool> ensureValidToken() async {
    if (_accessToken != null && _accessToken!.isNotEmpty) {
      return true;
    }
    return false;
  }

  Future<bool> login({required String email, required String password}) async {
    _isBusy = true;
    notifyListeners();
    try {
      // Simulate login - in a real app, this would make an API call
      _accessToken = 'dummy_access_token';
      _deviceId = const Uuid().v4().toString();
      _userId = 'user_123';
      _isBusy = false;
      notifyListeners();
      return true;
    } catch (e) {
      _errorMessage = 'Login failed: $e';
      _isBusy = false;
      notifyListeners();
      return false;
    }
  }

  Future<bool> register({
    required String email,
    required String password,
    required String confirmPassword,
  }) async {
    _isBusy = true;
    notifyListeners();
    try {
      if (password != confirmPassword) {
        _errorMessage = 'Passwords do not match';
        _isBusy = false;
        notifyListeners();
        return false;
      }
      // Simulate registration - in a real app, this would make an API call
      _accessToken = 'dummy_access_token';
      _deviceId = const Uuid().v4().toString();
      _userId = 'user_456';
      _isBusy = false;
      notifyListeners();
      return true;
    } catch (e) {
      _errorMessage = 'Registration failed: $e';
      _isBusy = false;
      notifyListeners();
      return false;
    }
  }

  Future<bool> logout() async {
    _isBusy = true;
    notifyListeners();
    try {
      _accessToken = null;
      _deviceId = null;
      _userId = null;
      _isBusy = false;
      notifyListeners();
      return true;
    } catch (e) {
      _errorMessage = 'Logout failed: $e';
      _isBusy = false;
      notifyListeners();
      return false;
    }
  }
}