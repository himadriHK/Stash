export const STAGES = [
  'queued',
  'download',
  'verify',
  'deduplicate',
  'convert',
  'thumbnails',
  'store',
  'respond',
  'delete_temp',
  'done',
] as const;

export type Stage = (typeof STAGES)[number];

export const JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_STATUSES: readonly JobStatus[] = ['completed', 'failed', 'cancelled'];

export const STAGE_PROGRESS: Record<Stage, { start: number; end: number }> = {
  queued: { start: 0, end: 0 },
  download: { start: 10, end: 30 },
  verify: { start: 30, end: 40 },
  deduplicate: { start: 40, end: 45 },
  convert: { start: 45, end: 70 },
  thumbnails: { start: 70, end: 80 },
  store: { start: 80, end: 92 },
  respond: { start: 92, end: 97 },
  delete_temp: { start: 97, end: 100 },
  done: { start: 100, end: 100 },
};

export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
