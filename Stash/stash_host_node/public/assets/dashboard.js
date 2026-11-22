import {
  fetchJson,
  qs,
  qsa,
  escapeHtml,
  formatNumber,
  formatBytes,
  formatDuration,
  formatPercent,
  formatUptime,
  formatDateTime,
  relativeTime,
  statusTone,
  statusLabel,
  showToast,
} from './shared.js';

const DASHBOARD_ENDPOINT = '/api/dashboard';
const STREAM_ENDPOINT = '/api/dashboard/stream';
const FALLBACK_POLL_INTERVAL_MS = 5000;
const CLOCK_INTERVAL_MS = 5000;
const RECONNECT_DELAY_MS = 10000;
const STALE_AFTER_MS = 30000;
const EVENT_MESSAGE_LIMIT = 180;
const LOADING_ATTRIBUTE = 'data-loading';
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
const AUTH_MESSAGE = 'Authentication required — reload the page to sign in.';
const GENERIC_ERROR_MESSAGE = 'Unable to load dashboard data. Check the host service and try again.';
const TONE_VALUES = 'ok|warn|danger|info|muted|bad|neutral|success|warning|error|unknown';
const TONE_MODIFIER_PATTERN = new RegExp(
  `^(?:status-pill|hero-status|badge|dot|timeline__dot|progress|chip)--(?:${TONE_VALUES})$`,
);
const TONE_FALLBACK_PATTERN = new RegExp(`^(?:tone-|status--)(?:${TONE_VALUES})$`);
const TONE_MAP = {
  ok: 'ok',
  success: 'ok',
  healthy: 'ok',
  up: 'ok',
  online: 'ok',
  completed: 'ok',
  complete: 'ok',
  done: 'ok',
  active: 'ok',
  warn: 'warn',
  warning: 'warn',
  degraded: 'warn',
  queued: 'warn',
  pending: 'warn',
  stale: 'warn',
  retry: 'warn',
  partial: 'warn',
  danger: 'danger',
  bad: 'danger',
  error: 'danger',
  failed: 'danger',
  failure: 'danger',
  down: 'danger',
  offline: 'danger',
  critical: 'danger',
  fatal: 'danger',
  info: 'info',
  running: 'info',
  processing: 'info',
  'in-progress': 'info',
  muted: 'muted',
  neutral: 'muted',
  unknown: 'muted',
  skipped: 'muted',
  cancelled: 'muted',
  canceled: 'muted',
};

const loadingTargets = [];

let initialized = false;
let timersStarted = false;
let isFetching = false;
let lastSuccessAt = 0;
let toastShownForFailure = false;
let percentUsesFraction = null;
let stream = null;
let streamConnected = false;
let fallbackTimer = null;
let reconnectTimer = null;
let clockTimer = null;
let visibilityBound = false;

function one(selector, root) {
  try {
    return (root ? qs(selector, root) : qs(selector)) || null;
  } catch {
    try {
      return qs(selector) || null;
    } catch {
      return null;
    }
  }
}

function all(selector, root) {
  try {
    const result = root ? qsa(selector, root) : qsa(selector);
    return Array.from(result || []);
  } catch {
    try {
      return Array.from(qsa(selector) || []);
    } catch {
      return [];
    }
  }
}

function setText(target, value) {
  const element = typeof target === 'string' ? one(target) : target;
  if (!element) return null;
  element.textContent = value === null || value === undefined ? '' : String(value);
  return element;
}

function setHidden(target, value) {
  const element = typeof target === 'string' ? one(target) : target;
  if (!element) return;
  element.hidden = Boolean(value);
  if (value) {
    element.setAttribute('hidden', '');
  } else {
    element.removeAttribute('hidden');
  }
}

function callHelper(helper, args, fallback) {
  try {
    const value = helper(...args);
    if (value === null || value === undefined || value === '') return fallback;
    return value;
  } catch {
    return fallback;
  }
}

function toNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function numberOr(...values) {
  for (const value of values) {
    const number = toNumber(value);
    if (number !== null) return number;
  }
  return 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentClass(prefix, value) {
  const clamped = Math.round(Math.min(100, Math.max(0, Number(value) || 0)));
  return `${prefix}-${clamped}`;
}

function setPercentClass(element, prefix, value) {
  if (!element) return;
  for (const className of Array.from(element.classList)) {
    if (/^[wh]-\d+$/.test(className)) {
      element.classList.remove(className);
    }
  }
  element.classList.add(percentClass(prefix, value));
}

function fallbackBytes(value) {
  let size = Math.max(0, value);
  let unit = 0;
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : size < 10 ? 2 : size < 100 ? 1 : 0;
  return `${Number(size.toFixed(digits))} ${BYTE_UNITS[unit]}`;
}

function fallbackDuration(milliseconds) {
  const value = Math.max(0, milliseconds);
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${Number(seconds.toFixed(seconds < 10 ? 1 : 0))} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Number(minutes.toFixed(minutes < 10 ? 1 : 0))} min`;
  const hours = minutes / 60;
  if (hours < 24) return `${Number(hours.toFixed(hours < 10 ? 1 : 0))} h`;
  return `${Number((hours / 24).toFixed(1))} d`;
}

function fallbackUptime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!parts.length) parts.push(`${remaining}s`);
  return parts.slice(0, 2).join(' ');
}

function fallbackPercent(percent, digits = 1) {
  return `${Number(percent.toFixed(digits))}%`;
}

function usesFractionPercent() {
  if (percentUsesFraction === null) {
    const sample = callHelper(formatPercent, [1], null);
    percentUsesFraction = sample !== null && /100/.test(String(sample));
  }
  return percentUsesFraction;
}

function fmtNumber(value, fallback = '—') {
  const number = toNumber(value);
  if (number === null) return fallback;
  return String(callHelper(formatNumber, [number], number.toLocaleString()));
}

function fmtBytes(value, fallback = '—') {
  const number = toNumber(value);
  if (number === null) return fallback;
  return String(callHelper(formatBytes, [number], fallbackBytes(number)));
}

function fmtDuration(value, fallback = '—') {
  const number = toNumber(value);
  if (number === null) return fallback;
  return String(callHelper(formatDuration, [number], fallbackDuration(number)));
}

function fmtUptime(value, fallback = '—') {
  const number = toNumber(value);
  if (number === null) return fallback;
  return String(callHelper(formatUptime, [number], fallbackUptime(number)));
}

function fmtPercent(ratio, digits = 1) {
  const number = toNumber(ratio);
  if (number === null) return '—';
  const percent = number * 100;
  const fallback = fallbackPercent(percent, digits);
  const input = usesFractionPercent() ? number : percent;
  return String(callHelper(formatPercent, [input], fallback));
}

function toDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function fallbackDateTime(date) {
  try {
    return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return date.toISOString();
  }
}

function fallbackRelative(value) {
  if (!value) return '—';
  const delta = Date.now() - value.getTime();
  const magnitude = Math.abs(delta);
  const suffix = delta >= 0 ? 'ago' : 'from now';
  if (magnitude < 5000) return 'just now';
  if (magnitude < 60000) return `${Math.floor(magnitude / 1000)}s ${suffix}`;
  if (magnitude < 3600000) return `${Math.floor(magnitude / 60000)}m ${suffix}`;
  if (magnitude < 86400000) return `${Math.floor(magnitude / 3600000)}h ${suffix}`;
  if (magnitude < 604800000) return `${Math.floor(magnitude / 86400000)}d ${suffix}`;
  return fallbackDateTime(value);
}

function fmtDateTime(value, fallback = '—') {
  const date = toDate(value);
  if (!date) return fallback;
  return String(callHelper(formatDateTime, [date], fallbackDateTime(date)));
}

function fmtRelative(value, fallback = '—') {
  const date = toDate(value);
  if (!date) return fallback;
  return String(callHelper(relativeTime, [date], fallbackRelative(date)));
}

function humanize(value, fallback = 'Unknown') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  return text
    .replace(/[_-]+/g, ' ')
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function labelFor(status) {
  const label = callHelper(statusLabel, [status], null);
  if (typeof label === 'string' && label.trim() !== '') return label;
  return humanize(status);
}

function normalizeTone(value) {
  const token = String(value === null || value === undefined ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return token || 'muted';
}

function fallbackTone(status) {
  const text = String(status === null || status === undefined ? '' : status).toLowerCase();
  if (/(^|\b)(ok|success|healthy|up|online|completed?|done|passed|active)(\b|$)/.test(text)) return 'ok';
  if (/(warn|degrad|pending|queued|stale|retry|partial)/.test(text)) return 'warn';
  if (/(fail|error|down|offline|critical|bad|danger)/.test(text)) return 'danger';
  if (/(run|process|info|progress)/.test(text)) return 'info';
  return 'muted';
}

function cssTone(status) {
  const helperTone = callHelper(statusTone, [status], null);
  const raw = typeof helperTone === 'string' ? helperTone : fallbackTone(status);
  const token = normalizeTone(raw);
  return TONE_MAP[token] || 'muted';
}

function clearToneClasses(element) {
  for (const className of Array.from(element.classList)) {
    if (TONE_MODIFIER_PATTERN.test(className) || TONE_FALLBACK_PATTERN.test(className)) {
      element.classList.remove(className);
    }
  }
}

function applyTone(element, status) {
  const target = typeof element === 'string' ? one(element) : element;
  if (!target) return;
  const tone = cssTone(status);
  clearToneClasses(target);
  target.classList.add(`tone-${tone}`, `status--${tone}`);
  if (target.classList.contains('status-pill')) {
    target.classList.add(`status-pill--${tone}`);
  } else if (target.classList.contains('badge')) {
    target.classList.add(`badge--${tone}`);
  } else if (target.classList.contains('timeline__dot')) {
    target.classList.add(`timeline__dot--${tone}`);
  } else if (target.classList.contains('dot')) {
    target.classList.add(`dot--${tone}`);
  } else if (target.classList.contains('progress')) {
    target.classList.add(`progress--${tone}`);
  } else if (target.classList.contains('chip')) {
    target.classList.add(`chip--${tone}`);
  }
  if (target.id === 'service-status') {
    target.classList.add('status-pill', `status-pill--${tone}`);
  }
  if (target.id === 'hero-status') {
    target.classList.add('hero-status', `hero-status--${tone}`);
  }
  target.dataset.tone = tone;
}


function setEnabledState(element, enabled) {
  if (!element) return;
  element.dataset.state = enabled ? 'enabled' : 'disabled';
  element.classList.toggle('is-enabled', enabled);
  element.classList.toggle('is-disabled', !enabled);
}

function versionLabel(version) {
  const text = String(version === null || version === undefined ? '' : version).trim();
  if (!text) return '—';
  return /^v/i.test(text) ? text : `v${text}`;
}

function truncateText(value, limit) {
  const text = String(value === null || value === undefined ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function setKpi(id, value, hint) {
  const valueElement = one(`#${id}`);
  if (valueElement) {
    valueElement.textContent = value === null || value === undefined ? '—' : String(value);
  }
  const card = valueElement
    ? valueElement.closest('[data-kpi]') ||
      valueElement.closest('.kpi') ||
      valueElement.closest('.card') ||
      valueElement.parentElement
    : null;
  const hintElement = card
    ? card.querySelector('[data-kpi-hint], .kpi__hint, .kpi-hint, .stat-hint, .hint')
    : null;
  if (hintElement) {
    hintElement.textContent = hint || '';
  } else if (valueElement && hint) {
    valueElement.setAttribute('data-hint', hint);
    valueElement.title = hint;
  }
}

