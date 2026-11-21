import path from 'node:path';

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const THUMBNAIL_SIZE_PATTERN = /^(128|256|512)$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const SAFE_EXTENSION_PATTERN = /^\.[a-z0-9]{1,10}$/;

const JPEG_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.avif',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
  '.raw',
  '.cr2',
  '.cr3',
  '.nef',
  '.nrw',
  '.arw',
  '.dng',
  '.rw2',
  '.orf',
  '.pef',
  '.raf',
  '.rwl',
  '.sr2',
  '.srf',
  '.srw',
]);

const MP4_EXTENSIONS = new Set(['.mov', '.mp4']);

const JPEG_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/tiff',
  'image/heic',
  'image/heif',
  'image/x-raw',
  'image/x-canon-cr2',
  'image/x-canon-cr3',
  'image/x-nikon-nef',
  'image/x-sony-arw',
  'image/x-adobe-dng',
  'image/x-panasonic-rw2',
  'image/x-olympus-orf',
  'image/x-pentax-pef',
  'image/x-fuji-raf',
  'image/x-samsung-srw',
]);

const MP4_MIME_TYPES = new Set(['video/mp4', 'video/quicktime']);

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

export function isSha256Hex(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

export function assertSafeHash(value: string): string {
  if (!isSha256Hex(value)) {
    throw new PathError('Hash must be a 64-character SHA-256 hex value');
  }
  return value.toLowerCase();
}

export function assertSafeUserSegment(value: string): string {
  if (
    !SAFE_SEGMENT_PATTERN.test(value) ||
    value === '.' ||
    value === '..' ||
    value.includes(':') ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new PathError('User id must be a single safe path segment');
  }
  return value;
}

function assertSafePrefix(prefix: string): string[] {
  const normalized = prefix.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (normalized === '') return [];
  if (normalized.includes('\\')) {
    throw new PathError('S3 prefix must use forward slashes');
  }
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || CONTROL_CHARACTER_PATTERN.test(segment)) {
      throw new PathError('S3 prefix contains an unsafe segment');
    }
  }
  return segments;
}

function assertLogicalSegments(logicalPath: string): string[] {
  if (typeof logicalPath !== 'string' || !logicalPath.startsWith('/')) {
    throw new PathError('Logical path must start with a forward slash');
  }
  if (logicalPath.includes('\\')) {
    throw new PathError('Logical path must use forward slashes');
  }

  const segments = logicalPath.split('/').slice(1);
  if (segments.length === 0) {
    throw new PathError('Logical path must contain at least one segment');
  }

  for (const segment of segments) {
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.includes(':') ||
      CONTROL_CHARACTER_PATTERN.test(segment)
    ) {
      throw new PathError('Logical path contains an unsafe segment');
    }
  }

  return segments;
}

/** Maps a logical app path onto an S3 object key using the configured prefix. */
export function buildS3Key(logicalPath: string, prefix: string): string {
  const logicalSegments = assertLogicalSegments(logicalPath);
  const prefixSegments = assertSafePrefix(prefix);
  return [...prefixSegments, ...logicalSegments].join('/');
}

export const toS3Key = buildS3Key;

function normalizePermanentExtension(extension: string): string {
  if (extension === '') return '';
  const normalized = extension.toLowerCase();
  if (!SAFE_EXTENSION_PATTERN.test(normalized)) {
    throw new PathError('Permanent path extension must be empty or a single safe extension');
  }
  return normalized;
}

/**
 * Canonical logical permanent path: /backups/{userId}/{hash}{extension}.
 * Pass-through files may use an empty extension or a 1-10 character
 * lowercase alphanumeric extension.
 */
export function buildLocalPermanentPath(userId: string, hash: string, extension: string): string {
  const safeUser = assertSafeUserSegment(userId);
  const safeHash = assertSafeHash(hash);
  return `/backups/${safeUser}/${safeHash}${normalizePermanentExtension(extension)}`;
}

/** Canonical logical thumbnail path: /thumbs/{userId}/{size}/{hash}.jpg. */
export function buildLocalThumbnailPath(userId: string, hash: string, size: number | string): string {
  const safeUser = assertSafeUserSegment(userId);
  const safeHash = assertSafeHash(hash);
  const normalizedSize = String(size);
  if (!THUMBNAIL_SIZE_PATTERN.test(normalizedSize)) {
    throw new PathError('Thumbnail size must be one of 128, 256, 512');
  }
  return `/thumbs/${safeUser}/${normalizedSize}/${safeHash}.jpg`;
}

function assertPermanentFileName(fileName: string): void {
  const hash = fileName.slice(0, 64);
  const suffix = fileName.slice(64);
  if (!isSha256Hex(hash) || !(suffix === '' || SAFE_EXTENSION_PATTERN.test(suffix))) {
    throw new PathError(
      'Permanent path must end with a SHA-256 hash and an optional 1-10 character lowercase extension',
    );
  }
}

/**
 * Resolves a logical library path below the configured local root. Permanent
 * files may use a safe pass-through extension or no extension; thumbnails are
 * strictly JPEG. The resolved path must stay strictly inside the root.
 */
export function resolveLocalPath(rootPath: string, logicalPath: string): string {
  const root = path.resolve(rootPath);
  const segments = assertLogicalSegments(logicalPath);
  const [topLevel, userId, third, fourth] = segments;

  if (topLevel === 'backups') {
    if (segments.length !== 3 || !userId || !third) {
      throw new PathError('Permanent path must be /backups/{userId}/{hash}[.ext]');
    }
    assertSafeUserSegment(userId);
    assertPermanentFileName(third);
  } else if (topLevel === 'thumbs') {
    if (segments.length !== 4 || !userId || !third || !fourth) {
      throw new PathError('Thumbnail path must be /thumbs/{userId}/{size}/{hash}.jpg');
    }
    assertSafeUserSegment(userId);
    if (!THUMBNAIL_SIZE_PATTERN.test(third)) {
      throw new PathError('Thumbnail size must be one of 128, 256, 512');
    }
    if (!/^[0-9a-f]{64}\.jpg$/i.test(fourth)) {
      throw new PathError('Thumbnail path must end with a SHA-256 hash and .jpg');
    }
  } else {
    throw new PathError('Only /backups and /thumbs logical paths are allowed');
  }

  const resolved = path.resolve(root, ...segments);
  const expectedPrefix = `${root}${path.sep}`;
  if (!resolved.startsWith(expectedPrefix)) {
    throw new PathError('Resolved path escapes the local root');
  }
  return resolved;
}

export function resolveLocalPermanentPath(
  rootPath: string,
  userId: string,
  hash: string,
  extension: string,
): string {
  return resolveLocalPath(rootPath, buildLocalPermanentPath(userId, hash, extension));
}

export function resolveLocalThumbnailPath(
  rootPath: string,
  userId: string,
  hash: string,
  size: number | string,
): string {
  return resolveLocalPath(rootPath, buildLocalThumbnailPath(userId, hash, size));
}

/** Returns the canonical permanent extension for a source file/MIME pair. */
export function normalizedExtension(fileName: string, mimeType?: string | null): string {
  const lastDot = fileName.lastIndexOf('.');
  const extension = lastDot > 0 ? fileName.slice(lastDot).toLowerCase() : '';

  if (JPEG_EXTENSIONS.has(extension)) return '.jpg';
  if (MP4_EXTENSIONS.has(extension)) return '.mp4';

  const mime = (mimeType ?? '').trim().toLowerCase();
  if (JPEG_MIME_TYPES.has(mime)) return '.jpg';
  if (MP4_MIME_TYPES.has(mime)) return '.mp4';

  return extension;
}
