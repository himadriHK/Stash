import { randomUUID } from 'node:crypto';

import type { UploadResponseV1 } from '../contracts/response';
import { parseStringRecord } from '../db/json';
import type { JobRow } from '../db/jobs';

export const RESPONSE_MESSAGE_VERSION = '1';

const MAX_ERROR_LENGTH = 500;
const THUMBNAIL_SIZES = ['128', '256', '512'] as const;

export interface ResponseArtifacts {
  permanentPath?: string | null;
  thumbnails?: Record<string, string>;
  convertedFormat?: string | null;
  deduplicated?: boolean;
}

export interface BuildResponseInput {
  job: JobRow;
  status: 'COMPLETED' | 'FAILED';
  artifacts?: ResponseArtifacts;
  error?: unknown;
  now?: Date;
  messageId?: string;
}

export interface BuiltResponse {
  response: UploadResponseV1;
  payload: string;
  key: string;
  headers: Record<string, string>;
}

/** Returns only logical thumbnail paths so absolute filesystem paths never leak. */
export function parseJobThumbnails(job: JobRow): Record<string, string> {
  const raw = parseStringRecord(job.thumbnails_json);
  const thumbnails: Record<string, string> = {};
  for (const size of THUMBNAIL_SIZES) {
    const value = raw[size];
    if (typeof value === 'string' && value.startsWith('/thumbs/')) {
      thumbnails[size] = value;
    }
  }
  return thumbnails;
}

/**
 * Produces a short, client-safe error message: no stack frames, control
 * characters, absolute filesystem paths, or credentials.
 */
export function sanitizeErrorMessage(error: unknown, maxLength = MAX_ERROR_LENGTH): string {
  let raw: string;
  if (error instanceof Error) raw = error.message;
  else if (typeof error === 'string') raw = error;
  else raw = 'Processing failed';

  raw = raw
    .split(/\r?\n/)
    .filter((line) => !/^\s*at\s+/.test(line))
    .join(' ');
  raw = raw.replace(/^\s*[A-Za-z]*Error:\s*/, '');
  raw = raw.replace(/[A-Za-z]:\\[^\s"']+/g, '[path]');
  raw = raw.replace(/\\\\[^\s"']+/g, '[path]');
  raw = raw.replace(/\/(?:[^\s/'"`<>|:]+\/)+[^\s/'"`<>|:]*/g, '[path]');
  raw = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  raw = raw.replace(/\s+/g, ' ').trim();

  if (raw === '') raw = 'Processing failed';
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function responseKey(job: JobRow): string {
  return job.file_id ?? job.request_file_id ?? job.id;
}

export function responseHeaders(job: JobRow): Record<string, string> {
  return {
    'X-Message-Version': RESPONSE_MESSAGE_VERSION,
    'X-Correlation-Id': job.correlation_id,
    'X-Device-Id': job.device_id ?? '',
    'X-User-Id': job.user_id ?? '',
  };
}

export function buildResponseV1(input: BuildResponseInput): BuiltResponse {
  const { job, status } = input;
  const now = input.now ?? new Date();
  const artifacts = input.artifacts ?? {};
  const fileId = responseKey(job);
  const permanentPath =
    artifacts.permanentPath !== undefined ? artifacts.permanentPath : (job.permanent_path ?? null);
  const convertedFormat =
    artifacts.convertedFormat !== undefined
      ? artifacts.convertedFormat
      : (job.converted_format ?? null);
  const deduplicated = artifacts.deduplicated ?? job.deduplicated === 1;

  const response: UploadResponseV1 = {
    messageId: input.messageId ?? randomUUID(),
    timestamp: now.toISOString(),
    fileId,
    status,
    permanentPath,
    thumbnails: artifacts.thumbnails ?? parseJobThumbnails(job),
    convertedFormat,
    deduplicated,
    processingTimeMs: computeProcessingTime(job, now),
    error:
      status === 'COMPLETED'
        ? null
        : sanitizeErrorMessage(input.error ?? job.error_message ?? 'Processing failed'),
    deviceId: job.device_id ?? '',
    userId: job.user_id ?? '',
    correlationId: job.correlation_id,
    version: 1,
  };

  return {
    response,
    payload: JSON.stringify(response),
    key: fileId,
    headers: responseHeaders(job),
  };
}

function computeProcessingTime(job: JobRow, now: Date): number {
  if (job.processing_time_ms !== null && job.processing_time_ms !== undefined) {
    return job.processing_time_ms;
  }
  if (!job.started_at) return 0;
  const started = Date.parse(job.started_at);
  const finished = job.finished_at ? Date.parse(job.finished_at) : now.getTime();
  if (Number.isNaN(started) || Number.isNaN(finished)) return 0;
  return Math.max(0, Math.round(finished - started));
}
