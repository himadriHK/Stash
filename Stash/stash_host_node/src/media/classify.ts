import { fileTypeFromFile } from 'file-type';

export type MediaKind = 'image' | 'heic' | 'raw' | 'video' | 'unsupported';

export interface SniffedType {
  ext: string;
  mime: string;
}

export interface MediaClassification {
  kind: MediaKind;
  sourceExtension: string;
  targetExtension: string;
  targetMimeType: string;
  canThumbnail: boolean;
}

const SAFE_EXTENSION_PATTERN = /^\.[a-z0-9]{1,10}$/;
const SAFE_MIME_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg']);
const IMAGE_EXTENSIONS = new Set(['.png', '.webp', '.avif', '.tif', '.tiff']);
const HEIC_EXTENSIONS = new Set(['.heic', '.heif']);
const RAW_EXTENSIONS = new Set([
  '.raw',
  '.dng',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.rw2',
  '.orf',
  '.raf',
  '.srw',
  '.nrw',
  '.pef',
  '.rwl',
  '.sr2',
  '.srf',
]);
const VIDEO_EXTENSIONS = new Set(['.mov', '.mp4']);

const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/webp',
  'image/avif',
  'image/tiff',
  'image/tif',
]);
const JPEG_MIME_TYPES = new Set(['image/jpeg', 'image/jpg']);
const HEIC_MIME_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);
const RAW_MIME_TYPES = new Set([
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
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime']);

function normalizeExtension(extension: string | null | undefined): string {
  if (!extension) return '';
  const lowered = extension.toLowerCase();
  const withDot = lowered.startsWith('.') ? lowered : `.${lowered}`;
  return SAFE_EXTENSION_PATTERN.test(withDot) ? withDot : '';
}

function fileNameExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot <= 0) return '';
  return normalizeExtension(fileName.slice(lastDot));
}

function normalizeMime(mimeType: string | null | undefined): string {
  const normalized = (mimeType ?? '').trim().toLowerCase();
  return SAFE_MIME_PATTERN.test(normalized) ? normalized : '';
}

/** Reads content sniffing metadata from a file using file-type. */
export async function sniffFileType(filePath: string): Promise<SniffedType | null> {
  try {
    const detected = await fileTypeFromFile(filePath);
    if (!detected) return null;
    return { ext: normalizeExtension(detected.ext), mime: normalizeMime(detected.mime) };
  } catch {
    return null;
  }
}

/**
 * Classifies a source file for conversion/thumbnail decisions. Sniffed
 * content metadata is preferred over the client-provided name/MIME when it is
 * available and safe; the request values remain the fallback.
 */
export function classifyMedia(
  fileName: string,
  mimeType?: string | null,
  sniffed?: SniffedType | null,
): MediaClassification {
  const nameExtension = fileNameExtension(fileName);
  const requestMime = normalizeMime(mimeType);
  const sniffedExtension = normalizeExtension(sniffed?.ext);
  const sniffedMime = normalizeMime(sniffed?.mime);

  const sourceExtension = sniffedExtension || nameExtension;
  const effectiveMime = sniffedMime || requestMime;

  if (JPEG_EXTENSIONS.has(sourceExtension) || JPEG_MIME_TYPES.has(effectiveMime)) {
    return {
      kind: 'image',
      sourceExtension,
      targetExtension: '.jpg',
      targetMimeType: 'image/jpeg',
      canThumbnail: true,
    };
  }

  if (IMAGE_EXTENSIONS.has(sourceExtension) || IMAGE_MIME_TYPES.has(effectiveMime)) {
    return {
      kind: 'image',
      sourceExtension,
      targetExtension: '.jpg',
      targetMimeType: 'image/jpeg',
      canThumbnail: true,
    };
  }

  if (HEIC_EXTENSIONS.has(sourceExtension) || HEIC_MIME_TYPES.has(effectiveMime)) {
    return {
      kind: 'heic',
      sourceExtension,
      targetExtension: '.jpg',
      targetMimeType: 'image/jpeg',
      canThumbnail: true,
    };
  }

  if (RAW_EXTENSIONS.has(sourceExtension) || RAW_MIME_TYPES.has(effectiveMime)) {
    return {
      kind: 'raw',
      sourceExtension,
      targetExtension: '.jpg',
      targetMimeType: 'image/jpeg',
      canThumbnail: true,
    };
  }

  if (VIDEO_EXTENSIONS.has(sourceExtension) || VIDEO_MIME_TYPES.has(effectiveMime)) {
    return {
      kind: 'video',
      sourceExtension,
      targetExtension: '.mp4',
      targetMimeType: 'video/mp4',
      canThumbnail: true,
    };
  }

  return {
    kind: 'unsupported',
    sourceExtension: nameExtension,
    targetExtension: nameExtension,
    targetMimeType: requestMime,
    canThumbnail: false,
  };
}

function resolveKind(value: MediaKind | MediaClassification): MediaKind {
  return typeof value === 'string' ? value : value.kind;
}

export function isImageLike(value: MediaKind | MediaClassification): boolean {
  const kind = resolveKind(value);
  return kind === 'image' || kind === 'heic' || kind === 'raw';
}

export function isVideoLike(value: MediaKind | MediaClassification): boolean {
  return resolveKind(value) === 'video';
}


