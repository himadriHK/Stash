/**
 * Schedules the background upload pass through two complementary triggers:
 *
 *  - a foreground `setInterval` so an open app uploads promptly (and the sync
 *    banner gives feedback), gated by AppState so it never fires while the app
 *    is backgrounded; and
 *  - an Expo background task (`expo-background-task`) so the OS can run the
 *    same idempotent pass while the app is backgrounded, subject to battery and
 *    network constraints.
 *
 * The public surface (`setEnabled`/`schedule`/`cancel`/`isScheduled`) is
 * unchanged so `App.tsx` and the Settings screen keep working.
 */
import { AppState, Platform } from 'react-native';
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { appConfig } from '../config/appConfig';
import { STASH_BACKGROUND_SYNC_TASK } from '../tasks/backgroundTaskNames';
import type { BackgroundUploadResult } from './backgroundUploadService';

/** WorkManager and BGTaskScheduler reject intervals below 15 minutes. */
const MIN_BACKGROUND_INTERVAL_MINUTES = 15;

export class BackgroundUploadScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private enabled = true;
  private backgroundRegistered = false;

  constructor(private readonly runPass: () => Promise<BackgroundUploadResult>) {}

  /** Applies the persisted Auto-upload preference immediately. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.schedule();
    } else {
      this.cancel();
    }
  }

  schedule(): void {
    if (!this.enabled || !appConfig.BackgroundUpload.Enabled) {
      return;
    }
    this.scheduleForeground();
    void this.registerBackgroundAsync();
  }

  cancel(): void {
    this.cancelForeground();
    void this.unregisterBackgroundAsync();
  }

  get isScheduled(): boolean {
    return this.timer !== null || this.backgroundRegistered;
  }

  private scheduleForeground(): void {
    if (this.timer) {
      return;
    }
    const minutes = Math.max(1, appConfig.BackgroundUpload.IntervalMinutes);
    this.timer = setInterval(() => {
      void this.tick();
    }, minutes * 60_000);
    console.info(`Foreground upload check scheduled every ${minutes} minute(s).`);
  }

  private cancelForeground(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.info('Foreground upload check canceled.');
    }
  }

  private backgroundIntervalMinutes(): number {
    return Math.max(
      MIN_BACKGROUND_INTERVAL_MINUTES,
      appConfig.BackgroundUpload.IntervalMinutes,
    );
  }

  /**
   * Registers the Expo background task. Best effort: Expo Go, the web, and
   * restricted OS configurations fall back to the foreground schedule only.
   */
  private async registerBackgroundAsync(): Promise<void> {
    if (this.backgroundRegistered || !this.enabled || !appConfig.BackgroundUpload.Enabled) {
      return;
    }
    if (Platform.OS === 'web') {
      return;
    }

    try {
      if (!(await TaskManager.isAvailableAsync())) {
        console.info('Expo background tasks are unavailable here; using the foreground schedule only.');
        return;
      }

      const status = await BackgroundTask.getStatusAsync();
      if (status !== BackgroundTask.BackgroundTaskStatus.Available) {
        const label = BackgroundTask.BackgroundTaskStatus[status] ?? String(status);
        console.info(`Background tasks are ${label}; using the foreground schedule only.`);
        return;
      }

      if (!(await TaskManager.isTaskDefined(STASH_BACKGROUND_SYNC_TASK))) {
        console.warn('Background sync task is not defined; skipping background registration.');
        return;
      }

      await BackgroundTask.registerTaskAsync(STASH_BACKGROUND_SYNC_TASK, {
        minimumInterval: this.backgroundIntervalMinutes(),
      });
      this.backgroundRegistered = true;
      console.info(
        `Background upload registered with a ${this.backgroundIntervalMinutes()}-minute minimum interval.`,
      );
    } catch (error) {
      console.warn('Could not register the background upload task.', error);
    }
  }

  private async unregisterBackgroundAsync(): Promise<void> {
    if (!this.backgroundRegistered) {
      return;
    }
    this.backgroundRegistered = false;
    try {
      await BackgroundTask.unregisterTaskAsync(STASH_BACKGROUND_SYNC_TASK);
      console.info('Background upload task unregistered.');
    } catch (error) {
      console.warn('Could not unregister the background upload task.', error);
    }
  }

  private async tick(): Promise<void> {
    if (!this.enabled || !appConfig.BackgroundUpload.Enabled) {
      return;
    }
    // Pause polling while the app is backgrounded (documented web/mobile
    // fallback: interval-based checks only while visible). The Expo background
    // task covers the backgrounded case.
    if (AppState.currentState !== 'active') {
      return;
    }
    try {
      const result = await this.runPass();
      if (!result.success && !result.alreadyRunning) {
        console.warn('Scheduled background upload pass failed:', result.error);
      }
    } catch (error) {
      console.warn('Scheduled background upload pass failed.', error);
    }
  }
}