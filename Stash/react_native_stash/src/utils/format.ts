/** Display helpers for file sizes and dates used across the UI. */

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(1)} MB`;
  }
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function formatBytesAsMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

export function formatDate(value?: string | null): string {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleString();
}

/** Converts a unix timestamp (seconds, as returned by FileInfo) to ISO. */
export function unixSecondsToIso(seconds?: number | null): string {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds)) {
    return new Date().toISOString();
  }
  // Modification times are seconds since epoch; tolerate milliseconds too.
  const millis = seconds > 1e12 ? seconds : seconds * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}