function renderService(service) {
  if (!service || typeof service !== 'object') return;
  const status = service.status || 'unknown';
  const statusText = labelFor(status);
  const statusPill = one('#service-status');
  if (statusPill) {
    applyTone(statusPill, status);
    const dot = statusPill.querySelector('.dot');
    if (dot) applyTone(dot, status);
    const label = Array.from(statusPill.children).find(
      (child) => child.tagName === 'SPAN' && !child.classList.contains('dot'),
    );
    if (label) {
      label.textContent = statusText;
    } else if (dot) {
      const labelSpan = document.createElement('span');
      labelSpan.textContent = statusText;
      statusPill.append(labelSpan);
    } else {
      statusPill.textContent = statusText;
    }
  }
  setText('#service-env', service.environment || '—');
  setText('#service-version', versionLabel(service.version));
  setText('#footer-version', versionLabel(service.version));
  const heroStatus = one('#hero-status');
  setText(heroStatus, statusText);
  applyTone(heroStatus, status);
  setText('#hero-uptime', fmtUptime(service.uptimeSeconds));
}


function renderKpis(jobs) {
  const data = jobs && typeof jobs === 'object' ? jobs : {};
  const byStatus = data.byStatus && typeof data.byStatus === 'object' ? data.byStatus : {};
  const bytes = data.bytes && typeof data.bytes === 'object' ? data.bytes : {};
  const total = numberOr(data.total);
  const completed = numberOr(byStatus.completed);
  const failed = numberOr(byStatus.failed);
  const queued = numberOr(data.queued, byStatus.queued);
  const running = numberOr(data.running, byStatus.running);
  const uniqueFiles = numberOr(data.uniqueFiles);
  const deduplicated = numberOr(data.deduplicated);
  const declared = numberOr(bytes.declared);
  const downloaded = numberOr(bytes.downloaded);
  const failureRate = numberOr(data.failureRate);

  setKpi('kpi-total', fmtNumber(total), `${fmtNumber(uniqueFiles)} unique files`);
  setKpi(
    'kpi-completed',
    fmtNumber(completed),
    total > 0 ? `${fmtPercent(completed / total)} of jobs` : 'No jobs yet',
  );
  setKpi('kpi-failed', fmtNumber(failed), `${fmtPercent(failureRate)} failure rate`);
  setKpi(
    'kpi-active',
    fmtNumber(queued + running),
    `+${fmtNumber(queued)} queued · +${fmtNumber(running)} running`,
  );
  setKpi('kpi-bytes', fmtBytes(downloaded), `of ${fmtBytes(declared)} declared`);
  setKpi('kpi-files', fmtNumber(uniqueFiles), `${fmtNumber(deduplicated)} deduplicated`);
}

function bucketTime(value) {
  const date = toDate(value);
  if (!date) return '—';
  try {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return fallbackDateTime(date);
  }
}

function renderActivity(activity) {
  const buckets = Array.isArray(activity) ? activity.slice(-24) : [];
  while (buckets.length < 24) {
    buckets.push({ bucket: '', completed: 0, failed: 0 });
  }

  let completed = 0;
  let failed = 0;
  let peak = 0;
  for (const bucket of buckets) {
    const bucketCompleted = numberOr(bucket && bucket.completed);
    const bucketFailed = numberOr(bucket && bucket.failed);
    completed += bucketCompleted;
    failed += bucketFailed;
    peak = Math.max(peak, bucketCompleted + bucketFailed);
  }

  const summaryText =
    peak === 0
      ? 'No activity in the last 24 hours'
      : `${fmtNumber(completed)} completed · ${fmtNumber(failed)} failed in the last 24 hours`;
  setText('#activity-summary', summaryText);

  const chart = one('#activity-chart');
  if (!chart) return;

  chart.replaceChildren();
  chart.setAttribute('role', 'group');
  chart.setAttribute('aria-label', summaryText);

  if (peak === 0) {
    const baseline = document.createElement('div');
    baseline.className = 'activity-baseline';
    baseline.setAttribute('aria-hidden', 'true');
    const note = document.createElement('p');
    note.className = 'activity-empty';
    note.textContent = 'No activity in the last 24 hours';
    chart.append(baseline, note);
  }

  for (const bucket of buckets) {
    const data = bucket && typeof bucket === 'object' ? bucket : {};
    const bucketCompleted = Math.max(0, numberOr(data.completed));
    const bucketFailed = Math.max(0, numberOr(data.failed));
    const time = bucketTime(data.bucket);
    const fullLabel = `${time} — ${fmtNumber(bucketCompleted)} completed, ${fmtNumber(bucketFailed)} failed`;
    const bar = document.createElement('div');
    bar.className = 'activity-bar';
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', fullLabel);
    bar.title = fullLabel;
    bar.dataset.bucket = data.bucket ? String(data.bucket) : '';
    bar.dataset.completed = String(bucketCompleted);
    bar.dataset.failed = String(bucketFailed);

    const completedBar = document.createElement('span');
    completedBar.className = 'activity-bar__completed';
    completedBar.setAttribute('aria-hidden', 'true');
    setPercentClass(completedBar, 'h', (bucketCompleted / Math.max(1, peak)) * 100);

    const failedBar = document.createElement('span');
    failedBar.className = 'activity-bar__failed';
    failedBar.setAttribute('aria-hidden', 'true');
    setPercentClass(failedBar, 'h', (bucketFailed / Math.max(1, peak)) * 100);

    bar.append(completedBar, failedBar);
    chart.append(bar);
  }
}


