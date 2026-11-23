/**
 * React render profiling for screens.
 *
 * Wraps a screen in React's `<Profiler>` so each mount/update reports its
 * actual render duration to the local profiler (`src/utils/profiler.ts`). This
 * is how the Settings re-render hotspot and similar UI bottlenecks surface
 * alongside the service-level function timings.
 *
 * `<Profiler>` is a no-op in production React builds and adds no behavior
 * change; it only measures. `recordEvent` drops the sample when the profiler is
 * disabled.
 */
import React, { Profiler, type ComponentType } from 'react';
import { recordEvent } from './profiler';

export interface RenderProfileProps {
  name: string;
  children: React.ReactNode;
}

/** Wraps already-rendered children in a named profiler boundary. */
export function ProfiledTree({ name, children }: RenderProfileProps): React.ReactElement {
  return (
    <Profiler
      id={`render.${name}`}
      onRender={(_id, phase, actualDuration) => {
        recordEvent(`render.${name}`, actualDuration, { phase });
      }}
    >
      {children}
    </Profiler>
  );
}

/**
 * Higher-order component that profiles a screen's renders. The returned
 * component renders identically (no memoization, so behavior is unchanged);
 * only timing is recorded.
 */
export function withRenderProfile<P extends object>(
  name: string,
  Component: ComponentType<P>,
): ComponentType<P> {
  function RenderProfiled(props: P) {
    return (
      <Profiler
        id={`render.${name}`}
        onRender={(_id, phase, actualDuration) => {
          recordEvent(`render.${name}`, actualDuration, { phase });
        }}
      >
        <Component {...props} />
      </Profiler>
    );
  }
  RenderProfiled.displayName = `withRenderProfile(${name})`;
  return RenderProfiled as ComponentType<P>;
}