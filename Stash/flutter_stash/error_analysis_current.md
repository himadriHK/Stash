# Flutter Error Analysis — Final Status

**Verified:** `flutter run -d chrome` launches successfully (no compile errors, no startup exceptions in terminal log).
**`flutter build web`:** ✅ succeeds.
**`flutter analyze`:** 66 issues — **0 errors**, 55 warnings, 11 info.

---

## Resolved build-blocking errors (grouped by file)

### `lib/main.dart`
- `DatabaseHelper` was used but never imported → added `import 'services/database_helper.dart';`
- `ChangeNotifierProvider` rejected `AuthProvider` (not a `ChangeNotifier`) → `AuthProvider` now extends `ChangeNotifier`.
- **Runtime bug:** `_fileRepository` was constructed with `_megaService` before `_megaService` was assigned, and `build()` read uninitialized `late final` fields (`_authProvider`) → rewrote service graph with field initializers, added a `_ready` gate + loading screen, and made DB init non-fatal on web (sqflite is unavailable there).

### `lib/providers/auth_provider.dart`
- `undefined_identifier: uuid` (lines 57, 86) → uuid 4.x removed the top-level `uuid` constant; replaced with `const Uuid().v4()`.
- Added `import 'package:flutter/foundation.dart';` for `ChangeNotifier`.

### `lib/models/upload_request_message.dart`
- `undefined_identifier: uuid` → `const Uuid().v4()`.

### `lib/models/upload_response_message.dart`
- `undefined_identifier: uuid` → `const Uuid().v4()`.
- `argument_type_not_assignable` in `_mapsEqual` → nullable map parameter + `bool` return type.

### `lib/models/folder_config.dart`
- `final_not_initialized_constructor` for `includeSubfolders` → initializer `includeSubfolders = includeSubfolders ?? true`.
- `addedAt` final field initialized both in declaration and constructor → single nullable constructor parameter with `addedAt ?? DateTime.now()`.
- `_listEquals` called with 2 args but declared with 1 → now takes the compared list and checks against the instance fields.

### `lib/models/auth_result.dart`
- `new_with_undefined_constructor_default` → added the unnamed generative constructor used by `fromJson`.

### `lib/repositories/file_repository.dart`
- `argument_type_not_assignable` at `Sqflite.firstIntValue(maps.first)` → sqflite's API takes the row list: `Sqflite.firstIntValue(maps)`.

### `lib/services/folder_scanner_service.dart`
- `String? Function(Match)` passed to `String.replaceAll` → replaced hand-rolled glob escaping with a `_globToRegex` implementation using `RegExp.escape` and `*`/`?` wildcard handling.

### `lib/services/kafka_http_transport.dart`
- `undefined_identifier: uuid` → `const Uuid().v4()`.
- `return_of_invalid_type: Stream<Future<Null>>` → rewrote `consumeUploadResponses` as an `async*` polling stream yielding `UploadResponseMessage` (also removed the `takeWhile((_) => false)` that terminated it immediately).

### `lib/services/background_upload_service.dart`
- `undefined_identifier: uuid` (lines 79, 91) → `const Uuid().v4()`.

### `lib/services/upload_result.dart` + `lib/models/upload_result.dart`
- Two distinct `UploadResult` classes existed; values from `MegaHttpService` (models) were incompatible with `UploadManager` (services), so the merged `??` inferred `Object` and every member access failed.
- Fixed by making `services/upload_result.dart` re-export the canonical model class.

### `lib/services/upload_manager.dart`
- `unchecked_use_of_nullable_value` on `result.errorMessage` / `result.megaTempPath` → `result` is now made non-nullable with a fallback `UploadResult` when the Mega service returns null.

### `lib/views/folder_config_page.dart`
- `not_enough_positional_arguments` / wrong argument types in `_toggleFolder(folder.id, value)` → call site now passes `context`.
- `assignment_to_final: isEnabled` → use `folder.copyWith(isEnabled: enabled)` before `updateAsync`.

### `lib/views/main_page.dart`
- `undefined_getter: WidgetsFlutterBinding.instance` → `WidgetsBinding.instance`.

---

## Remaining warnings (non-blocking, 55)

| Rule | Count | Notes |
|------|-------|-------|
| `unused_import` | 36 | Mostly `lib/routes.dart` and `lib/services/mega_http_service.dart` |
| `unused_field` | 6 | Repositories/services no longer used after refactors |
| `override_on_non_overriding_member` | 5 | Stale `@override` annotations |
| `unused_local_variable` | 3 | `appConfig` locals in login/register pages |
| `unnecessary_question_mark` | 2 | Redundant `?` in casts |
| `dead_null_aware_expression` | 1 | `background_upload_service.dart:137` |
| `unused_element` | 1 | `_BackgroundUploadResultCompleted` |
| `include_file_not_found` | 1 | `analysis_options.yaml` includes `package:flutter_lints/flutter.yaml`, but `flutter_lints` is not in `dev_dependencies` |

Note: `analysis_options.yaml` also means project lint rules are not currently applied. Adding `flutter_lints` to `dev_dependencies` would enable them (and may surface additional lint info, not errors).

---

## Verification commands used

```powershell
flutter analyze                  # 0 errors
flutter build web                # √ Built build\web
flutter run -d chrome            # launches, debug service connects
flutter run -d chrome --no-resident   # compiles + launches and exits cleanly
```

Runtime note: `sqflite` has no web implementation, so local DB calls fail on Chrome/Web. Initialization is now wrapped so the app still starts and renders; persistence-dependent screens degrade gracefully. Use `sqflite_common_ffi_web` or an in-memory/HTTP-backed repository if web persistence is required.