function describeKafka(kafka) {
  if (!kafka || kafka.enabled !== true) return 'Disabled';
  if (kafka.connected && kafka.running) return kafka.paused ? 'Paused' : 'Listening';
  if (kafka.connected) return 'Stopped';
  return kafka.lastError ? 'Error' : 'Disconnected';
}

function renderPipeline(jobs, outbox, pipeline) {
  const jobData = jobs && typeof jobs === 'object' ? jobs : {};
  const outboxData = outbox && typeof outbox === 'object' ? outbox : {};
  const processing =
    jobData.processingMs && typeof jobData.processingMs === 'object' ? jobData.processingMs : {};
  const byStatus =
    jobData.byStatus && typeof jobData.byStatus === 'object' ? jobData.byStatus : {};

  setText('#pipeline-queued', fmtNumber(numberOr(jobData.queued, byStatus.queued)));
  setText('#pipeline-running', fmtNumber(numberOr(jobData.running, byStatus.running)));
  setText('#pipeline-stale', fmtNumber(numberOr(jobData.staleLeases)));
  const oldest = jobData.oldestQueuedAt || null;
  const oldestElement = setText('#pipeline-oldest', oldest ? fmtRelative(oldest) : '—');
  if (oldestElement) {
    oldestElement.title = oldest ? fmtDateTime(oldest) : 'No queued jobs';
  }
  const kafka =
    pipeline && pipeline.kafka && typeof pipeline.kafka === 'object' ? pipeline.kafka : {};
  const kafkaElement = setText('#pipeline-kafka', describeKafka(kafka));
  if (kafkaElement) {
    kafkaElement.title = kafka.lastError
      ? String(kafka.lastError)
      : kafka.topic
        ? `${kafka.topic} (${kafka.groupId || 'group'})`
        : '';
  }
  const lastMessage = kafka.lastMessageAt || null;
  const lastMessageElement = setText(
    '#pipeline-last-message',
    lastMessage ? fmtRelative(lastMessage) : '—',
  );
  if (lastMessageElement) {
    lastMessageElement.title = lastMessage ? fmtDateTime(lastMessage) : 'No messages consumed yet';
  }

  setText('#outbox-pending', fmtNumber(numberOr(outboxData.pending)));
  setText('#outbox-dead', fmtNumber(numberOr(outboxData.dead)));
  setText('#failure-rate', fmtPercent(numberOr(jobData.failureRate)));
  const average = toNumber(processing.avg);
  const maximum = toNumber(processing.max);
  setText('#avg-processing', average === null ? '—' : fmtDuration(average));
  setText('#max-processing', maximum === null ? '—' : fmtDuration(maximum));

  const notice = one('#pipeline-notice');
  if (!notice) return;
  const wired = !(pipeline && pipeline.wired === false);
  if (wired) {
    notice.textContent = '';
    notice.classList.remove('banner--warn');
    notice.dataset.state = 'wired';
    setHidden(notice, true);
  } else {
    notice.textContent =
      (pipeline && pipeline.note) || 'Background pipeline processing is not enabled.';
    notice.classList.add('banner--warn');
    notice.dataset.state = 'unwired';
    setHidden(notice, false);
  }
}

function renderStorage(storage) {
  if (!storage || typeof storage !== 'object') return;
  const freeBytes = numberOr(storage.freeBytes);
  const totalBytes = toNumber(storage.totalBytes);
  const freeElement = setText('#storage-free', fmtBytes(freeBytes));
  if (freeElement) {
    freeElement.title =
      totalBytes === null
        ? `${fmtBytes(freeBytes)} free`
        : `${fmtBytes(freeBytes)} free of ${fmtBytes(totalBytes)}`;
  }
  setText('#storage-total', totalBytes === null ? 'Unknown' : fmtBytes(totalBytes));
  setText('#library-label', storage.libraryLabel || 'Library');

  const track = one('#storage-bar');
  const fill = one('#storage-bar-fill') || track;
  if (!track) return;

  if (totalBytes === null || totalBytes <= 0) {
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', '0');
    track.setAttribute('aria-valuetext', 'Storage total unknown');
    track.removeAttribute('title');
    if (fill) setPercentClass(fill, 'w', 0);
    setHidden(track, true);
    return;
  }

  setHidden(track, false);
  const free = clamp(freeBytes, 0, totalBytes);
  const percent = clamp((free / totalBytes) * 100, 0, 100);
  const text = `${fmtPercent(free / totalBytes)} free`;
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', String(round(percent, 1)));
  track.setAttribute('aria-valuetext', text);
  track.title = `${text} (${fmtBytes(free)} of ${fmtBytes(totalBytes)})`;
  if (fill) {
    setPercentClass(fill, 'w', percent);
  }
}

