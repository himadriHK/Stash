import fs from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';
import ffmpegStaticPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
const DEFAULT_VIDEO_TIMEOUT_MS = 3_600_000;
const STDERR_TAIL_LIMIT = 1_000;

export type VideoErrorCode =
  | 'FFMPEG_NOT_FOUND'
  | 'FFPROBE_NOT_FOUND'
  | 'FFPROBE_FAILED'
  | 'FFMPEG_FAILED'
  | 'FFMPEG_TIMEOUT'
  | 'FFMPEG_ABORTED'
  | 'EMPTY_OUTPUT';

export class VideoError extends Error {
  readonly code: VideoErrorCode;

  constructor(message: string, code: VideoErrorCode = 'FFMPEG_FAILED', cause?: unknown) {
    super(message, { cause });
    this.name = 'VideoError';
    this.code = code;
  }
}

export interface VideoProgress {
  seconds: number;
  percent: number | null;
}

export type VideoProgressCallback = (progress: VideoProgress) => void;

export interface Mp4ConversionOptions {
  codec: string;
  crf: number;
  preset: string;
  timeoutMs?: number;
  durationSeconds?: number | null;
  ffmpegPath?: string | null;
  ffprobePath?: string | null;
}

export interface ProbeOptions {
  timeoutMs?: number;
  ffprobePath?: string | null;
}

function configuredPath(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return null;
}

export function resolveFfmpegPath(override?: string | null): string {
  const resolved = configuredPath(override, process.env.FFMPEG_PATH, ffmpegStaticPath);
  if (!resolved) {
    throw new VideoError('ffmpeg binary was not found; set FFMPEG_PATH', 'FFMPEG_NOT_FOUND');
  }
  return resolved;
}

export function resolveFfprobePath(override?: string | null): string {
  const resolved = configuredPath(override, process.env.FFPROBE_PATH, ffprobeStatic.path);
  if (!resolved) {
    throw new VideoError('ffprobe binary was not found; set FFPROBE_PATH', 'FFPROBE_NOT_FOUND');
  }
  return resolved;
}

function safeStderr(stderr: string): string {
  return stderr
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-STDERR_TAIL_LIMIT);
}

function isErrorWithCode(error: unknown, ...codes: string[]): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && codes.includes(code);
}

async function replaceFile(part: string, output: string): Promise<void> {
  try {
    await fs.rename(part, output);
  } catch (error) {
    if (!isErrorWithCode(error, 'EEXIST', 'EPERM', 'EACCES')) throw error;
    await fs.rm(output, { force: true });
    await fs.rename(part, output);
  }
}

