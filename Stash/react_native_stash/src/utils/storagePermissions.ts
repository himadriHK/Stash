/**
 * Android shared-storage permission plumbing.
 *
 * The app reads media files from folders the user configures (for example
 * `/storage/emulated/0/DCIM/Camera`). Android only allows that with runtime
 * permissions, and which ones depend on the OS version:
 *
 *  - Android 13 (API 33) and newer: READ_MEDIA_IMAGES / READ_MEDIA_VIDEO /
 *    READ_MEDIA_AUDIO. These grant direct file-path access to media files
 *    created by other apps (Android docs, "Access media files from shared
 *    storage" > "Direct file paths").
 *  - Android 12 and older: READ_EXTERNAL_STORAGE.
 *  - Android 14+ additionally offers "select photos" partial access
 *    (READ_MEDIA_VISUAL_USER_SELECTED), which is NOT enough to scan a folder.
 *
 * iOS needs no permission for the document picker (security-scoped URLs), and
 * web has no local filesystem. Both report `unsupported`.
 *
 * Expo Go is a special case: it declares none of the READ_MEDIA_* permissions,
 * so the system dialog never appears and every request is denied immediately.
 * `expoGo` state tells the UI to explain that a development build is required.
 */
import { Linking, PermissionsAndroid, Platform, type Permission } from 'react-native';
import * as Application from 'expo-application';
import { logError } from './errorLogger';

/** Package name of the Expo Go client. */
const EXPO_GO_APPLICATION_ID = 'host.exp.exponent';

export type StoragePermissionState =
  /** Everything needed is granted. */
  | 'granted'
  /** A permission is missing but Android can still show the dialog. */
  | 'denied'
  /** Missing and Android will no longer show the dialog: app settings needed. */
  | 'blocked'
  /** Running inside Expo Go, whose manifest declares no storage permissions. */
  | 'expoGo'
  /** iOS/web, where shared-storage permissions do not exist. */
  | 'unsupported';

export interface StorageAccess {
  state: StoragePermissionState;
  /** Permissions this platform and OS version require. */
  required: string[];
  /** Required permissions that are not granted. */
  missing: string[];
  /** Android API level (e.g. 36); null elsewhere. */
  androidVersion: number | null;
  /** Android 14+ "select photos" partial access was granted instead of all. */
  partialAccess: boolean;
  /** Short label for settings rows. */
  summary: string;
  /** Multi-sentence explanation of what to do next. */
  detail: string;
}

/** Human-readable names matching the Android permission prompts. */
const PERMISSION_LABELS: Record<string, string> = {
  'android.permission.READ_MEDIA_IMAGES': 'Photos',
  'android.permission.READ_MEDIA_VIDEO': 'Videos',
  'android.permission.READ_MEDIA_AUDIO': 'Music and audio',
  'android.permission.READ_EXTERNAL_STORAGE': 'Files and media',
};

export function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] ?? permission.replace('android.permission.', '');
}

/** Android API level (33 = Android 13), or null on other platforms. */
export function androidApiLevel(): number | null {
  if (Platform.OS !== 'android') {
    return null;
  }
  const version = Platform.Version;
  return typeof version === 'number' ? version : Number.parseInt(String(version), 10) || null;
}

/** True when the JS bundle runs inside the Expo Go client. */
export function isRunningInExpoGo(): boolean {
  if (Platform.OS === 'web') {
    return false;
  }
  try {
    return Application.applicationId === EXPO_GO_APPLICATION_ID;
  } catch {
    return false;
  }
}

/** Permissions needed to read configured folders on this device. */
export function requiredStoragePermissions(): string[] {
  const api = androidApiLevel();
  if (api === null) {
    return [];
  }
  if (api >= 33) {
    return [
      PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES,
      PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO,
      PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO,
    ];
  }
  return [PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE];
}

async function isGranted(permission: string): Promise<boolean> {
  try {
    return await PermissionsAndroid.check(permission as Permission);
  } catch {
    // Nothing declared under this name on this OS version: treat as missing.
    return false;
  }
}