function makeBadge(status) {
  const badge = document.createElement('span');
  badge.className = 'badge status-badge';
  badge.textContent = labelFor(status);
  applyTone(badge, status);
  return badge;
}

function makeProgress(value, status) {
  const percent = clamp(numberOr(value), 0, 100);
  const wrap = document.createElement('div');
  wrap.className = 'job-progress';
  const track = document.createElement('div');
  track.className = 'progress progress-track';
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', String(Math.round(percent)));
  track.setAttribute('aria-valuetext', fmtPercent(percent / 100));
  applyTone(track, status);
  const fill = document.createElement('div');
  fill.className = 'progress__bar progress-fill';
  setPercentClass(fill, 'w', percent);
  const label = document.createElement('span');
  label.className = 'job-progress__value';
  label.textContent = fmtPercent(percent / 100);
  track.append(fill);
  wrap.append(track, label);
  return wrap;
}

function appendTextCell(row, isTable, className, content) {
  const cell = document.createElement(isTable ? 'td' : 'div');
  cell.className = `job-cell ${className}`;
  if (content && typeof content === 'object' && typeof content.nodeType === 'number') {
    cell.append(content);
  } else {
    cell.textContent = content === null || content === undefined ? '—' : String(content);
  }
  row.append(cell);
  return cell;
}

function ensureSettingsLink(empty) {
  if (!empty) return;
  if (
    empty.querySelector('a[href="/settings"]') ||
    empty.querySelector('a[href="settings"]') ||
    empty.querySelector('a[href$="/settings"]') ||
    empty.querySelector('[data-settings-link]')
  ) {
    return;
  }
  const link = document.createElement('a');
  link.href = '/settings';
  link.textContent = 'Open settings';
  link.dataset.settingsLink = 'true';
  const target = empty.querySelector('.empty__text') || empty;
  target.append(document.createTextNode(' '), link);
}

function renderRecentJobs(recentJobs) {
  const body = one('#recent-jobs-body');
  const empty = one('#recent-jobs-empty');
  const jobs = Array.isArray(recentJobs) ? recentJobs : [];

  if (body) {
    if (body.tagName === 'TABLE') {
      const tbody = body.tBodies && body.tBodies[0];
      if (tbody) {
        tbody.replaceChildren();
      } else {
        body.replaceChildren();
      }
    } else {
      body.replaceChildren();
    }
  }

  if (jobs.length === 0) {
    setHidden(empty, false);
    ensureSettingsLink(empty);
    return;
  }

  setHidden(empty, true);
  if (!body) return;

  let host = body;
  let isTable = body.tagName === 'TBODY';
  if (body.tagName === 'TABLE') {
    host = body.tBodies && body.tBodies[0];
    if (!host) {
      host = document.createElement('tbody');
      body.append(host);
    }
    isTable = true;
  }

  for (const job of jobs) {
    const item = job && typeof job === 'object' ? job : {};
    const row = document.createElement(isTable ? 'tr' : 'div');
    row.className = 'job-row';
    if (item.id) {
      row.dataset.jobId = String(item.id);
      row.title = `Job ${item.id}`;
    }

    const file = document.createElement('div');
    file.className = 'job-file';
    const fileName = document.createElement('span');
    fileName.className = 'job-file__name';
    fileName.textContent = item.fileName ? String(item.fileName) : 'Untitled';
    const fileMeta = document.createElement('span');
    fileMeta.className = 'job-file__meta';
    const attempts = numberOr(item.attempts);
    const shortId =
      item.id && String(item.id).length > 10 ? `${String(item.id).slice(0, 8)}…` : String(item.id || '');
    fileMeta.textContent = `${shortId || 'Job'} · ${fmtNumber(attempts)} attempt${attempts === 1 ? '' : 's'}`;
    file.append(fileName, fileMeta);
    appendTextCell(row, isTable, 'job-cell--file', file);

    appendTextCell(row, isTable, 'job-cell--status', makeBadge(item.status));
    appendTextCell(row, isTable, 'job-cell--stage cell-mono', item.stage ? String(item.stage) : '—');
    appendTextCell(row, isTable, 'job-cell--progress', makeProgress(item.progress, item.status));

    const size = document.createElement('span');
    size.className = 'job-size';
    size.textContent = fmtBytes(item.fileSize);
    size.title = `Downloaded ${fmtBytes(item.downloadedSize)} of ${fmtBytes(item.fileSize)}`;
    appendTextCell(row, isTable, 'job-cell--size cell-num', size);

    const updated = document.createElement('div');
    updated.className = 'job-time';
    const relative = document.createElement('span');
    relative.className = 'job-time__relative';
    relative.textContent = item.createdAt ? fmtRelative(item.createdAt) : '—';
    relative.title = item.createdAt ? fmtDateTime(item.createdAt) : '';
    const duration = document.createElement('span');
    duration.className = 'job-time__duration';
    const processing = toNumber(item.processingTimeMs);
    duration.textContent = processing === null ? '—' : fmtDuration(processing);
    duration.title = processing === null ? 'Processing time unavailable' : 'Processing time';
    updated.append(relative, duration);
    appendTextCell(row, isTable, 'job-cell--updated cell-muted', updated);

    host.append(row);
  }
}

