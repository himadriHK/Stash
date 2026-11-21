import fs from 'node:fs/promises';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';

import decodeHeic from 'heic-decode';
import { LibRaw } from 'lightdrift-libraw';
import sharp from 'sharp';

interface MediaWorkerTask {
  type: 'heic' | 'raw';
  input: string;
  output: string;
  quality: number;
}

function toSafeMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Media worker failed';
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
  if (stats.size <= 0) throw new Error('Media output was empty');
}

async function convertHeic(task: MediaWorkerTask): Promise<{ width: number; height: number }> {
  const input = await fs.readFile(task.input);
  const decoded = await decodeHeic({ buffer: input });
  const raw = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);

  await fs.mkdir(path.dirname(task.output), { recursive: true });
  const part = `${task.output}.part`;
  try {
    await sharp(raw, {
      raw: { width: decoded.width, height: decoded.height, channels: 4 },
    })
      .jpeg({ quality: task.quality })
      .toFile(part);
    await assertNonEmpty(part);
    await replaceFile(part, task.output);
    return { width: decoded.width, height: decoded.height };
  } catch (error) {
    await fs.rm(part, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function convertRaw(task: MediaWorkerTask): Promise<{ width: number | null; height: number | null }> {
  const processor = new LibRaw();
  try {
    await processor.loadFile(task.input);
    const encoded = await processor.createJPEGBuffer({ quality: task.quality });

    await fs.mkdir(path.dirname(task.output), { recursive: true });
    const part = `${task.output}.part`;
    try {
      await fs.writeFile(part, encoded.data);
      await assertNonEmpty(part);
      await replaceFile(part, task.output);
    } catch (error) {
      await fs.rm(part, { force: true }).catch(() => undefined);
      throw error;
    }

    return { width: encoded.width ?? null, height: encoded.height ?? null };
  } finally {
    await processor.close().catch(() => undefined);
  }
}

if (!parentPort) {
  throw new Error('media worker must run inside a worker thread');
}

const port = parentPort;

port.once('message', async (task: MediaWorkerTask) => {
  if (
    !task ||
    (task.type !== 'heic' && task.type !== 'raw') ||
    typeof task.input !== 'string' ||
    typeof task.output !== 'string'
  ) {
    port.postMessage({ type: 'error', message: 'Invalid media worker task' });
    return;
  }

  try {
    const normalized: MediaWorkerTask = {
      ...task,
      quality: typeof task.quality === 'number' ? task.quality : 90,
    };
    const result = normalized.type === 'heic' ? await convertHeic(normalized) : await convertRaw(normalized);
    port.postMessage({ type: 'result', ...result });
  } catch (error) {
    port.postMessage({ type: 'error', message: toSafeMessage(error) });
  }
});
