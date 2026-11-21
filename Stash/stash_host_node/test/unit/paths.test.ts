import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PathError,
  buildLocalPermanentPath,
  buildLocalThumbnailPath,
  buildS3Key,
  normalizedExtension,
  resolveLocalPath,
} from '../../src/storage/paths';

const HASH = 'b'.repeat(64);

describe('S3 key mapping', () => {
  it('joins the logical path with a trimmed prefix', () => {
    expect(buildS3Key('/temp/uploads/dev1/abc/IMG.heic', 'stash')).toBe(
      'stash/temp/uploads/dev1/abc/IMG.heic',
    );
    expect(buildS3Key('/temp/uploads/dev1/abc/IMG.heic', '/stash/')).toBe(
      'stash/temp/uploads/dev1/abc/IMG.heic',
    );
    expect(buildS3Key('/temp/uploads/dev1/abc/IMG.heic', '')).toBe(
      'temp/uploads/dev1/abc/IMG.heic',
    );
  });

  it('rejects traversal and backslashes', () => {
    expect(() => buildS3Key('/temp/../evil', 'stash')).toThrow(PathError);
    expect(() => buildS3Key('/temp/./evil', 'stash')).toThrow(PathError);
    expect(() => buildS3Key('/temp//evil', 'stash')).toThrow(PathError);
    expect(() => buildS3Key('temp/evil', 'stash')).toThrow(PathError);
    expect(() => buildS3Key('/temp\\evil', 'stash')).toThrow(PathError);
    expect(() => buildS3Key('/temp/evil', '../prefix')).toThrow(PathError);
  });
});

describe('local logical paths', () => {
  it('builds permanent and thumbnail paths', () => {
    expect(buildLocalPermanentPath('u1', HASH, '.jpg')).toBe(`/backups/u1/${HASH}.jpg`);
    expect(buildLocalPermanentPath('u1', HASH, '.MP4')).toBe(`/backups/u1/${HASH}.mp4`);
    expect(buildLocalPermanentPath('u1', HASH, '')).toBe(`/backups/u1/${HASH}`);
    expect(buildLocalPermanentPath('u1', HASH, '.xyz')).toBe(`/backups/u1/${HASH}.xyz`);
    expect(buildLocalPermanentPath('u1', HASH, '.CR3')).toBe(`/backups/u1/${HASH}.cr3`);
    expect(buildLocalThumbnailPath('u1', HASH, 128)).toBe(`/thumbs/u1/128/${HASH}.jpg`);
    expect(buildLocalThumbnailPath('u1', HASH, '512')).toBe(`/thumbs/u1/512/${HASH}.jpg`);
  });

  it('rejects unsafe user ids, hashes and extensions', () => {
    expect(() => buildLocalPermanentPath('../u1', HASH, '.jpg')).toThrow(PathError);
    expect(() => buildLocalPermanentPath('u/1', HASH, '.jpg')).toThrow(PathError);
    expect(() => buildLocalPermanentPath('u1', 'not-a-hash', '.jpg')).toThrow(PathError);
    expect(() => buildLocalPermanentPath('u1', HASH, 'jpg')).toThrow(PathError);
    expect(() => buildLocalPermanentPath('u1', HASH, '.toolongextt')).toThrow(PathError);
    expect(() => buildLocalPermanentPath('u1', HASH, '.a-b')).toThrow(PathError);
    expect(() => buildLocalThumbnailPath('u1', HASH, 300)).toThrow(PathError);
  });

  it('resolves inside the configured local root', () => {
    const root = path.resolve('D:/StashLibrary');
    expect(resolveLocalPath(root, `/backups/u1/${HASH}.jpg`)).toBe(
      path.resolve(root, 'backups', 'u1', `${HASH}.jpg`),
    );
    expect(resolveLocalPath(root, `/backups/u1/${HASH}`)).toBe(
      path.resolve(root, 'backups', 'u1', HASH),
    );
    expect(resolveLocalPath(root, `/backups/u1/${HASH}.xyz`)).toBe(
      path.resolve(root, 'backups', 'u1', `${HASH}.xyz`),
    );
    expect(resolveLocalPath(root, `/thumbs/u1/256/${HASH}.jpg`)).toBe(
      path.resolve(root, 'thumbs', 'u1', '256', `${HASH}.jpg`),
    );
  });

  it('rejects traversal, unsupported roots and malformed paths', () => {
    const root = path.resolve('D:/StashLibrary');
    expect(() => resolveLocalPath(root, `/backups/u1/${HASH}.jpg/../../evil.jpg`)).toThrow(
      PathError,
    );
    expect(() => resolveLocalPath(root, '/other/u1/file.jpg')).toThrow(PathError);
    expect(() => resolveLocalPath(root, '/backups/u1/not-a-hash.jpg')).toThrow(PathError);
    expect(() => resolveLocalPath(root, `/backups/u1/${HASH}.JPG`)).toThrow(PathError);
    expect(() => resolveLocalPath(root, `/backups/u1/${HASH}.a.b`)).toThrow(PathError);
    expect(() => resolveLocalPath(root, `/backups/u1/${HASH}.`)).toThrow(PathError);
    expect(() => resolveLocalPath(root, `/thumbs/u1/999/${HASH}.jpg`)).toThrow(PathError);
    expect(() => resolveLocalPath(root, `/thumbs/u1/128/${HASH}.png`)).toThrow(PathError);
  });
});

describe('normalized extensions', () => {
  it('normalizes image formats to jpg', () => {
    for (const name of [
      'photo.jpg',
      'photo.JPEG',
      'photo.png',
      'photo.webp',
      'photo.avif',
      'photo.tiff',
      'photo.heic',
      'photo.heif',
      'photo.cr2',
      'photo.cr3',
      'photo.nrw',
      'photo.nef',
      'photo.pef',
      'photo.arw',
      'photo.dng',
      'photo.rwl',
      'photo.sr2',
      'photo.srf',
    ]) {
      expect(normalizedExtension(name)).toBe('.jpg');
    }
  });

  it('normalizes video formats to mp4', () => {
    expect(normalizedExtension('clip.mov')).toBe('.mp4');
    expect(normalizedExtension('clip.MP4')).toBe('.mp4');
    expect(normalizedExtension('clip.quicktime', 'video/quicktime')).toBe('.mp4');
  });

  it('uses the MIME type when the extension is unknown', () => {
    expect(normalizedExtension('blob', 'image/png')).toBe('.jpg');
    expect(normalizedExtension('blob', 'image/heic')).toBe('.jpg');
    expect(normalizedExtension('blob', 'video/mp4')).toBe('.mp4');
  });

  it('passes unknown extensions through lowercased', () => {
    expect(normalizedExtension('notes.TXT')).toBe('.txt');
    expect(normalizedExtension('no-extension')).toBe('');
  });
});

