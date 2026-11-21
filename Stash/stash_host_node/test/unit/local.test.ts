import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalLibrary } from '../../src/storage/local';
import { PathError } from '../../src/storage/paths';
import { createWorkspace } from '../helpers/env';
import type { TestWorkspace } from '../helpers/env';

const HASH = 'c'.repeat(64);

let workspace: TestWorkspace | null = null;

function library(): { work: TestWorkspace; local: LocalLibrary } {
  workspace = createWorkspace();
  return { work: workspace, local: new LocalLibrary(workspace.env) };
}

afterEach(() => {
  workspace?.cleanup();
  workspace = null;
});

describe('LocalLibrary', () => {
  it('creates the root and reports writability/free space', async () => {
    const { work, local } = library();
    await local.ensureReady();
    const stats = await fs.stat(work.env.LOCAL_ROOT_PATH);
    expect(stats.isDirectory()).toBe(true);
    expect(typeof (await local.freeBytes())).toBe('number');
  });

  it('creates and cleans per-job temp directories', async () => {
    const { work, local } = library();
    const dir = await local.ensureTempDir('job-1');
    expect(dir).toBe(path.join(work.env.TEMP_DIR, 'jobs', 'job-1'));
    await fs.writeFile(path.join(dir, 'data.bin'), 'hello');
    await local.cleanupTempDir('job-1');
    await expect(fs.stat(dir)).rejects.toThrow();

    expect(() => local.tempJobDir('../escape')).toThrow(PathError);
  });

  it('writes logical files atomically and treats same-size destinations as stored', async () => {
    const { local } = library();
    const logical = `/backups/u1/${HASH}.jpg`;

    await local.atomicWriteFile(Buffer.from('aaaa'), logical);
    expect((await local.inspect(logical))?.size).toBe(4);
    expect(await local.exists(logical)).toBe(true);

    await local.atomicWriteFile(Buffer.from('bbbb'), logical);
    expect(await fs.readFile(local.absolute(logical), 'utf8')).toBe('aaaa');
    const missing = `/backups/u1/${'d'.repeat(64)}.jpg`;
    expect(await local.inspect(missing)).toBeNull();
    expect(await local.exists(missing)).toBe(false);
  });

  it('copies atomically and skips same-size destinations', async () => {
    const { work, local } = library();
    const source = path.join(work.root, 'source.jpg');
    await fs.writeFile(source, 'source-bytes');

    const logical = `/backups/u1/${HASH}.jpg`;
    await local.atomicCopyFile(source, logical);
    expect(await fs.readFile(local.absolute(logical), 'utf8')).toBe('source-bytes');

    await fs.writeFile(local.absolute(logical), 'other--bytes');
    await local.atomicCopyFile(source, logical);
    expect(await fs.readFile(local.absolute(logical), 'utf8')).toBe('other--bytes');
  });

  it('streams to a temp path with progress and returns bytes', async () => {
    const { work, local } = library();
    const jobDir = await local.ensureTempDir('job-2');
    const destination = path.join(jobDir, 'upload.bin');
    const progress: number[] = [];

    const bytes = await local.writeStreamToTemp(
      Readable.from([Buffer.from('hello '), Buffer.from('world')]),
      destination,
      (written) => progress.push(written),
    );

    expect(bytes).toBe(11);
    expect(progress.at(-1)).toBe(11);
    expect(await fs.readFile(destination, 'utf8')).toBe('hello world');
    expect((await fs.stat(work.env.TEMP_DIR)).isDirectory()).toBe(true);
  });

  it('rejects destinations outside the library and temp roots', async () => {
    const { work, local } = library();
    await expect(
      local.atomicWriteFile(Buffer.from('x'), '/other/u1/file.jpg'),
    ).rejects.toThrow(PathError);
    await expect(
      local.writeStreamToTemp(Readable.from([Buffer.from('x')]), path.join(work.root, '..', 'evil.bin')),
    ).rejects.toThrow(PathError);
  });
});