function buildAccess(
  required: string[],
  missing: string[],
  partialAccess: boolean,
): StorageAccess {
  const androidVersion = androidApiLevel();
  const expoGo = Platform.OS === 'android' && isRunningInExpoGo();

  if (Platform.OS !== 'android' || required.length === 0) {
    return {
      state: 'unsupported',
      required,
      missing,
      androidVersion,
      partialAccess: false,
      summary: Platform.OS === 'web' ? 'Not applicable on web' : 'No permission required',
      detail:
        Platform.OS === 'web'
          ? 'Browsers grant access to each picked file individually, so no storage permission is needed.'
          : 'iOS grants access to each picked document individually, so no storage permission is needed.',
    };
  }

  if (missing.length === 0) {
    return {
      state: 'granted',
      required,
      missing,
      androidVersion,
      partialAccess: false,
      summary: 'Granted',
      detail: `Stash can read the folders you configure (${required
        .map(permissionLabel)
        .join(', ')} granted).`,
    };
  }

  const labels = missing.map(permissionLabel).join(', ');

  if (expoGo) {
    return {
      state: 'expoGo',
      required,
      missing,
      androidVersion,
      partialAccess,
      summary: 'Unavailable in Expo Go',
      detail:
        `Expo Go does not declare Android storage permissions, so Android denies ${labels} before any prompt is shown. ` +
        'Install a development build (npx expo run:android from the react_native_stash folder) or a standalone build to grant them. ' +
        'Scanning folders inside Expo Go will keep failing with permission errors.',
    };
  }

  if (partialAccess) {
    return {
      state: 'blocked',
      required,
      missing,
      androidVersion,
      partialAccess,
      summary: 'Limited photo access',
      detail:
        `Android granted access to selected photos only, so Stash cannot scan whole folders. ` +
        `Open the app settings, choose Photos and videos, and allow all ${labels}.`,
    };
  }

  return {
    state: 'blocked',
    required,
    missing,
    androidVersion,
    partialAccess,
    summary: 'Not granted',
    detail:
      `Stash needs ${labels} access to scan the folders you configured. ` +
      'Grant it on the Android permission prompt, or enable it in the app settings under Permissions.',
  };
}

/** Reads the current permission state without prompting. */
export async function getStorageAccessAsync(): Promise<StorageAccess> {
  const required = requiredStoragePermissions();
  if (Platform.OS !== 'android' || required.length === 0) {
    return buildAccess(required, [], false);
  }

  const missing: string[] = [];
  for (const permission of required) {
    if (!(await isGranted(permission))) {
      missing.push(permission);
    }
  }

  const visual = missing.some((permission) => permission.includes('READ_MEDIA_'));
  const partialAccess =
    visual &&
    (await isGranted(PermissionsAndroid.PERMISSIONS.READ_MEDIA_VISUAL_USER_SELECTED));

  return buildAccess(required, missing, partialAccess);
}

/**
 * Asks Android for every missing permission. Resolves with the state after the
 * prompts (or immediately in Expo Go, where no prompt can appear).
 */
export async function requestStorageAccessAsync(): Promise<StorageAccess> {
  const before = await getStorageAccessAsync();

  if (Platform.OS !== 'android' || before.required.length === 0) {
    return before;
  }
  if (before.state === 'granted' || before.state === 'expoGo') {
    // Expo Go's manifest declares none of these, so a request would be denied
    // without ever showing a dialog. Report it instead of pretending to ask.
    await logError(
      'permissions.storageExpoGo',
      new Error('Storage permissions cannot be granted inside Expo Go'),
      { required: before.required, androidVersion: before.androidVersion },
    );
    return before;
  }

  for (const permission of before.missing) {
    try {
      const result = await PermissionsAndroid.request(permission as Permission, {
        title: 'Storage access required',
        message:
          `Stash needs ${permissionLabel(permission)} access to scan the folders you added ` +
          'and upload new media. Without it, folder scans fail with permission errors.',
        buttonPositive: 'Allow',
        buttonNegative: 'Not now',
      });
      if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
        await logError(
          'permissions.storageBlocked',
          new Error(`Android will not prompt again for ${permission}`),
          { permission, androidVersion: before.androidVersion },
        );
        break;
      }
    } catch (error) {
      await logError('permissions.storageRequest', error, {
        permission,
        androidVersion: before.androidVersion,
      });
      break;
    }
  }

  return getStorageAccessAsync();
}

/** Opens this app's Android settings page so the user can re-enable access. */
export async function openStorageSettingsAsync(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch (error) {
    await logError('permissions.openSettings', error, {});
  }
}

/** True when an error coming out of expo-file-system is a permission denial. */
export function isStoragePermissionError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /permission|denied|EACCES|EPERM|not allowed|security/i.test(message);
}

/** Logs a detected permission blocker to the persistent error log. */
export async function logStorageAccessBlocker(access: StorageAccess): Promise<void> {
  if (access.state === 'granted' || access.state === 'unsupported') {
    return;
  }
  await logError('permissions.storageBlocker', new Error(access.summary), {
    state: access.state,
    missing: access.missing,
    androidVersion: access.androidVersion,
    partialAccess: access.partialAccess,
  });
}