function renderEvents(recentEvents) {
  const list = one('#activity-list');
  const empty = one('#activity-empty');
  const events = Array.isArray(recentEvents) ? recentEvents : [];

  if (list) list.replaceChildren();

  if (events.length === 0) {
    setHidden(empty, false);
    return;
  }

  setHidden(empty, true);
  if (!list) return;

  const itemTag = list.tagName === 'UL' || list.tagName === 'OL' ? 'li' : 'div';

  for (const event of events) {
    const item = event && typeof event === 'object' ? event : {};
    const tone = item.level || 'info';
    const row = document.createElement(itemTag);
    row.className = 'activity-item';
    row.dataset.tone = cssTone(tone);
    row.title = item.jobId
      ? `Job ${item.jobId} · ${fmtDateTime(item.at)}`
      : fmtDateTime(item.at);

    const dot = document.createElement('span');
    dot.className = 'dot';
    applyTone(dot, tone);

    const body = document.createElement('div');
    body.className = 'activity-item__body';

    const title = document.createElement('p');
    title.className = 'activity-item__title';
    title.textContent = item.event ? String(item.event) : 'event';

    const meta = document.createElement('p');
    meta.className = 'activity-item__meta';
    const stage = item.stage ? String(item.stage) : 'pipeline';
    const level = labelFor(item.level || 'info');
    const message = item.message ? truncateText(item.message, EVENT_MESSAGE_LIMIT) : '';
    meta.textContent = `${stage} · ${level}${message ? ` · ${message}` : ''}`;
    if (item.message) meta.title = String(item.message);

    const time = document.createElement('time');
    time.className = 'activity-item__time';
    const when = toDate(item.at);
    if (when) time.dateTime = when.toISOString();
    time.textContent = item.at ? fmtRelative(item.at) : '—';
    time.title = item.at ? fmtDateTime(item.at) : '';

    body.append(title, meta);
    row.append(dot, body, time);
    list.append(row);
  }
}


const HEALTH_COMPONENT_LABELS = {
  database: 'Database',
  temp_dir: 'Temp storage',
  config: 'Configuration',
};

function healthComponentLabel(value) {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  if (!raw) return 'Component';
  const label = HEALTH_COMPONENT_LABELS[raw.toLowerCase()];
  return label || humanize(raw);
}

function renderHealth(health) {
  const list = one('#health-list');
  if (!list) return;
  const components =
    health && Array.isArray(health.components) ? health.components.filter(Boolean) : [];

  list.replaceChildren();

  if (components.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'health-item health-item--empty';
    empty.textContent = 'No health checks reported.';
    list.append(empty);
    return;
  }

  const itemTag = list.tagName === 'UL' || list.tagName === 'OL' ? 'li' : 'div';

  for (const component of components) {
    const row = document.createElement(itemTag);
    row.className = 'health-item';
    row.dataset.tone = cssTone(component.status);

    const head = document.createElement('div');
    head.className = 'health-item__head';

    const dot = document.createElement('span');
    dot.className = 'dot';
    applyTone(dot, component.status);

    const name = document.createElement('span');
    name.className = 'health-item__name';
    name.textContent = healthComponentLabel(component.component);

    const status = document.createElement('span');
    status.className = 'status-pill';
    status.textContent = labelFor(component.status);
    applyTone(status, component.status);

    head.append(dot, name, status);

    const meta = document.createElement('span');
    meta.className = 'health-item__meta';
    const latencyValue = toNumber(component.latencyMs);
    const latency = latencyValue === null ? '—' : fmtDuration(latencyValue);
    const message = component.message ? String(component.message) : '';
    meta.textContent = message ? `${latency} · ${message}` : latency;
    if (message) meta.title = message;

    row.append(head, meta);
    list.append(row);
  }
}


function renderConfig(config) {
  if (!config || typeof config !== 'object') return;

  const kafka = one('#config-kafka');
  if (kafka) {
    const brokers = Array.isArray(config.kafkaBrokers)
      ? config.kafkaBrokers
          .filter((broker) => typeof broker === 'string' && broker.trim() !== '')
          .map((broker) => broker.trim())
      : [];
    const brokerText = brokers.length
      ? truncateText(brokers.join(', '), 64)
      : 'No brokers configured';
    kafka.textContent = `${config.kafkaEnabled ? 'Enabled' : 'Disabled'} · ${brokerText}`;
    kafka.title = brokers.length
      ? `${config.kafkaEnabled ? 'Kafka enabled' : 'Kafka disabled'} — ${brokers.join(', ')}`
      : `${config.kafkaEnabled ? 'Kafka enabled' : 'Kafka disabled'} — no brokers configured`;
    setEnabledState(kafka, Boolean(config.kafkaEnabled));
  }

  const s3 = one('#config-s3');
  if (s3) {
    const bucket = config.s3Bucket ? String(config.s3Bucket) : 'No bucket';
    const region = config.s3Region ? String(config.s3Region) : 'unknown region';
    s3.textContent = `${config.s3Enabled ? 'Enabled' : 'Disabled'} · ${truncateText(bucket, 40)} · ${region}`;
    s3.title = `${config.s3Enabled ? 'S3 enabled' : 'S3 disabled'} — ${bucket} (${region})`;
    setEnabledState(s3, Boolean(config.s3Enabled));
  }

  const workers = one('#config-workers');
  if (workers) {
    const concurrency = numberOr(config.workerConcurrency);
    workers.textContent = `${config.workerEnabled ? 'Enabled' : 'Disabled'} · ${fmtNumber(concurrency)} worker${concurrency === 1 ? '' : 's'}`;
    workers.title = `${config.workerEnabled ? 'Workers enabled' : 'Workers disabled'} — concurrency ${concurrency}`;
    setEnabledState(workers, Boolean(config.workerEnabled));
  }
}

