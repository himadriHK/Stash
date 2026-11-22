export class ApiError extends Error {
  status;
  code;
  fields;

  constructor(message, { status = 0, code = 'request_failed', fields = {} } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields && typeof fields === 'object' ? fields : {};
  }
}

export async function fetchJson(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (!headers.has('accept')) headers.set('accept', 'application/json');

  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers,
      credentials: options.credentials ?? 'same-origin',
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiError('Unable to reach the server.', { code: 'network_error' });
  }

  if (!response.ok) {
    let envelope = null;
    try {
      envelope = await response.json();
    } catch {
      envelope = null;
    }

    const apiError =
      envelope && typeof envelope === 'object' && envelope.error && typeof envelope.error === 'object'
        ? envelope.error
        : null;
    const code = response.status === 401 ? 'unauthorized' : apiError?.code || 'request_failed';
    const message =
      (apiError && typeof apiError.message === 'string' && apiError.message.trim()) ||
      response.statusText ||
      `Request failed with status ${response.status}.`;
    const fields =
      apiError && apiError.fields && typeof apiError.fields === 'object' ? apiError.fields : {};

    throw new ApiError(message, { status: response.status, code, fields });
  }

  if (response.status === 204) return null;

  try {
    return await response.json();
  } catch {
    throw new ApiError('The server returned an invalid JSON response.', {
      status: response.status,
      code: 'invalid_response',
    });
  }
}

export function qs(selector, root = document) {
  return root.querySelector(selector);
}

export function qsa(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function escapeHtml(value) {
  const entities = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return String(value ?? '').replace(/[&<>"']/g, (character) => entities[character]);
}

export function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return number.toLocaleString();
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || bytes === '') return '—';
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '0 B';

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let index = 0;
  let scaled = value;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }

  if (index === 0) return `${Math.round(scaled)} B`;
  const rounded = scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1);
  return `${rounded.replace(/\.0$/, '')} ${units[index]}`;
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined || ms === '') return '—';
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
  if (value < 3600000) {
    const minutes = Math.floor(value / 60000);
    const seconds = Math.floor((value % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(value / 3600000);
  const minutes = Math.floor((value % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
}

export function formatPercent(ratio) {
  if (ratio === null || ratio === undefined || ratio === '') return '—';
  const value = Number(ratio);
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

export function formatUptime(seconds) {
  if (seconds === null || seconds === undefined || seconds === '') return '—';
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '—';
  const total = Math.floor(value);
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m`;
  if (total < 86400) {
    return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
  }
  return `${Math.floor(total / 86400)}d ${Math.floor((total % 86400) / 3600)}h`;
}

export function formatDateTime(iso) {
  if (iso === null || iso === undefined || iso === '') return '—';
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export function relativeTime(iso) {
  if (iso === null || iso === undefined || iso === '') return '—';
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const elapsed = Date.now() - date.getTime();
  if (!Number.isFinite(elapsed) || elapsed < 60000) return 'just now';
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDateTime(date);
}

export function statusTone(status) {
  const value = String(status ?? '').trim().toLowerCase();
  if (
    [
      'ok',
      'up',
      'healthy',
      'online',
      'completed',
      'complete',
      'done',
      'success',
      'succeeded',
      'sent',
      'ready',
      'active',
    ].includes(value)
  ) {
    return 'ok';
  }
  if (
    ['degraded', 'warn', 'warning', 'queued', 'pending', 'stale', 'partial', 'retry', 'retrying'].includes(
      value,
    )
  ) {
    return 'warn';
  }
  if (
    [
      'down',
      'failed',
      'failure',
      'error',
      'dead',
      'unhealthy',
      'offline',
      'critical',
      'fatal',
      'bad',
      'danger',
    ].includes(value)
  ) {
    return 'danger';
  }
  if (['running', 'processing', 'in-progress', 'sending', 'info'].includes(value)) {
    return 'info';
  }
  return 'muted';
}

export function statusLabel(status) {
  const value = String(status ?? '').trim();
  if (!value) return 'Unknown';

  const labels = new Map([
    ['ok', 'Healthy'],
    ['up', 'Up'],
    ['healthy', 'Healthy'],
    ['degraded', 'Degraded'],
    ['warn', 'Warning'],
    ['warning', 'Warning'],
    ['down', 'Down'],
    ['unknown', 'Unknown'],
    ['queued', 'Queued'],
    ['running', 'Running'],
    ['completed', 'Completed'],
    ['complete', 'Completed'],
    ['success', 'Succeeded'],
    ['succeeded', 'Succeeded'],
    ['failed', 'Failed'],
    ['failure', 'Failed'],
    ['error', 'Error'],
    ['cancelled', 'Cancelled'],
    ['canceled', 'Cancelled'],
    ['retrying', 'Retrying'],
    ['pending', 'Pending'],
    ['sending', 'Sending'],
    ['sent', 'Sent'],
    ['dead', 'Dead letter'],
    ['stale', 'Stale'],
    ['skipped', 'Skipped'],
    ['deduplicated', 'Deduplicated'],
  ]);

  const known = labels.get(value.toLowerCase());
  if (known) return known;

  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function showToast(message, tone = 'info', timeout = 4000) {
  const toastTones = {
    ok: 'toast--success',
    success: 'toast--success',
    info: 'toast--info',
    warn: 'toast--warn',
    warning: 'toast--warn',
    danger: 'toast--error',
    error: 'toast--error',
    muted: 'toast--info',
  };
  const requested = String(tone ?? 'info').trim().toLowerCase();
  const safeTone = toastTones[requested] ? requested : 'info';

  let region = qs('#toast-region');
  if (!region) {
    region = document.createElement('div');
    region.id = 'toast-region';
    region.className = 'toast-region';
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'false');
    document.body.append(region);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${toastTones[safeTone]}`;
  toast.dataset.tone = safeTone;

  const text = document.createElement('p');
  text.className = 'toast__message';
  text.textContent = String(message ?? '');

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'btn btn--ghost btn--sm btn--icon toast__dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss notification');
  dismiss.textContent = '×';

  let timer = null;
  const remove = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    toast.remove();
  };

  dismiss.addEventListener('click', remove);
  toast.append(text, dismiss);
  region.append(toast);

  if (Number.isFinite(timeout) && timeout > 0) {
    timer = window.setTimeout(remove, timeout);
  }

  return toast;
}

export function debounce(fn, ms) {
  let timer = null;
  const wait = Number.isFinite(Number(ms)) && Number(ms) > 0 ? Number(ms) : 0;

  function debounced(...args) {
    if (timer !== null) clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, wait);
  }

  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return debounced;
}
