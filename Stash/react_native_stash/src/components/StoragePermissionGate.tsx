/**
 * Launch-time storage permission gate.
 *
 * Android denies reads of shared storage (DCIM, Pictures, Downloads, …) until
 * the app holds the matching runtime permission. This gate checks on mount,
 * asks for whatever is missing, and — only when access is still blocked —
 * explains the blocker with a way forward instead of letting every scan fail
 * with an opaque `EACCES` error.
 *
 * It renders nothing on iOS/web and nothing once access is granted.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { ActionDialog } from './ActionDialog';
import {
  getStorageAccessAsync,
  isRunningInExpoGo,
  logStorageAccessBlocker,
  openStorageSettingsAsync,
  requestStorageAccessAsync,
  type StorageAccess,
} from '../utils/storagePermissions';

export function StoragePermissionGate() {
  const [blocker, setBlocker] = useState<StorageAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Checks, prompts when possible, and surfaces a blocker when still denied. */
  const ensureAccess = useCallback(async (requestPermissions: boolean) => {
    if (Platform.OS !== 'android') {
      return;
    }
    let access = await getStorageAccessAsync();
    if (requestPermissions && access.state === 'denied') {
      access = await requestStorageAccessAsync();
    }
    if (!mounted.current) {
      return;
    }
    if (access.state === 'denied' || access.state === 'blocked' || access.state === 'expoGo') {
      await logStorageAccessBlocker(access);
      if (mounted.current) {
        setBlocker(access);
      }
    } else {
      setBlocker(null);
    }
  }, []);

  // Ask once on launch, then re-check when the user comes back from settings.
  useEffect(() => {
    void ensureAccess(true);

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void ensureAccess(false);
      }
    });
    return () => subscription.remove();
  }, [ensureAccess]);

  const onRetry = useCallback(async () => {
    setBusy(true);
    setBlocker(null);
    try {
      const access = await requestStorageAccessAsync();
      if (mounted.current) {
        if (access.state === 'denied' || access.state === 'blocked') {
          await logStorageAccessBlocker(access);
          setBlocker(access);
        } else {
          setBlocker(null);
        }
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
      }
    }
  }, []);

  if (Platform.OS !== 'android' || !blocker) {
    return null;
  }

  const expoGo = blocker.state === 'expoGo' || isRunningInExpoGo();

  return (
    <ActionDialog
      visible={blocker !== null}
      title={expoGo ? 'Storage permission unavailable' : 'Storage permission needed'}
      message={`${blocker.detail}\n\nScanned folders: DCIM, Pictures, Movies and any other folder you added.`}
      buttons={
        expoGo
          ? [
              { label: 'OK', style: 'cancel', onPress: () => setBlocker(null) },
              {
                label: 'Open settings',
                onPress: () => {
                  setBlocker(null);
                  void openStorageSettingsAsync();
                },
              },
            ]
          : [
              { label: busy ? 'Asking…' : 'Allow access', onPress: () => void onRetry() },
              {
                label: 'Open settings',
                onPress: () => {
                  setBlocker(null);
                  void openStorageSettingsAsync();
                },
              },
              { label: 'Not now', style: 'cancel', onPress: () => setBlocker(null) },
            ]
      }
      onClose={() => setBlocker(null)}
    />
  );
}
