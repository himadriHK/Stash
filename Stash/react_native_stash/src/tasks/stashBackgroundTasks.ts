/**
 * Expo background-task definitions for Stash.
 *
 * `expo-background-task` runs deferrable JavaScript with WorkManager (Android)
 * and BGTaskScheduler (iOS) while the app is backgrounded, subject to battery
 * and network constraints. `expo-task-manager` runs the JS body.
 *
 * The task is defined at module scope: the native background runtime launches
 * the JS bundle without mounting React components, so the task must already be
 * registered when it fires. `index.ts` imports this module before
 * `registerRootComponent` to guarantee that.
 *
 * Both platforms share a single Expo worker, so one sync task owns the whole
 * background pass: the idempotent upload pass (stale recovery, folder scan,
 * transfer, outbox publish) followed by a bounded Kafka response drain.
 */
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { backgroundUploadService, kafkaConsumer } from '../services/singletons';
import { STASH_BACKGROUND_SYNC_TASK } from './backgroundTaskNames';

/** Response-drain budget: the OS may terminate the task at any moment. */
const BACKGROUND_CONSUMER_BUDGET_MS = 10_000;

TaskManager.defineTask(
  STASH_BACKGROUND_SYNC_TASK,
  async (): Promise<BackgroundTask.BackgroundTaskResult> => {
    try {
      const result = await backgroundUploadService.runOnceAsync();
      if (!result.success && !result.alreadyRunning) {
        // Returning Failed lets the platform reschedule with backoff. The pass
        // is idempotent, so a retry cannot double-apply work.
        console.warn('Background sync pass failed; the system will reschedule it.', result.error);
        return BackgroundTask.BackgroundTaskResult.Failed;
      }

      // Apply upload responses that arrived while the app was backgrounded.
      // No-op when the foreground consumer loop already owns polling.
      await kafkaConsumer.runOnceAsync(BACKGROUND_CONSUMER_BUDGET_MS);

      return BackgroundTask.BackgroundTaskResult.Success;
    } catch (error) {
      console.warn('Background sync task threw; the system will reschedule it.', error);
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  },
);