function renderDashboard(data) {
  const snapshot = data && typeof data === 'object' ? data : {};
  renderService(snapshot.service);
  renderKpis(snapshot.jobs);
  renderActivity(snapshot.activity);
  renderPipeline(snapshot.jobs, snapshot.outbox, snapshot.pipeline);
  renderStorage(snapshot.storage);
  renderRecentJobs(snapshot.recentJobs);
  renderEvents(snapshot.recentEvents);
  renderHealth(snapshot.health);
  renderConfig(snapshot.config);
}

function responseError(payload) {
  const error = new Error(
    (payload && payload.error && payload.error.message) || 'Dashboard request failed.',
  );
  if (payload && payload.error && payload.error.code === 'unauthorized') {
    error.status = 401;
  }
  if (payload && typeof payload.status === 'number') {
    error.status = payload.status;
  }
  return error;
}

function unwrapDashboard(payload) {
  if (payload === null || typeof payload !== 'object') {
    throw new Error('Invalid dashboard response.');
  }
  if (payload.ok === false) {
    throw responseError(payload);
  }
  const data =
    payload.data !== undefined ? payload.data : payload.ok === true ? undefined : payload;
  if (!data || typeof data !== 'object') {
    throw new Error('Dashboard data is missing.');
  }
  if (!data.service && !data.jobs && !data.storage) {
    throw new Error('Unexpected dashboard payload.');
  }
  return data;
}

function isUnauthorized(error) {
  if (!error || typeof error !== 'object') return false;
  const status =
    error.status ??
    error.statusCode ??
    (error.response && error.response.status) ??
    (error.cause && error.cause.status);
  if (Number(status) === 401) return true;
  if (error.code === 'unauthorized' || error.code === 'unauthenticated') return true;
  return /authentication required/i.test(String(error.message || ''));
}

function notify(message, tone) {
  try {
    showToast(message, tone);
  } catch {
    try {
      showToast(message);
    } catch {
      return;
    }
  }
}

const LIVE_LABELS = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  polling: 'Polling 5s',
  offline: 'Offline',
  required: 'Sign in required',
};

const LIVE_TITLES = {
  connecting: 'Connecting to live updates…',
  live: 'Live updates every 2 seconds',
  reconnecting: 'Live updates interrupted — reconnecting…',
  polling: 'Live updates unavailable — polling every 5 seconds',
  offline: 'Live updates offline — attempting to reconnect…',
  required: 'Sign in to resume live updates',
};

const LIVE_STATES = ['connecting', 'live', 'reconnecting', 'polling', 'offline', 'required'];

function setLiveState(state) {
  const key = LIVE_LABELS[state] ? state : 'connecting';
  const indicator = one('#live-indicator');
  const label = one('#live-label');
  if (indicator) {
    indicator.classList.remove(...LIVE_STATES.map((name) => 'is-' + name));
    indicator.classList.add('is-' + key);
    indicator.dataset.liveState = key;
    const title = LIVE_TITLES[key];
    if (title) indicator.title = title;
  }
  if (label) {
    label.textContent = LIVE_LABELS[key];
  }
}

function showError(error, manual) {
  const unauthorized = isUnauthorized(error);
  if (unauthorized) setLiveState('required');
  const banner = one('#error-banner');
  const message = one('#error-message');
  const retry = one('#retry-btn');

  if (message) {
    message.textContent = unauthorized ? AUTH_MESSAGE : GENERIC_ERROR_MESSAGE;
    message.title = error && error.message ? String(error.message) : '';
  }
  if (retry) {
    setHidden(retry, unauthorized);
  }
  setHidden(banner, false);

  if (manual && !toastShownForFailure) {
    toastShownForFailure = true;
    notify(unauthorized ? AUTH_MESSAGE : 'Dashboard refresh failed.', 'error');
  }
}

function hideError() {
  setHidden(one('#error-banner'), true);
}

function setButtonBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle('is-loading', busy);
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
  if (busy) {
    if (!button.querySelector('.spinner')) {
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      spinner.setAttribute('aria-hidden', 'true');
      spinner.dataset.generated = 'true';
      button.append(spinner);
    }
  } else {
    const generated = button.querySelector('.spinner[data-generated="true"]');
    if (generated) generated.remove();
  }
}

