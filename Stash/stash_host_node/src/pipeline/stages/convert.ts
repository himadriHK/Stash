import type { StageContext, StageOutcome } from './context';
import {
  ensureTempDir,
  resolveClassification,
  safeExtension,
  targetMimeType,
  tempConvertedPath,
  tempSourcePath,
} from './common';
import { convertToJpeg } from '../../media/images';
import { convertToMp4 } from '../../media/video';
import { runHeicConversion, runRawConversion } from '../../media/workers';
import { StageError } from '../retry';

export async function convertStage(ctx: StageContext): Promise<StageOutcome> {
  const { job, deps, signal } = ctx;
  const tempDir = await ensureTempDir(deps.local, job);
  const sourcePath = tempSourcePath(tempDir, job);
  const classification = await resolveClassification(job, sourcePath);
  const outputPath = tempConvertedPath(tempDir, classification.targetExtension);
  const kind = classification.kind;
  const sourceExtension = classification.sourceExtension;

  const isJpeg = sourceExtension === '.jpg' || sourceExtension === '.jpeg';
  const isMp4 = sourceExtension === '.mp4';
  let convertedFormat = targetMimeType(classification, job);

  if (kind === 'unsupported') {
    convertedFormat = job.mime_type ?? null;
  } else if (kind === 'image' && isJpeg) {
    // JPEG already matches the target; pass the source through.
  } else if (kind === 'video' && isMp4) {
    // MP4 already matches the target; pass the source through.
  } else if (kind === 'image') {
    ctx.progress(0);
    await convertToJpeg(
      sourcePath,
      outputPath,
      {
        quality: deps.env.IMAGE_JPEG_QUALITY,
        limitInputPixels: deps.env.MAX_IMAGE_PIXELS,
      },
      signal,
    );
    ctx.progress(1);
  } else if (kind === 'heic') {
    ctx.progress(0);
    await runHeicConversion(sourcePath, outputPath, {
      quality: deps.env.IMAGE_JPEG_QUALITY,
      signal,
      timeoutMs: deps.env.MEDIA_WORKER_TIMEOUT_MS,
    });
    ctx.progress(1);
  } else if (kind === 'raw') {
    ctx.progress(0);
    await runRawConversion(sourcePath, outputPath, {
      quality: deps.env.IMAGE_JPEG_QUALITY,
      signal,
      timeoutMs: deps.env.MEDIA_WORKER_TIMEOUT_MS,
    });
    ctx.progress(1);
  } else if (kind === 'video') {
    await convertToMp4(
      sourcePath,
      outputPath,
      {
        codec: deps.env.FFMPEG_VIDEO_CODEC,
        crf: deps.env.FFMPEG_CRF,
        preset: deps.env.FFMPEG_PRESET,
        timeoutMs: deps.env.STAGE_TIMEOUT_CONVERT_VIDEO_MS,
        ffmpegPath: deps.env.FFMPEG_PATH ?? null,
        ffprobePath: deps.env.FFPROBE_PATH ?? null,
      },
      (progress) => {
        if (typeof progress.percent === 'number') {
          ctx.progress(Math.min(1, progress.percent / 100));
        }
      },
      signal,
    );
  } else {
    throw new StageError('Unsupported media classification', {
      kind: 'terminal',
      code: 'unsupported_media',
    });
  }

  deps.jobs.updateFields(job.id, {
    converted_format: convertedFormat,
    stage: 'thumbnails',
    progress: 70,
  });
  ctx.event('convert_completed', {
    data: { kind, output: `converted${safeExtension(classification.targetExtension)}` },
  });
  return 'continue';
}
