import { useEffect, useState } from 'react';
import {
  formatSyncProgress,
  getSyncProgressSnapshot,
  subscribeSyncProgress,
  type SyncProgressSnapshot,
} from '../services/runtimeState';

/**
 * Subscribes a screen to the in-memory sync progress published by the scan and
 * upload pipeline. Progress updates are throttled at the source, so this hook
 * only re-renders on meaningful changes.
 */
export function useSyncProgress(): { snapshot: SyncProgressSnapshot; label: string | null } {
  const [snapshot, setSnapshot] = useState<SyncProgressSnapshot>(getSyncProgressSnapshot);

  useEffect(() => subscribeSyncProgress(setSnapshot), []);

  return { snapshot, label: formatSyncProgress(snapshot) };
}