/**
 * Notification Center feed.
 *
 * The app has no separate inbox table: notifications are a read-only view over
 * the newest `files` rows, classified by their current upload/processing
 * status. This keeps the feed truthful (no mock entries) and avoids a schema
 * change. Folder-discovery events are not represented.
 */
import type { FileEntity } from '../models/fileEntity';
import { UploadStatus } from '../models/uploadStatus';
import { formatFileSize } from '../utils/format';

export type NotificationKind = 'synced' | 'uploading' | 'failed' | 'pending';
export type NotificationFilter = 'all' | 'uploads' | 'errors' | 'synced';

export interface NotificationItem {
  id: string;
  file: FileEntity;
  kind: NotificationKind;
  title: string;
  subtitle: string;
  createdAt: string;
}

const TITLES: Record<NotificationKind, string> = {
  synced: 'Backup completed',
  uploading: 'Upload in progress',
  failed: 'Upload failed',
  pending: 'Waiting to upload',
};

/** Maps an upload status to the mockup's four notification classes. */
export function classifyStatus(status: UploadStatus): NotificationKind {
  switch (status) {
    case UploadStatus.Completed:
    case UploadStatus.Deduplicated:
      return 'synced';
    case UploadStatus.Failed:
      return 'failed';
    case UploadStatus.Uploading:
    case UploadStatus.Processing:
    case UploadStatus.Uploaded:
    case UploadStatus.Retrying:
      return 'uploading';
    default:
      return 'pending';
  }
}

function titleFor(file: FileEntity, kind: NotificationKind): string {
  if (kind === 'synced' && file.status === UploadStatus.Deduplicated) {
    return 'Already backed up';
  }
  if (kind === 'uploading' && file.status === UploadStatus.Uploaded) {
    return 'Uploaded, awaiting host';
  }
  if (kind === 'uploading' && file.status === UploadStatus.Processing) {
    return 'Processing on host';
  }
  if (kind === 'uploading' && file.status === UploadStatus.Retrying) {
    return 'Retrying upload';
  }
  return TITLES[kind];
}

function timestampFor(file: FileEntity): string {
  return (
    file.lastResponseAt ??
    file.updatedAt ??
    file.lastAttemptAt ??
    file.processingStartedAt ??
    file.uploadStartedAt ??
    file.discoveredAt
  );
}

export function buildNotificationItems(files: FileEntity[]): NotificationItem[] {
  return files.map((file) => {
    const kind = classifyStatus(file.status);
    const detail =
      kind === 'failed' && file.errorMessage
        ? ` · ${file.errorMessage}`
        : '';
    return {
      id: file.id,
      file,
      kind,
      title: titleFor(file, kind),
      subtitle: `${file.fileName} · ${formatFileSize(file.fileSize)}${detail}`,
      createdAt: timestampFor(file),
    };
  });
}

export function filterNotificationItems(
  items: NotificationItem[],
  filter: NotificationFilter,
): NotificationItem[] {
  switch (filter) {
    case 'uploads':
      return items.filter((item) => item.kind === 'uploading' || item.kind === 'pending');
    case 'errors':
      return items.filter((item) => item.kind === 'failed');
    case 'synced':
      return items.filter((item) => item.kind === 'synced');
    default:
      return items;
  }
}

export const notificationFilters: { value: NotificationFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'uploads', label: 'Uploads' },
  { value: 'errors', label: 'Errors' },
  { value: 'synced', label: 'Synced' },
];

export const emptyCopy: Record<NotificationFilter, { title: string; subtitle: string }> = {
  all: {
    title: 'No notifications yet',
    subtitle: 'Upload and backup activity will appear here.',
  },
  uploads: {
    title: 'No pending uploads',
    subtitle: 'Files waiting to upload or currently uploading will appear here.',
  },
  errors: {
    title: 'No errors',
    subtitle: 'Failed uploads will appear here with their reason.',
  },
  synced: {
    title: 'Nothing synced yet',
    subtitle: 'Completed backups will appear here.',
  },
};
