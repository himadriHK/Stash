# FlutterStash - Running & Setup Guide

## 📋 Table of Contents
1. [Prerequisites](#prerequisites)
2. [Project Setup](#project-setup)
3. [Configuration](#configuration)
4. [Running the Application](#running-the-application)
5. [Platform-Specific Setup](#platform-specific-setup)
6. [Debug & Development](#debug--development)
7. [Build Modes](#build-modes)
8. [Known Issues](#known-issues)

---

## 1. Prerequisites

### Flutter SDK
- Flutter 3.16.0 or higher
- Dart 3.2.0 or higher
- Ensure `flutter` is in your PATH

### Operating System
- Windows 10/11 (development)
- macOS (for iOS development)
- Linux (optional, for web development)

### IDE
- VS Code or Android Studio recommended
- Flutter and Dart plugins enabled

### Admin Access
- Required for Android SDK/platform tools installation
- Required for Xcode installation (macOS)

---

## 2. Project Setup

### 2.1 Clone/Locate the Project
The FlutterStash project is located at:
```
D:\Projects\Stash\Stash\flutter_stash\
```

### 2.2 Install Dependencies
```bash
# Navigate to the project directory
cd D:\Projects\Stash\Stash\flutter_stash

# Get all dependencies listed in pubspec.yaml
flutter pub get
```

### 2.3 Verify Installation
```bash
flutter doctor
```
Expected: All checks green or with minor warnings that don't block development.

---

## 3. Configuration

### 3.1 App Configuration (`lib/providers/app_config.dart`)
The application uses an `AppConfig` provider with placeholder values. To configure for your backend:

```dart
// Update these values in app_config.dart or via environment variables:

// Kafka REST Proxy Configuration
final _restUrl = 'http://your-backend-host:8080';  // Your backend URL

// Mega.io Settings (from appsettings.json equivalent)
final megaEmail = 'your-mega-email@example.com';
final megaPassword = 'your-mega-password';

// Identity API Configuration
final identityApiBaseUrl = 'https://your-identity-api.com/api';
final identityApiTimeoutSeconds = 30;

// Upload Settings
final batchSize = 10;
final maxRetries = 3;
final maxFileSizeBytes = 524288000;  // 500MB

// Background Upload Settings
final intervalMinutes = 15;
final maxFilesPerRun = 50;

// Kafka Topics
final kafkaTopicUploadRequest = 'stash.upload.request';
final kafkaTopicUploadResponse = 'stash.upload.response';
final kafkaTopicDeadLetter = 'stash.dlq';
```

### 3.2 Environment Variables (Optional)
You can override config via environment variables at runtime:
```bash
# Windows Command Prompt
set FLUTTERSTASH_REST_URL=http://your-backend-host:8080
set FLUTTERSTASH_IDENTITY_API_BASE_URL=https://your-api.com

# Or use your IDE's environment variable features
```

### 3.3 Secure Storage Configuration
The first time the app runs, it will initialize the `AuthProvider` which uses `flutter_secure_storage`. On first run:
- iOS: Keychain will be automatically configured
- Android: Android Keystore will be used
- Web: IndexedDB will be used as fallback

---

## 3. Running the Application

### 3.1 Run on Android
```bash
flutter run -d android
```
Or from your IDE:
- Select an Android emulator or connect a physical Android device
- Click the "Run" button in VS Code or Android Studio

### 2 Run on iOS (macOS only)
```bash
flutter run -d ios
```
- Connect your iPhone via USB or select an iOS simulator
- Ensure Xcode is installed and configured

### 3 Run on Web
```bash
flutter run -d chrome
# Or
flutter run -d web
```
- The web version uses polling-based background checks instead of native schedulers
- Open `http://localhost:PORT` in your browser

### 4 Run All Platforms
```bash
flutter run
```
- Will prompt you to select a device or run on the default

---

## 4. Key Features to Test

### 4.1 Authentication Flow
1. Run the app
2. Click "Sign in" on LoginPage
3. Test with valid credentials (currently using placeholder mode)
4. Click "Create account" to register
5. Verify token persistence across app restarts

### 4.2 Local File Management
1. Navigate to "Folders" screen
2. Add a folder path (e.g., `/ Pictures` or a valid directory)
3. The scanner will discover media files
4. Verify files appear in the "Files" screen with status indicators
5. Test SHA-256 hashing for deduplication

### 4.3 Upload Functionality
1. Navigate to "Files" screen
2. Select a file and attempt upload
3. Monitor status transitions (Pending → Uploading → Uploaded/Failed)
4. Test retry logic if upload fails
5. Verify Mega temp path generation

### 4.3 Background Uploads
1. The app checks for background task support:
   - **Android**: workmanager periodic task (15 minutes)
   - **iOS**: background_fetch scheduler (15 minutes)
   - **Web**: setInterval polling (15 minutes)
2. Manual trigger can be done via the background service
3. Monitor console logs for background pass execution

---

## 5. Platform-Specific Setup

### 5.1 Android Configuration

#### AndroidManifest.xml
The project includes auto-generated AndroidManifest.xml. Key configurations:
- Internet permission: `<uses-permission android:name="android.permission.INTERNET"/>`
- Network security config: Configured for debug mode
- Workmanager initialization in MainActivity

#### Gradle Settings
Ensure `android/build.gradle` and `android/gradle/wrapper/gradle-wrapper.properties` are properly configured:
```groovy
dependencies {
    implementation 'androidx.core:core-ktx:1.13.0'
    implementation 'androidx.lifecycle:lifecycle-runtime-ktx:2.6.1'
    // ... other dependencies
}
```

#### Debug Configuration
For Android debug builds, configure `android/app/src/main/AndroidManifest.xml`:
```xml
<meta-data
    android:name="com.google.android.geo.api.context"
    android:value="true"/>
```

### 5.2 iOS Configuration (macOS only)

#### Info.plist
Ensure these keys are present in `ios/Runner/Info.plist`:
```xml
<key>UIBackgroundModes</key>
<array>
    <string>audio</string>
    <string>background-fetch</string>
    <string>processing</string>
    <string>external-audio</string>
</array>
```

#### Capabilities in Xcode
- Enable "Background Modes" in Xcode
- Check: Background fetch, Background processing, Audio, AirPlay

#### Provisioning
- Configure APNs certificates for background fetch
- Test on physical devices for background task execution

### 5.3 Web Configuration

#### Web Entry Point
The web app uses `web/index.html` as the entry point.
- Meta tags are configured in `web/manifest.json`
- Service worker considerations documented in `web/service-worker.js` (if present)

#### Web-Specific Behavior
- Background tasks use `setInterval` polling (15 minutes)
- Pauses when browser tab is hidden/backgrounded
- Uses IndexedDB for secure storage fallback
- CORS headers must be configured for Kafka REST proxy

---

## 5. Debug & Development

### 5.1 Common Debug Commands

```bash
# Check Flutter status
flutter doctor

# View application logs
flutter logs

# Hot reload (during development)
# Save changes - app automatically reloads

# Hot restart
# Stop and restart the app with current state

# Clean and rebuild
flutter clean
flutter pub get
flutter run
```

### 5.2 Logging
The application uses the `logger` package. Debug output appears in:
- VS Code/Android Studio terminal
- Xcode console (iOS)
- Chrome DevTools (Web)
- Android Studio Logcat (Android)

### 5.3 Common Debug Scenarios

#### Auth Token Expiration
- If token expires during a background pass, the service will auto-refresh
- User will be prompted to re-login if refresh fails

#### Background Task Not Executing
- Android: Ensure workmanager is initialized; check battery optimization settings
- iOS: Ensure background-fetch capability is enabled
- Web: Check browser console for polling errors

#### Database Issues
- Delete the `stash.db` file in the app's documents directory
- Re-run the app to recreate the schema
- Test with `flutter clean` if problems persist

---

## 6. Build Modes

### 6.1 Debug Mode (Default)
```bash
flutter run
```
- Used for development and testing
- Includes debug symbols
- Faster build times
- Shows Flutter debug banner

### 6.2 Profile Mode
```bash
flutter run --profile
```
- Performance-optimized build
- Useful for profiling battery/CPU usage
- Middle ground between debug and release

### 6.2 Release Mode
```bash
flutter build apk --release   # Android
flutter build ios --release   # iOS
flutter build web --release   # Web
```
- Optimized for production
- No debug symbols
- Smaller binary size
- Recommended for app store submission

### 6.3 Build Specific Platforms

#### Android APK
```bash
flutter build apk
# Or with flavor flavors if configured
flutter build apk --release
```

#### iOS IPA
```bash
flutter build ios --release
```
- Requires macOS with Xcode
- Signing configuration needed

#### Web Build
```bash
flutter build web --release
```
- Output goes to `build/web/`
- Can be hosted on any web server

---

## 7. Release Preparation

### 7.1 Version Bumping
Update version in `pubspec.yaml`:
```yaml
version: 1.0.0+1  # major.minor.patch+buildNumber
```
- Increment `+1` for each build
- Increment minor/patch for feature/bug fixes

### 7.2 Icon & Splash Screen
- Replace default Flutter icons in `android/app/src/main/res/`
- Replace splash screen images in `ios/Runner/` and `web/`
- Ensure adaptive icons for Android 12+

### 7.3 Store Listing
- Prepare screenshots for all platforms
- Write app description
- Configure privacy policy URL
- Set up app store listings (Google Play, App Store)

### 7.4 Environment Configuration
Create `.env` files or use environment variables:
```env
# .env file (not committed to repo)
FLUTTERSTASH_API_URL=https://api.stash.example.com
FLUTTERSTASH_KAFKA_BOOTSTRAP=kafka.example.com:9092
FLUTTERSTASH_MEGA_EMAIL=user@example.com
FLUTTERSTASH_MEGA_PASSWORD=mega-password
```

### 7.5 Release Checklist
- [ ] All 5 UI screens functional
- [ ] Authentication flow tested
- [ ] File upload/download tested
- [ ] Background tasks tested on target platforms
- [ ] No crashes or unhandled exceptions
- [ ] Performance acceptable (battery, memory)
- [ ] Design system consistent
- [ ] Changelog updated
- [ ] Environment configs for prod/staging/dev
- [ ] App store listings prepared

---

## 8. Known Issues & Workarounds

### 8.1 Platform-Specific

#### Android
- **Issue**: workmanager may not execute on emulators with Google Play Services disabled
- **Workaround**: Use physical device; web polling fallback available

#### iOS
- **Issue**: background_fetch may be limited on first launch
- **Workaround**: Complete initial auth flow; grant permissions when prompted

#### Web
- **Issue**: Background polling stops when browser tab is closed
- **Workaround**: Keep tab open for background checks; manual upload available

#### General
- **Issue**: First-run secure storage initialization may delay auth
- **Workaround**: Be patient during initial app startup; secure storage is being initialized

### 8.2 Configuration

#### Backend API Not Configured
- **Issue**: App runs in placeholder mode without backend connection
- **Workpoint**: Configure `AppConfig` with your backend URLs

#### Kafka REST Proxy
- **Issue**: Default endpoints point to localhost; need actual backend
- **Workaround**: Update `AppConfig.restUrl` and Kafka topic settings

#### Secure Storage
- **Issue**: May fail on custom ROMs or modified Android versions
- **Workaround**: Test on standard device configurations; web fallback available

---

## 📞 Getting Help

### Common Resources
- **Flutter Documentation**: https://docs.flutter.dev
- **Dart API Reference**: https://api.dart.dev
- **Stack Overflow**: Tag with `flutter` and `dart`
- **GitHub Issues**: Report bugs in the FlutterStash repository

### Contact
- For backend integration questions: Configure `AppConfig` as described above
- For platform-specific issues: Check the known issues section above
- For design system questions: Refer to the color/typography tables in the plan document

---

## 📄 Additional Documentation

For more detailed information, see:
- `FlutterStashPlan.md` - Full project plan and architecture
- `FlutterStashPhase1-5Summary.md` - Phase completion summaries
- `FlutterStashImplementationSummary.md` - Implementation details by phase
- `CHANGELOG.md` - Version history and change log
- `FlutterStashStart.md` - Initial setup notes

---
*Last updated: $(date)*
*FlutterStash v1.0.0*