async function refresh(options = {}) {
  const manual = Boolean(options.manual);
  if (isFetching) return;
  isFetching = true;

  const refreshButton = one('#refresh-btn');
  if (manual) setButtonBusy(refreshButton, true);

  try {
    const payload = await fetchJson(DASHBOARD_ENDPOINT, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    const data = unwrapDashboard(payload);
    renderDashboard(data);
    lastSuccessAt = Date.now();
    toastShownForFailure = false;
    hideError();
    if (typeof EventSource !== 'function') setLiveState('polling');
  } catch (error) {
    showError(error, manual);
  } finally {
    isFetching = false;
    if (manual) setButtonBusy(refreshButton, false);
    if (options.initial) setLoading(false);
    updateLastUpdated();
  }
}

function updateLastUpdated() {
  const element = one('#last-updated');
  if (!element) return;
  if (!lastSuccessAt) {
    element.textContent = 'Not updated yet';
    element.title = '';
    return;
  }
  const date = new Date(lastSuccessAt);
  const absolute = fmtDateTime(date);
  element.textContent = `Updated ${fmtRelative(date)} · ${absolute}`;
  element.title = absolute;
}

function collectLoadingTargets() {
  loadingTargets.length = 0;
  for (const element of all('[data-loading]')) {
    loadingTargets.push(element);
  }
  for (const skeleton of all('.skeleton')) {
    skeleton.setAttribute('aria-hidden', 'true');
  }
}

function setLoading(active) {
  for (const element of loadingTargets) {
    if (active) {
      element.setAttribute(LOADING_ATTRIBUTE, 'true');
      element.classList.add('is-loading');
      element.setAttribute('aria-busy', 'true');
    } else {
      element.removeAttribute(LOADING_ATTRIBUTE);
      element.classList.remove('is-loading');
      element.setAttribute('aria-busy', 'false');
    }
  }
  if (document.body) {
    document.body.classList.toggle('is-loading', active);
    if (!active) document.body.classList.add('is-ready');
  }
  if (document.documentElement) {
    document.documentElement.classList.toggle('is-loading', active);
  }
}

function isDocumentHidden() {
  return document.hidden === true || document.visibilityState === 'hidden';
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function stopFallbackPolling() {
  if (fallbackTimer !== null) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
}

function startFallbackPolling() {
  if (fallbackTimer !== null || isDocumentHidden()) return;
  refresh();
  fallbackTimer = setInterval(() => {
    if (isDocumentHidden()) return;
    refresh();
  }, FALLBACK_POLL_INTERVAL_MS);
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (isDocumentHidden()) return;
    connectStream();
  }, RECONNECT_DELAY_MS);
}

function closeStream() {
  const source = stream;
  stream = null;
  streamConnected = false;
  if (source) {
    try {
      source.close();
    } catch {}
  }
  stopFallbackPolling();
  clearReconnectTimer();
}

function connectStream() {
  if (isDocumentHidden()) return;
  if (typeof EventSource !== 'function') {
    setLiveState('polling');
    startFallbackPolling();
    return;
  }
  if (stream) return;

  clearReconnectTimer();
  setLiveState('connecting');

  let source;
  try {
    source = new EventSource(STREAM_ENDPOINT);
  } catch {
    setLiveState('offline');
    startFallbackPolling();
    scheduleReconnect();
    return;
  }

  stream = source;

  source.addEventListener('open', () => {
    if (stream !== source) return;
    streamConnected = true;
    stopFallbackPolling();
    clearReconnectTimer();
    setLiveState('live');
    hideError();
  });

  source.addEventListener('dashboard', (event) => {
    if (stream !== source) return;
    try {
      const payload = JSON.parse(event.data);
      const data = unwrapDashboard(payload);
      renderDashboard(data);
      lastSuccessAt = Date.now();
      toastShownForFailure = false;
      setLoading(false);
      hideError();
      setLiveState('live');
      updateLastUpdated();
    } catch (error) {
      showError(error, false);
      if (!isUnauthorized(error)) setLiveState('reconnecting');
    }
  });

  source.addEventListener('dashboard-error', (event) => {
    if (stream !== source) return;
    let error;
    try {
      error = responseError(JSON.parse(event.data));
    } catch {
      error = new Error('Live dashboard update failed.');
    }
    showError(error, false);
    if (!isUnauthorized(error)) setLiveState('reconnecting');
  });

  source.addEventListener('error', () => {
    if (stream !== source) return;
    streamConnected = false;
    setLiveState('reconnecting');
    if (source.readyState === EventSource.CLOSED) {
      stream = null;
      try {
        source.close();
      } catch {}
      setLiveState('offline');
      startFallbackPolling();
      scheduleReconnect();
    }
  });
}

function startClock() {
  if (clockTimer !== null) return;
  clockTimer = setInterval(updateLastUpdated, CLOCK_INTERVAL_MS);
}

function stopClock() {
  if (clockTimer !== null) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
}

function handleVisibilityChange() {
  if (isDocumentHidden()) {
    closeStream();
    stopClock();
    return;
  }
  startClock();
  connectStream();
  if (lastSuccessAt === 0 || Date.now() - lastSuccessAt > STALE_AFTER_MS) {
    refresh();
  }
}

function startTimers() {
  if (timersStarted) return;
  timersStarted = true;

  startClock();

  if (typeof document.addEventListener === 'function' && !visibilityBound) {
    visibilityBound = true;
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  connectStream();
}

function bootstrap() {
  if (initialized) return;
  initialized = true;

  collectLoadingTargets();

  const refreshButton = one('#refresh-btn');
  if (refreshButton) {
    refreshButton.addEventListener('click', () => {
      refresh({ manual: true });
    });
  }

  const retryButton = one('#retry-btn');
  if (retryButton) {
    retryButton.addEventListener('click', () => {
      refresh({ manual: true });
    });
  }

  setLoading(true);
  updateLastUpdated();
  startTimers();
  refresh({ initial: true });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }
}
