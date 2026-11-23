/**
 * Optional Sentry wiring for `@sentry/react-native`.
 *
 * This module is intentionally defensive:
 * - Without `EXPO_PUBLIC_SENTRY_DSN` it is a no-op, so the local-first profiler
 *   in `src/utils/profiler.ts` is the only thing that runs.
 * - On web and in environments where the native module is missing it never
 *   throws, so adding the dependency cannot break the existing app.
 *
 * When a DSN is configured it enables Tracing + Profiling (JS call-stack
 * sampling through Hermes plus the platform profilers) and registers a span
 * hook so every function span recorded by the local profiler is also mirrored
 * into Sentry as a span. That yields flame graphs and per-transaction profiles
 * in the Sentry dashboard without instrumenting the app twice.
 *
 * Importing this module initializes Sentry as a side effect; `index.ts` imports
 * it before the app entry point so profiling also covers app start.
 */
import * as Sentry from '@sentry/react-native';
import { Platform } from 'react-native';
import type { ComponentType } from 'react';
import { setProfilingSpanHook, type ProfileAttrs } from '../utils/profiler';

function readString(raw: string | undefined, fallback: string): string {
  return raw !== undefined && raw.trim() !== '' ? raw.trim() : fallback;
}

function readNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const dsn = readString(process.env.EXPO_PUBLIC_SENTRY_DSN, '');
const environment = readString(
  process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT,
  typeof __DEV__ !== 'undefined' && __DEV__ ? 'development' : 'production',
);
const tracesSampleRate = readNumber(process.env.EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE, 1.0);
const profilesSampleRate = readNumber(process.env.EXPO_PUBLIC_SENTRY_PROFILES_SAMPLE_RATE, 1.0);

let initialized = false;
let initFailed = false;

/** True once Sentry has been initialized with a DSN on a supported platform. */
export function isSentryEnabled(): boolean {
  return initialized;
}

/** True when a DSN is configured (even if init failed or was skipped). */
export function hasSentryDsn(): boolean {
  return dsn.length > 0;
}

function installSentrySpanBridge(): void {
  setProfilingSpanHook((name: string, attrs: ProfileAttrs | undefined) => {
    try {
      const span = Sentry.startInactiveSpan({ name, op: 'function' });
      if (!span) {
        return null;
      }
      if (attrs) {
        for (const [key, value] of Object.entries(attrs)) {
          if (
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
          ) {
            span.setAttribute(key, value);
          }
        }
      }
      return {
        finish: () => {
          try {
            span.end();
          } catch {
            // A failing Sentry span must never affect the measured code.
          }
        },
      };
    } catch {
      return null;
    }
  });
}

export function initSentry(): void {
  if (initialized || initFailed) {
    return;
  }
  // Sentry React Native has no usable native layer on web; the local profiler
  // already covers web, so skip to avoid noisy warnings.
  if (Platform.OS === 'web') {
    return;
  }
  // Local-first: without a DSN only the local profiler runs.
  if (dsn.length === 0) {
    return;
  }
  try {
    Sentry.init({
      dsn,
      environment,
      tracesSampleRate,
      profilesSampleRate,
      integrations: [Sentry.hermesProfilingIntegration()],
    });
    initialized = true;
    installSentrySpanBridge();
  } catch (error) {
    initFailed = true;
    console.warn('[sentry] init failed; using the local profiler only.', error);
  }
}

/**
 * Wraps the root component so Sentry can track renders and native frames.
 * Returns the component unchanged when Sentry is not active.
 */
export function wrapAppRoot(component: ComponentType): ComponentType {
  if (!initialized) {
    return component;
  }
  try {
    return Sentry.wrap(component as ComponentType<Record<string, unknown>>) as unknown as ComponentType;
  } catch {
    return component;
  }
}

// Initialize on import. index.ts imports this module first, before the
// background-task definition and the app entry point.
initSentry();