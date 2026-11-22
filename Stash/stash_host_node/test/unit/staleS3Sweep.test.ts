import { describe, expect, it } from 'vitest';

import { sweepStaleStagingObjects } from '../../src/pipeline/staleS3Sweep';
import { FakeS3Storage } from '../fakes/fakeS3';

const NOW = new Date('2026-11-22T12:00:00.000Z');
const OLD = new Date(NOW.getTime() - 48 * 3_600_000);
const FRESH = new Date(NOW.getTime() - 3_600_000);

function stagingObject(key: string, lastModified: Date): [string, Buffer, null, Date] {
  return [key, Buffer.from('bytes'), null, lastModified];
}

describe('sweepStaleStagingObjects', () => {
  it('deletes old staging objects that no active job references', async () => {
    const storage = new FakeS3Storage();
    const orphan = 'temp/uploads/dev-1/hash-orphan/photo.jpg';
    storage.put(...stagingObject(orphan, OLD));

    const result = await sweepStaleStagingObjects({
      storage,
      stagingPrefix: 'temp/uploads',
      retentionHours: 24,
      activeKeys: new Set<string>(),
      now: () => NOW,
    });

    expect(result).toMatchObject({ scanned: 1, deleted: 1, retained: 0, failed: 0 });
    expect(storage.has(orphan)).toBe(false);
  });

  it('keeps objects referenced by queued or running jobs and fresh uploads', async () => {
    const storage = new FakeS3Storage();
    const active = 'temp/uploads/dev-1/hash-active/photo.jpg';
    const fresh = 'temp/uploads/dev-1/hash-fresh/photo.jpg';
    storage.put(...stagingObject(active, OLD));
    storage.put(...stagingObject(fresh, FRESH));

    const result = await sweepStaleStagingObjects({
      storage,
      stagingPrefix: 'temp/uploads',
      retentionHours: 24,
      activeKeys: new Set([active]),
      now: () => NOW,
    });

    expect(result).toMatchObject({ scanned: 2, deleted: 0, retained: 2, failed: 0 });
    expect(storage.has(active)).toBe(true);
    expect(storage.has(fresh)).toBe(true);
  });

  it('never touches objects outside the staging prefix', async () => {
    const storage = new FakeS3Storage();
    const outside = 'backups/dev-1/hash.jpg';
    storage.put(...stagingObject(outside, OLD));

    const result = await sweepStaleStagingObjects({
      storage,
      stagingPrefix: 'temp/uploads',
      retentionHours: 24,
      activeKeys: new Set<string>(),
      now: () => NOW,
    });

    expect(result).toMatchObject({ scanned: 0, deleted: 0 });
    expect(storage.has(outside)).toBe(true);
  });

  it('reports per-object failures without aborting the sweep', async () => {
    const storage = new FakeS3Storage();
    const first = 'temp/uploads/dev-1/hash-1/photo.jpg';
    const second = 'temp/uploads/dev-1/hash-2/photo.jpg';
    storage.put(...stagingObject(first, OLD));
    storage.put(...stagingObject(second, OLD));

    const failing = {
      listObjects: (prefix: string, options?: { maxObjects?: number }) =>
        storage.listObjects(prefix, options),
      deleteObject: async (key: string) => {
        if (key === first) throw new Error('access denied');
        await storage.deleteObject(key);
      },
    };

    const result = await sweepStaleStagingObjects({
      storage: failing,
      stagingPrefix: 'temp/uploads',
      retentionHours: 24,
      activeKeys: new Set<string>(),
      now: () => NOW,
    });

    expect(result).toMatchObject({ scanned: 2, deleted: 1, failed: 1 });
    expect(storage.has(first)).toBe(true);
    expect(storage.has(second)).toBe(false);
  });
});
