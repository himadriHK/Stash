/**
 * Persisted UI preferences that are not part of the static appconfig.json:
 * Auto-upload, backup-videos and the notification "last seen" marker.
 *
 * Values live in the existing storage abstraction (SecureStore on native,
 * localStorage on web). A read failure falls back to documented defaults so a
 * locked keychain never blocks a screen.
 */
import { appConfig } from '../config/appConfig';
import { getAsync, setAsync } from '../utils/storage';

const AUTO_UPLOAD_KEY = 'stash.ui.autoUpload';
const BACKUP_VIDEOS_KEY = 'stash.ui.backupVideos';
const NOTIFICATIONS_SEEN_KEY = 'stash.ui.notificationsSeenAt';

export interface UiPreferences {
  /** Whether the scheduled background upload pass runs. */
  autoUpload: boolean;
  /** Whether the automatic pass includes video files. */
  backupVideos: boolean;
  /** ISO timestamp of the last "mark all read" in the Notification Center. */
  notificationsSeenAt: string | null;
}

let cached: UiPreferences | null = null;

function parseBoolean(value: string | null, fallback: boolean): boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return fallback;
}

function parseTimestamp(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function getUiPreferencesAsync(): Promise<UiPreferences> {
  if (cached) {
    return cached;
  }
  const [autoUpload, backupVideos, notificationsSeenAt] = await Promise.all([
    getAsync(AUTO_UPLOAD_KEY).catch(() => null),
    getAsync(BACKUP_VIDEOS_KEY).catch(() => null),
    getAsync(NOTIFICATIONS_SEEN_KEY).catch(() => null),
  ]);
  cached = {
    autoUpload: parseBoolean(autoUpload, appConfig.BackgroundUpload.Enabled),
    backupVideos: parseBoolean(backupVideos, true),
    notificationsSeenAt: parseTimestamp(notificationsSeenAt),
  };
  return cached;
}

export async function setAutoUploadAsync(enabled: boolean): Promise<UiPreferences> {
  const next = { ...(await getUiPreferencesAsync()), autoUpload: enabled };
  cached = next;
  await setAsync(AUTO_UPLOAD_KEY, String(enabled));
  return next;
}

export async function setBackupVideosAsync(enabled: boolean): Promise<UiPreferences> {
  const next = { ...(await getUiPreferencesAsync()), backupVideos: enabled };
  cached = next;
  await setAsync(BACKUP_VIDEOS_KEY, String(enabled));
  return next;
}

export async function markNotificationsSeenAsync(): Promise<UiPreferences> {
  const seenAt = new Date().toISOString();
  const next = { ...(await getUiPreferencesAsync()), notificationsSeenAt: seenAt };
  cached = next;
  await setAsync(NOTIFICATIONS_SEEN_KEY, seenAt);
  return next;
}
