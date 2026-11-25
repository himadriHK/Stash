/** Display helpers for dates used across the UI. */

export function formatRelativeTime(value?: string | null): string {
  if (!value) {
    return '—';
  }
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) {
    return '—';
  }
  const diffMs = Math.max(0, Date.now() - time);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) {
    return 'Just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  }
  return new Date(value).toLocaleDateString();
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

