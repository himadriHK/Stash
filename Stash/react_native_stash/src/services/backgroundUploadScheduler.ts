/**
 * Registers the periodic background-upload worker. React Native has no OS-level
 * background execution without native modules, so the documented polling
 * fallback is used: a timer that fires every `BackgroundUpload:IntervalMinutes`
 * (default 15) while the app is in the foreground (AppState-aware), matching
 * IBackgroundUploadScheduler (ScheduleAsync/CancelAsync) semantics.
 */
import { AppState } from 'react-native';
import { appConfig } from '../config/appConfig';
import type { BackgroundUploadResult } from './backgroundUploadService';

export class BackgroundUploadScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private enabled = true;

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
    if (this.timer || !this.enabled) {
      return;
    }
    if (!appConfig.BackgroundUpload.Enabled) {
      return;
    }
    const minutes = Math.max(1, appConfig.BackgroundUpload.IntervalMinutes);
    this.timer = setInterval(() => {
      void this.tick();
    }, minutes * 60_000);
    console.info(`Background upload scheduled every ${minutes} minute(s).`);
  }

  cancel(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.info('Background upload schedule canceled.');
    }
  }

  get isScheduled(): boolean {
    return this.timer !== null;
  }

  private async tick(): Promise<void> {
    if (!this.enabled || !appConfig.BackgroundUpload.Enabled) {
      return;
    }
    // Pause polling while the app is backgrounded (documented web/mobile
    // fallback: interval-based checks only while visible).
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
