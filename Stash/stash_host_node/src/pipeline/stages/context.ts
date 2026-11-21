import type { Logger } from 'pino';

import type { EventLevel } from '../../db/events';
import type { JobRow } from '../../db/jobs';
import type { PipelineDeps } from '../types';

export interface StageEventOptions {
  level?: EventLevel;
  message?: string | null;
  data?: unknown;
  stage?: string;
}

export interface StageContext {
  deps: PipelineDeps;
  job: JobRow;
  signal: AbortSignal;
  now: () => Date;
  /** Reports stage-relative progress in the 0..1 range; throttled by the runner. */
  progress: (fraction: number) => void;
  event: (event: string, options?: StageEventOptions) => void;
  logger?: Logger;
}

export type StageOutcome = 'continue' | 'return';

export type StageExecutor = (context: StageContext) => Promise<StageOutcome>;
