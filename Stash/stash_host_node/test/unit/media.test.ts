import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyMedia, isImageLike, isVideoLike } from '../../src/media/classify';
import { hashFileStreaming } from '../../src/media/hash';
import { convertToJpeg, generateThumbnail } from '../../src/media/images';
import { generateThumbnails, THUMBNAIL_SIZES } from '../../src/media/thumbnails';

let workDir: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stash-media-test-'));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

async function createImage(file: string, format: 'png' | 'webp' | 'jpeg', width = 64, height = 48) {
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 200, g: 40, b: 90, alpha: 1 },
    },
  })
    .toFormat(format)
    .toFile(file);
}

describe('classifyMedia', () => {
  it('passes JPEG through as image/jpeg', () => {
    expect(classifyMedia('photo.JPG', 'image/jpeg')).toMatchObject({
      kind: 'image',
      targetExtension: '.jpg',
      targetMimeType: 'image/jpeg',
      canThumbnail: true,
    });
  });

  it('maps PNG and WebP to JPEG', () => {
    for (const [name, mime] of [
      ['photo.png', 'image/png'],
      ['photo.webp', 'image/webp'],
      ['photo.avif', 'image/avif'],
      ['photo.tiff', 'image/tiff'],
    ] as const) {
      expect(classifyMedia(name, mime)).toMatchObject({
        kind: 'image',
        targetExtension: '.jpg',
        targetMimeType: 'image/jpeg',
      });
    }
  });

  it('maps HEIC/HEIF to JPEG with the HEIC worker', () => {
    expect(classifyMedia('photo.heic', 'image/heic')).toMatchObject({
      kind: 'heic',
      targetExtension: '.jpg',
      targetMimeType: 'image/jpeg',
      canThumbnail: true,
    });
    expect(classifyMedia('photo.heif', 'image/heif').kind).toBe('heic');
  });

  it('maps RAW formats to JPEG with the RAW worker', () => {
    for (const name of ['a.dng', 'a.cr2', 'a.cr3', 'a.nef', 'a.arw', 'a.rw2', 'a.orf', 'a.raf', 'a.nrw', 'a.pef', 'a.rwl', 'a.sr2', 'a.srf']) {
      expect(classifyMedia(name, 'application/octet-stream').kind).toBe('raw');
    }
  });

  it('maps MOV and MP4 to MP4', () => {
    expect(classifyMedia('clip.mov', 'video/quicktime')).toMatchObject({
      kind: 'video',
      targetExtension: '.mp4',
      targetMimeType: 'video/mp4',
      canThumbnail: true,
    });
    expect(classifyMedia('clip.mp4', 'video/mp4').targetExtension).toBe('.mp4');
  });

  it('passes unsupported files through unchanged', () => {
    expect(classifyMedia('notes.TXT', 'text/plain')).toMatchObject({
      kind: 'unsupported',
      sourceExtension: '.txt',
      targetExtension: '.txt',
      targetMimeType: 'text/plain',
      canThumbnail: false,
    });
  });

  it('prefers safe sniffed content metadata', () => {
    expect(
      classifyMedia('upload', 'application/octet-stream', { ext: 'png', mime: 'image/png' }),
    ).toMatchObject({ kind: 'image', targetExtension: '.jpg' });
  });

  it('exposes image/video helpers', () => {
    expect(isImageLike('image')).toBe(true);
    expect(isImageLike('heic')).toBe(true);
    expect(isImageLike('raw')).toBe(true);
    expect(isImageLike('video')).toBe(false);
    expect(isVideoLike('video')).toBe(true);
    expect(isVideoLike(classifyMedia('clip.mp4', 'video/mp4'))).toBe(true);
  });
});

describe('image conversion', () => {
  it('converts PNG and WebP to JPEG', async () => {
    for (const format of ['png', 'webp'] as const) {
      const source = path.join(workDir, `source.${format}`);
      const output = path.join(workDir, `converted-${format}.jpg`);
      await createImage(source, format);
      await convertToJpeg(source, output, { quality: 80 });
      const metadata = await sharp(output).metadata();
      expect(metadata.format).toBe('jpeg');
      expect(metadata.width).toBe(64);
      expect(metadata.height).toBe(48);
    }
  });

  it('generates square JPEG thumbnails at 128, 256 and 512', async () => {
    const source = path.join(workDir, 'source.jpg');
    await createImage(source, 'jpeg', 1024, 768);

    for (const size of THUMBNAIL_SIZES) {
      const output = path.join(workDir, `thumb-${size}.jpg`);
      const result = await generateThumbnail(source, output, size, 85);
      expect(result).toBe(output);
      const metadata = await sharp(output).metadata();
      expect(metadata.format).toBe('jpeg');
      expect(metadata.width).toBe(size);
      expect(metadata.height).toBe(size);
    }
  });

  it('generates all thumbnails and tolerates video decode failures', async () => {
    const source = path.join(workDir, 'source.jpg');
    await createImage(source, 'jpeg', 800, 600);
    const outDir = path.join(workDir, 'thumbs');
    const generated = await generateThumbnails(source, outDir, { kind: 'image', quality: 85 });
    expect(generated.failures).toHaveLength(0);
    expect(Object.keys(generated.paths)).toHaveLength(3);

    const fakeVideo = path.join(workDir, 'fake.mov');
    await fs.writeFile(fakeVideo, 'not a real video');
    const videoDir = path.join(workDir, 'video-thumbs');
    const videoResult = await generateThumbnails(fakeVideo, videoDir, { kind: 'video' });
    expect(videoResult.failures).toHaveLength(3);
    expect(videoResult.paths).toEqual({});
  });
});

describe('hashFileStreaming', () => {
  it('computes the known SHA-256 for a small file', async () => {
    const file = path.join(workDir, 'hash.txt');
    await fs.writeFile(file, 'hello');
    await expect(hashFileStreaming(file)).resolves.toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});



