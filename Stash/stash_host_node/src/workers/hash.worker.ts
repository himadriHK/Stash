import fs from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';

import { hashFileStreaming } from '../media/hash';

interface HashWorkerTask {
  type: 'hash';
  path: string;
}

function toSafeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Hash worker failed';
}

if (!parentPort) {
  throw new Error('hash worker must run inside a worker thread');
}

const port = parentPort;

port.once('message', async (task: HashWorkerTask) => {
  if (!task || task.type !== 'hash' || typeof task.path !== 'string') {
    port.postMessage({ type: 'error', message: 'Invalid hash worker task' });
    return;
  }

  let total = 0;
  try {
    total = (await fs.stat(task.path)).size;
  } catch {
    total = 0;
  }

  try {
    const hash = await hashFileStreaming(task.path, (bytes) => {
      port.postMessage({ type: 'progress', bytes, total });
    });
    port.postMessage({ type: 'result', hash });
  } catch (error) {
    port.postMessage({ type: 'error', message: toSafeMessage(error) });
  }
});
