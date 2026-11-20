/**
 * UploadStatus enum transcribed from Stash.Maui.Data/Entities/UploadStatus.cs
 * plus the displayName/statusColor contract documented in the UI docs.
 */

export enum UploadStatus {
  Pending = 'Pending',
  Scanning = 'Scanning',
  Hashing = 'Hashing',
  Uploading = 'Uploading',
  Uploaded = 'Uploaded',
  Processing = 'Processing',
  Completed = 'Completed',
  Failed = 'Failed',
  Retrying = 'Retrying',
  Deduplicated = 'Deduplicated',
}

export const uploadStatusDisplayNames: Record<UploadStatus, string> = {
  [UploadStatus.Pending]: 'Pending',
  [UploadStatus.Scanning]: 'Scanning',
  [UploadStatus.Hashing]: 'Hashing',
  [UploadStatus.Uploading]: 'Uploading',
  [UploadStatus.Uploaded]: 'Uploaded',
  [UploadStatus.Processing]: 'Processing',
  [UploadStatus.Completed]: 'Completed',
  [UploadStatus.Failed]: 'Failed',
  [UploadStatus.Retrying]: 'Retrying',
  [UploadStatus.Deduplicated]: 'Deduplicated',
};

export const uploadStatusColors: Record<UploadStatus, string> = {
  [UploadStatus.Pending]: '#9E9E9E',
  [UploadStatus.Scanning]: '#2196F3',
  [UploadStatus.Hashing]: '#FF9800',
  [UploadStatus.Uploading]: '#9C27B0',
  [UploadStatus.Uploaded]: '#4CAF50',
  [UploadStatus.Processing]: '#3F51B5',
  [UploadStatus.Completed]: '#009688',
  [UploadStatus.Failed]: '#F44336',
  [UploadStatus.Retrying]: '#FF9800',
  [UploadStatus.Deduplicated]: '#9E9E9E',
};

export function uploadStatusDisplayName(status: UploadStatus): string {
  return uploadStatusDisplayNames[status] ?? String(status);
}

export function uploadStatusColor(status: UploadStatus): string {
  return uploadStatusColors[status] ?? '#9E9E9E';
}

export function parseUploadStatus(value: string): UploadStatus {
  const match = Object.values(UploadStatus).find((status) => status === value);
  return match ?? UploadStatus.Pending;
}

/** Ionicons name shown on the file status chip, per the documented mapping. */
export function uploadStatusIcon(status: UploadStatus): string {
  switch (status) {
    case UploadStatus.Pending:
      return 'time-outline';
    case UploadStatus.Uploading:
      return 'cloud-upload-outline';
    case UploadStatus.Uploaded:
      return 'checkmark-circle-outline';
    case UploadStatus.Failed:
      return 'alert-circle-outline';
    case UploadStatus.Retrying:
      return 'refresh-outline';
    case UploadStatus.Completed:
      return 'checkmark-done-outline';
    case UploadStatus.Processing:
      return 'cog-outline';
    case UploadStatus.Scanning:
      return 'search-outline';
    case UploadStatus.Hashing:
      return 'finger-print-outline';
    case UploadStatus.Deduplicated:
      return 'copy-outline';
    default:
      return 'document-outline';
  }
}