async function assertNonEmpty(target: string): Promise<void> {
  const stats = await fs.stat(target);
  if (stats.size <= 0) {
    throw new VideoError('ffmpeg produced an empty output file', 'EMPTY_OUTPUT');
  }
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

function buildExecaLifetimeOptions(signal: AbortSignal | undefined, timeoutMs: number) {
  return {
    timeout: timeoutMs,
    forceKillAfterDelay: 5_000,
    cleanup: true,
    ...(signal ? { cancelSignal: signal } : {}),
  };
}

/** Returns the media duration in seconds using ffprobe. */
export async function probeDurationSeconds(
  input: string,
  signal?: AbortSignal,
  options: ProbeOptions = {},
): Promise<number> {
  const binary = resolveFfprobePath(options.ffprobePath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let result;
  try {
    result = await execa(
      binary,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        input,
      ],
      {
        reject: false,
        encoding: 'utf8',
        ...buildExecaLifetimeOptions(signal, timeoutMs),
      },
    );
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    throw new VideoError('ffprobe could not be executed', 'FFPROBE_FAILED', error);
  }

  if (result.isCanceled) throw new VideoError('ffprobe was aborted', 'FFMPEG_ABORTED');
  if (result.timedOut) throw new VideoError('ffprobe timed out', 'FFMPEG_TIMEOUT');
  if (result.exitCode !== 0) {
    const tail = safeStderr(result.stderr);
    throw new VideoError(
      tail ? `ffprobe failed: ${tail}` : 'ffprobe failed',
      'FFPROBE_FAILED',
    );
  }

  const duration = Number.parseFloat(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new VideoError('ffprobe did not report a valid duration', 'FFPROBE_FAILED');
  }
  return duration;
}

/**
 * Converts a video to a fast-start MP4 using the legacy FFmpeg argument shape.
 * The output is written to a `.part` file and renamed on success; partial
 * output is deleted on failure, abort, or timeout.
 */
export async function convertToMp4(
  input: string,
  output: string,
  options: Mp4ConversionOptions,
  onProgress?: VideoProgressCallback,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw abortError(signal);

  const binary = resolveFfmpegPath(options.ffmpegPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_VIDEO_TIMEOUT_MS;
  let duration = options.durationSeconds ?? null;
  if (duration === null) {
    try {
      duration = await probeDurationSeconds(input, signal, {
        ffprobePath: options.ffprobePath,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      duration = null;
    }
  }

  await fs.mkdir(path.dirname(output), { recursive: true });
  const part = `${output}.part`;

  const videoCodecArgs =
    options.codec === 'libx264'
      ? ['-preset', options.preset, '-crf', String(options.crf)]
      : ['-q:v', '5'];

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c:v',
    options.codec,
    ...videoCodecArgs,
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-f',
    'mp4',
    part,
  ];

  let stderr = '';
  let progressBuffer = '';
  let renamed = false;

  try {
    const subprocess = execa(binary, args, {
      reject: false,
      buffer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      ...buildExecaLifetimeOptions(signal, timeoutMs),
    });

    subprocess.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`;
      if (stderr.length > 8_192) stderr = stderr.slice(-8_192);
    });

    subprocess.stdout?.on('data', (chunk: Buffer) => {
      progressBuffer += chunk.toString('utf8');
      let newline = progressBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = progressBuffer.slice(0, newline).trim();
        progressBuffer = progressBuffer.slice(newline + 1);
        handleProgressLine(line, duration, onProgress);
        newline = progressBuffer.indexOf('\n');
      }
    });

    const result = await subprocess;

    if (result.isCanceled) throw new VideoError('ffmpeg was aborted', 'FFMPEG_ABORTED');
    if (result.timedOut) throw new VideoError('ffmpeg timed out', 'FFMPEG_TIMEOUT');
    if (result.exitCode !== 0) {
      const tail = safeStderr(stderr);
      throw new VideoError(tail ? `ffmpeg failed: ${tail}` : 'ffmpeg failed', 'FFMPEG_FAILED');
    }

    await assertNonEmpty(part);
    await replaceFile(part, output);
    renamed = true;

    if (duration !== null && duration > 0 && onProgress) {
      onProgress({ seconds: duration, percent: 100 });
    }
  } catch (error) {
    if (signal?.aborted && !(error instanceof VideoError)) throw abortError(signal);
    throw error;
  } finally {
    if (!renamed) {
      await fs.rm(part, { force: true }).catch(() => undefined);
    }
  }
}

function handleProgressLine(
  line: string,
  duration: number | null,
  onProgress: VideoProgressCallback | undefined,
): void {
  if (!onProgress || !line.startsWith('out_time_ms=')) return;
  const raw = line.slice('out_time_ms='.length).trim();
  if (raw === 'N/A') return;
  const micros = Number(raw);
  if (!Number.isFinite(micros) || micros < 0) return;
  const seconds = micros / 1_000_000;
  const percent =
    duration !== null && duration > 0
      ? Math.min(100, Math.round((seconds / duration) * 1000) / 10)
      : null;
  onProgress({ seconds, percent });
}

/** Extracts the first video frame as a JPEG and verifies it is non-empty. */
export async function extractVideoFrame(
  input: string,
  output: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw abortError(signal);

  const binary = resolveFfmpegPath();
  await fs.mkdir(path.dirname(output), { recursive: true });
  const part = `${output}.part`;
  let stderr = '';
  let renamed = false;

  try {
    const subprocess = execa(
      binary,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-y',
        '-ss',
        '0',
        '-i',
        input,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        part,
      ],
      {
        reject: false,
        buffer: false,
        stdout: 'pipe',
        stderr: 'pipe',
        ...buildExecaLifetimeOptions(signal, DEFAULT_PROBE_TIMEOUT_MS),
      },
    );

    subprocess.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`;
      if (stderr.length > 8_192) stderr = stderr.slice(-8_192);
    });

    const result = await subprocess;

    if (result.isCanceled) throw new VideoError('ffmpeg was aborted', 'FFMPEG_ABORTED');
    if (result.timedOut) throw new VideoError('ffmpeg frame extraction timed out', 'FFMPEG_TIMEOUT');
    if (result.exitCode !== 0) {
      const tail = safeStderr(stderr);
      throw new VideoError(
        tail ? `ffmpeg frame extraction failed: ${tail}` : 'ffmpeg frame extraction failed',
        'FFMPEG_FAILED',
      );
    }

    await assertNonEmpty(part);
    await replaceFile(part, output);
    renamed = true;
    return output;
  } catch (error) {
    if (signal?.aborted && !(error instanceof VideoError)) throw abortError(signal);
    throw error;
  } finally {
    if (!renamed) {
      await fs.rm(part, { force: true }).catch(() => undefined);
    }
  }
}
