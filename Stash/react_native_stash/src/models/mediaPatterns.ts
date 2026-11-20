/** Default media patterns transcribed from Stash.Maui.Data/MediaFilePatterns.cs */
export const defaultIncludePatterns: string[] = [
  '*.jpg',
  '*.jpeg',
  '*.png',
  '*.heic',
  '*.heif',
  '*.raw',
  '*.dng',
  '*.cr2',
  '*.nef',
  '*.arw',
  '*.mov',
  '*.mp4',
  '*.avif',
  '*.webp',
];

export function createDefaultIncludePatterns(): string[] {
  return [...defaultIncludePatterns];
}

/** Extension → MIME mapping used when discovering files (parity with the MAUI scanner). */
const mimeTypesByExtension: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.dng': 'image/x-adobe-dng',
  '.cr2': 'image/x-canon-cr2',
  '.nef': 'image/x-nikon-nef',
  '.arw': 'image/sony-arw',
  '.raw': 'image/x-raw',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
};

export function getMimeType(extension: string): string {
  const normalized = extension.toLowerCase().startsWith('.')
    ? extension.toLowerCase()
    : `.${extension.toLowerCase()}`;
  return mimeTypesByExtension[normalized] ?? 'application/octet-stream';
}

export function getMimeTypeFromFileName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) {
    return 'application/octet-stream';
  }
  return getMimeType(fileName.slice(dot));
}
