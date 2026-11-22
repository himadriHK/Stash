import {
  fetchJson,
  qs,
  qsa,
  escapeHtml,
  formatNumber,
  showToast,
  debounce,
} from './shared.js';

const DRAFT_STORAGE_KEY = 'stashHostSettingsDraft';
const RESTART_COMMAND = 'Stop the host (Ctrl+C), then run npm run dev (development) or npm start (built).';
const SECRET_PLACEHOLDER = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

const elements = {
  envFile: qs('#env-file'),
  backupFile: qs('#backup-file'),
  pendingBanner: qs('#pending-banner'),
  pendingKeys: qs('#pending-keys'),
  restartBanner: qs('#restart-banner'),
  restartKeys: qs('#restart-keys'),
  restartCommand: qs('#restart-command'),
  appliedBanner: qs('#applied-banner'),
  appliedKeys: qs('#applied-keys'),
  warningsBanner: qs('#warnings-banner'),
  warningsList: qs('#warnings-list'),
  errorBanner: qs('#settings-error'),
  errorTitle: qs('#settings-error-title'),
  errorMessage: qs('#settings-error-message'),
  errorRetry: qs('#settings-retry'),
  search: qs('#settings-search'),
  count: qs('#settings-count'),
  expandAll: qs('#expand-all'),
  collapseAll: qs('#collapse-all'),
  loading: qs('#settings-loading'),
  groups: qs('#settings-groups'),
  empty: qs('#settings-empty'),
  emptyTitle: qs('#settings-empty-title'),
  emptyText: qs('#settings-empty-text'),
  resetBtn: qs('#reset-btn'),
  saveBtn: qs('#save-btn'),
  saveSpinner: qs('#save-spinner'),
  saveLabel: qs('#save-label'),
  unsavedCount: qs('#unsaved-count'),
  unsavedLabel: qs('#unsaved-label'),
  saveBar: qs('#save-bar'),
};

const state = {
  snapshot: null,
  fields: new Map(),
  fieldNodes: new Map(),
  dirty: new Map(),
  secretClears: new Set(),
  groupOpen: new Map(),
  searchOpenState: null,
  searchQuery: '',
  saving: false,
  draftsRestored: false,
  errorAction: null,
  revision: 0,
  pendingFocusKey: null,
};

const scheduleFilter = debounce(applyFilter, 120);
const scheduleDraftWrite = debounce(writeDraftNow, 250);

bindEvents();
updateSaveBar();
loadSettings();

function bindEvents() {
  elements.search.addEventListener('input', handleSearchInput);
  elements.expandAll.addEventListener('click', () => setGroupsOpen(true));
  elements.collapseAll.addEventListener('click', () => setGroupsOpen(false));
  elements.resetBtn.addEventListener('click', resetChanges);
  elements.saveBtn.addEventListener('click', saveChanges);
  elements.errorRetry.addEventListener('click', retryLastAction);
  elements.groups.addEventListener('input', handleControlChange);
  elements.groups.addEventListener('change', handleControlChange);
  elements.groups.addEventListener('click', handleGroupsClick);
}

function retryLastAction() {
  const action = state.errorAction;
  if (typeof action === 'function') {
    action();
    return;
  }
  loadSettings();
}

async function loadSettings(options = {}) {
  const background = options.background === true;

  if (!background) {
    hideSettingsError();
    hidePendingBanner();
    hideRestartBanner();
    hideAppliedBanner();
    showWarnings([]);
    elements.loading.hidden = false;
    elements.empty.hidden = true;
    elements.groups.replaceChildren();
    elements.count.textContent = 'Loading settings\u2026';
  }

  try {
    const payload = await fetchJson('/api/settings', { method: 'GET' });
    const data = unwrapData(payload);
    if (!data || !Array.isArray(data.groups)) {
      throw new Error('The server returned an invalid settings response.');
    }

    state.snapshot = data;
    renderSettings();
    updateMeta(data);
    updatePendingBanner(data.pendingRestartKeys);
    elements.loading.hidden = true;
    hideSettingsError();

    if (!state.draftsRestored) {
      state.draftsRestored = true;
      restoreDraft();
    }
  } catch (error) {
    elements.loading.hidden = true;
    if (background) return;
    elements.count.textContent = 'Settings unavailable';
    showSettingsError(
      errorTitleFor(error, 'load'),
      describeError(error, 'load'),
      () => loadSettings(),
    );
  }
}

function renderSettings() {
  if (!state.snapshot) return;

  captureGroupOpenState();
  state.fields.clear();
  state.fieldNodes.clear();

  const fragment = document.createDocumentFragment();
  for (const group of state.snapshot.groups) {
    if (!group || !Array.isArray(group.fields)) continue;
    for (const field of group.fields) state.fields.set(field.key, field);
    fragment.append(buildGroup(group));
  }

  elements.groups.replaceChildren(fragment);
  elements.loading.hidden = true;
  applyFilter();
  updateSaveBar();
}

function captureGroupOpenState() {
  if (state.searchQuery) return;
  for (const group of qsa('.settings-group', elements.groups)) {
    state.groupOpen.set(group.dataset.groupId, group.open);
  }
}

function buildGroup(group) {
  const details = document.createElement('details');
  details.className = 'settings-group';
  details.dataset.groupId = group.id;
  details.open = state.searchQuery ? true : state.groupOpen.get(group.id) ?? true;

  const summary = document.createElement('summary');
  summary.className = 'settings-group__summary';

  const heading = document.createElement('div');
  heading.className = 'settings-group__heading';

  const title = document.createElement('h2');
  title.className = 'settings-group__title';
  title.id = `settings-group-${group.id}-title`;
  title.textContent = group.label;

  const description = document.createElement('p');
  description.className = 'settings-group__description';
  description.textContent = group.description;

  heading.append(title, description);

  const count = document.createElement('span');
  count.className = 'badge badge--muted settings-group__count';
  count.textContent = `${formatNumber(group.fields.length)} settings`;

  const chevron = document.createElement('span');
  chevron.className = 'settings-group__chevron';
  chevron.setAttribute('aria-hidden', 'true');

  summary.append(heading, count, chevron);

  const fields = document.createElement('div');
  fields.className = 'settings-group__fields';
  for (const field of group.fields) fields.append(buildField(field));

  details.append(summary, fields);
  details.addEventListener('toggle', () => {
    if (!state.searchQuery) state.groupOpen.set(group.id, details.open);
  });

  return details;
}

function buildField(field) {
  const row = document.createElement('div');
  row.className = 'settings-field';
  row.dataset.key = field.key;
  row.dataset.type = field.type;
  row.dataset.search = [field.key, field.label, field.description].join(' ').toLowerCase();

  const info = document.createElement('div');
  info.className = 'settings-field__info';

  const heading = document.createElement('div');
  heading.className = 'settings-field__heading';

  const label = document.createElement('label');
  label.className = 'field__label settings-field__label';
  label.id = elementId('label', field.key);
  label.htmlFor = elementId('control', field.key);
  label.textContent = field.label;

  const key = document.createElement('code');
  key.className = 'settings-field__key';
  key.textContent = field.key;

  heading.append(label, key);

  const description = document.createElement('p');
  description.className = 'field__hint settings-field__description';
  description.id = elementId('description', field.key);
  description.textContent = field.description;

  const badges = document.createElement('div');
  badges.className = 'settings-field__badges';
  badges.append(createRestartBadge(field), createSourceBadge(field));

  let secretBadge = null;
  if (isSecretField(field)) {
    secretBadge = document.createElement('span');
    secretBadge.className = 'badge badge--muted';
    badges.append(secretBadge);
  }

  const override = document.createElement('p');
  override.className = 'settings-field__warning';
  override.id = elementId('override', field.key);
  override.textContent = 'A process environment variable overrides .env for this key.';
  override.hidden = !field.overriddenByEnvironment;

  const error = document.createElement('p');
  error.className = 'field__error settings-field__error';
  error.id = elementId('error', field.key);
  error.setAttribute('aria-live', 'polite');
  error.hidden = true;

  info.append(heading, description, badges);
  if (field.overriddenByEnvironment) info.append(override);
  info.append(error);

  const describedBy = [description.id, error.id];
  if (field.overriddenByEnvironment) describedBy.push(override.id);

  const control = buildControl(field, describedBy.join(' '), secretBadge);
  row.append(info, control.wrapper);

  const node = {
    row,
    field,
    control: control.input,
    error,
    secretBadge,
    clearButton: control.clearButton,
    replaceButton: control.replaceButton,
    switchState: control.switchState,
  };

  state.fieldNodes.set(field.key, node);
  markDirty(node);
  if (isSecretField(field)) syncSecretUi(node);

  return row;
}

function isSecretField(field) {
  return Boolean(field && (field.secret || field.type === 'secret'));
}

function buildControl(field, describedBy, secretBadge) {
  const wrapper = document.createElement('div');
  wrapper.className = 'settings-field__control';

  if (field.type === 'boolean') {
    const switchLabel = document.createElement('label');
    switchLabel.className = 'switch settings-switch';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'switch__input';
    input.id = elementId('control', field.key);
    input.name = field.key;
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-labelledby', elementId('label', field.key));
    input.setAttribute('aria-describedby', describedBy);
    input.checked = Boolean(controlValue(field));

    const track = document.createElement('span');
    track.className = 'switch__track';
    const thumb = document.createElement('span');
    thumb.className = 'switch__thumb';
    track.append(thumb);

    const stateText = document.createElement('span');
    stateText.className = 'settings-switch__state';
    stateText.id = elementId('state', field.key);
    stateText.setAttribute('aria-hidden', 'true');
    stateText.textContent = input.checked ? 'On' : 'Off';

    switchLabel.append(input, track, stateText);
    wrapper.append(switchLabel);
    appendDefault(wrapper, field);

    return { wrapper, input, switchState: stateText, secretBadge };
  }

  if (field.type === 'select') {
    const select = document.createElement('select');
    select.className = 'select';
    select.id = elementId('control', field.key);
    select.name = field.key;
    select.setAttribute('aria-describedby', describedBy);

    for (const option of field.options ?? []) {
      const item = document.createElement('option');
      item.value = option.value;
      item.textContent = option.label;
      select.append(item);
    }

    const value = controlValue(field);
    const selected = value === null || value === undefined ? '' : String(value);
    select.value = selected;

    wrapper.append(select);
    appendDefault(wrapper, field);

    return { wrapper, input: select, secretBadge };
  }

  if (field.type === 'number') {
    const numberWrap = document.createElement('div');
    numberWrap.className = 'settings-number';

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'input';
    input.id = elementId('control', field.key);
    input.name = field.key;
    input.step = '1';
    input.inputMode = 'numeric';
    input.setAttribute('aria-describedby', describedBy);
    if (Number.isFinite(Number(field.min))) input.min = String(field.min);
    if (Number.isFinite(Number(field.max))) input.max = String(field.max);
    if (field.placeholder) input.placeholder = field.placeholder;

    const value = controlValue(field);
    input.value = value === null || value === undefined ? '' : String(value);

    numberWrap.append(input);
    if (field.unit) {
      const unit = document.createElement('span');
      unit.className = 'settings-number__unit';
      unit.textContent = unitLabel(field.unit);
      numberWrap.append(unit);
    }

    wrapper.append(numberWrap);
    appendDefault(wrapper, field);

    return { wrapper, input, secretBadge };
  }

  const input = document.createElement('input');
  input.className = 'input';
  input.id = elementId('control', field.key);
  input.name = field.key;
  input.setAttribute('aria-describedby', describedBy);

  if (isSecretField(field)) {
    input.type = 'password';
    input.autocomplete = 'off';
    input.value = '';
  } else {
    input.type = 'text';
    if (field.type === 'path') input.classList.add('input--mono');
    input.value = stringValue(controlValue(field));
  }

  if (isSecretField(field)) {
    input.placeholder = field.isSet ? SECRET_PLACEHOLDER : 'Not set';
  } else if (field.type === 'csv') {
    input.placeholder = 'a,b,c';
  } else if (field.placeholder) {
    input.placeholder = field.placeholder;
  }

  wrapper.append(input);

  let replaceButton = null;
  let clearButton = null;
  if (isSecretField(field)) {
    const actions = document.createElement('div');
    actions.className = 'settings-secret__actions';

    replaceButton = createSecretButton('Replace', 'replace', field.key, input.id);
    clearButton = createSecretButton('Clear', 'clear', field.key, input.id);

    actions.append(replaceButton, clearButton);
    wrapper.append(actions);
  }

  appendDefault(wrapper, field);

  return { wrapper, input, secretBadge, replaceButton, clearButton };
}

function createSecretButton(text, action, key, controlId) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn--sm btn--ghost settings-secret__action';
  button.dataset.action = action;
  button.dataset.key = key;
  button.setAttribute('aria-controls', controlId);
  button.textContent = text;
  return button;
}

function appendDefault(wrapper, field) {
  if (isSecretField(field)) return;
  if (field.defaultValue === null || field.defaultValue === undefined || field.defaultValue === '') {
    return;
  }
  const note = document.createElement('p');
  note.className = 'settings-field__default';
  note.textContent = `Default: ${field.defaultValue}`;
  wrapper.append(note);
}

function createRestartBadge(field) {
  const badge = document.createElement('span');
  badge.className = `badge ${field.requiresRestart ? 'badge--warn' : 'badge--ok'}`;
  badge.textContent = field.requiresRestart ? 'Restart required' : 'Applies immediately';
  return badge;
}

function createSourceBadge(field) {
  const badge = document.createElement('span');
  const source = field.source === 'environment'
    ? 'environment'
    : field.source === 'env-file'
      ? '.env'
      : 'default';
  badge.className = source === 'environment'
    ? 'badge badge--info'
    : source === 'default'
      ? 'badge badge--muted'
      : 'badge badge--muted';
  badge.textContent = source;
  badge.title = 'Value source';
  return badge;
}

function handleSearchInput(event) {
  state.searchQuery = event.target.value.trim();
  scheduleFilter();
}

function applyFilter() {
  if (!state.snapshot) return;

  const query = state.searchQuery.trim().toLowerCase();
  let matching = 0;
  let total = 0;

  const groups = qsa('.settings-group', elements.groups);

  if (query && !state.searchOpenState) {
    state.searchOpenState = new Map();
    for (const group of groups) {
      state.searchOpenState.set(group.dataset.groupId, group.open);
    }
  }

  for (const group of groups) {
    const rows = qsa('.settings-field', group);
    let groupMatches = 0;

    for (const row of rows) {
      total += 1;
      const match = !query || (row.dataset.search ?? '').includes(query);
      row.hidden = !match;
      if (match) {
        groupMatches += 1;
        matching += 1;
      }
    }

    group.hidden = Boolean(query) && groupMatches === 0;
    if (query) {
      group.open = groupMatches > 0;
    } else if (state.searchOpenState) {
      group.open = state.searchOpenState.get(group.dataset.groupId) ?? true;
    }

    const count = qs('.settings-group__count', group);
    if (count) {
      count.textContent = query
        ? `${formatNumber(groupMatches)} of ${formatNumber(rows.length)} settings`
        : `${formatNumber(rows.length)} settings`;
    }
  }

  if (!query && state.searchOpenState) state.searchOpenState = null;

  elements.count.textContent = `${formatNumber(matching)} of ${formatNumber(total)} settings`;
  const showEmpty = Boolean(state.snapshot) && matching === 0;
  elements.empty.hidden = !showEmpty;

  if (showEmpty) {
    if (query) {
      elements.emptyTitle.textContent = 'No matching settings';
      elements.emptyText.textContent = `Nothing matches "${state.searchQuery.trim()}". Try a different search term.`;
    } else {
      elements.emptyTitle.textContent = 'No settings available';
      elements.emptyText.textContent = 'The host did not return any settings.';
    }
  }
}

function setGroupsOpen(open) {
  for (const group of qsa('.settings-group', elements.groups)) {
    if (!group.hidden) group.open = open;
  }
}

function handleControlChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) return;

  const row = target.closest('.settings-field');
  if (!row) return;

  const key = row.dataset.key;
  const node = state.fieldNodes.get(key);
  if (!node || target !== node.control) return;

  const field = node.field;

  if (field.type === 'boolean') {
    const value = target.checked;
    if (node.switchState) node.switchState.textContent = value ? 'On' : 'Off';
    updateDirty(field, value, node);
    clearFieldError(node);
    return;
  }

  if (isSecretField(field)) {
    const value = target.value;
    if (value === '') {
      if (!state.secretClears.has(key)) state.dirty.delete(key);
    } else {
      state.secretClears.delete(key);
      state.dirty.set(key, value);
    }
    syncSecretUi(node);
    markDirty(node);
    clearFieldError(node);
    scheduleDraftWrite();
    updateSaveBar();
    return;
  }

  let value;
  if (field.type === 'number') {
    const raw = target.value.trim();
    if (raw === '') {
      value = null;
    } else {
      const parsed = Number(raw);
      value = Number.isFinite(parsed) ? parsed : raw;
    }
  } else {
    value = target.value;
  }

  updateDirty(field, value, node);
  clearFieldError(node);
}

function handleGroupsClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const button = target.closest('button[data-action]');
  if (!button || !elements.groups.contains(button)) return;

  const row = button.closest('.settings-field');
  if (!row) return;

  const node = state.fieldNodes.get(row.dataset.key);
  if (!node) return;

  if (button.dataset.action === 'replace') {
    node.control.focus();
    if (typeof node.control.select === 'function') node.control.select();
    return;
  }

  if (button.dataset.action === 'clear') {
    toggleSecretClear(node);
  }
}

function updateDirty(field, value, node) {
  if (valueEquals(value, snapshotValue(field))) state.dirty.delete(field.key);
  else state.dirty.set(field.key, value);

  markDirty(node);
  scheduleDraftWrite();
  updateSaveBar();
}

function toggleSecretClear(node) {
  const key = node.field.key;

  if (state.secretClears.has(key)) {
    state.secretClears.delete(key);
    state.dirty.delete(key);
  } else {
    state.secretClears.add(key);
    state.dirty.set(key, '');
  }

  node.control.value = '';
  syncSecretUi(node);
  markDirty(node);
  clearFieldError(node);
  scheduleDraftWrite();
  updateSaveBar();
}

function syncSecretUi(node) {
  const field = node.field;
  const clearing = state.secretClears.has(field.key);

  if (node.secretBadge) {
    node.secretBadge.textContent = clearing ? 'Will be cleared' : field.isSet ? 'Set' : 'Not set';
    node.secretBadge.className = clearing
      ? 'badge badge--warn'
      : field.isSet
        ? 'badge badge--ok'
        : 'badge badge--muted';
  }

  if (node.control) {
    node.control.placeholder = clearing
      ? 'Will be cleared'
      : field.isSet
        ? SECRET_PLACEHOLDER
        : 'Not set';
  }

  if (node.clearButton) {
    node.clearButton.textContent = clearing ? 'Undo clear' : 'Clear';
    node.clearButton.setAttribute('aria-pressed', clearing ? 'true' : 'false');
    node.clearButton.disabled = state.saving || (!field.isSet && !state.dirty.has(field.key) && !clearing);
  }
}

function markDirty(node) {
  node.row.classList.toggle('is-dirty', state.dirty.has(node.field.key));
}

function clearFieldError(node) {
  node.error.textContent = '';
  node.error.hidden = true;
  node.control.classList.remove('input--error');
  node.control.removeAttribute('aria-invalid');
  node.row.classList.remove('has-error');
}

function clearFieldErrors() {
  for (const node of state.fieldNodes.values()) clearFieldError(node);
}

function applyFieldErrors(fields) {
  let firstNode = null;

  if (state.searchQuery) {
    state.searchQuery = '';
    elements.search.value = '';
    applyFilter();
  }

  for (const [key, message] of Object.entries(fields)) {
    const node = state.fieldNodes.get(key);
    if (!node) continue;

    const group = node.row.closest('details');
    if (group) group.open = true;

    node.error.textContent = typeof message === 'string' && message.trim() ? message : 'Invalid value.';
    node.error.hidden = false;
    node.control.setAttribute('aria-invalid', 'true');
    node.control.classList.add('input--error');
    node.row.classList.add('has-error');

    if (!firstNode) firstNode = node;
  }

  if (!firstNode) return false;

  firstNode.row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  state.pendingFocusKey = firstNode.field.key;
  return true;
}

function updateSaveBar() {
  const count = state.dirty.size;
  elements.unsavedCount.textContent = formatNumber(count);
  elements.unsavedLabel.textContent = count === 1 ? 'unsaved change' : 'unsaved changes';
  elements.saveBtn.disabled = count === 0 || state.saving;
  elements.resetBtn.disabled = count === 0 || state.saving;
}

function setSaving(saving) {
  state.saving = saving;
  elements.saveBtn.setAttribute('aria-busy', saving ? 'true' : 'false');
  elements.saveBar.classList.toggle('is-saving', saving);
  elements.saveSpinner.hidden = !saving;
  elements.saveLabel.textContent = saving ? 'Saving\u2026' : 'Save changes';
  setControlsDisabled(saving);
  updateSaveBar();
}

function setControlsDisabled(disabled) {
  for (const node of state.fieldNodes.values()) {
    node.control.disabled = disabled;
    if (node.replaceButton) node.replaceButton.disabled = disabled;
    if (isSecretField(node.field)) syncSecretUi(node);
  }
}

function openPendingFocus() {
  const key = state.pendingFocusKey;
  if (!key) return;
  state.pendingFocusKey = null;
  const node = state.fieldNodes.get(key);
  if (node) node.control.focus({ preventScroll: true });
}

function resetChanges() {
  if (state.saving || state.dirty.size === 0) return;

  state.dirty.clear();
  state.secretClears.clear();
  clearDraft();
  clearFieldErrors();
  hideSettingsError();
  renderSettings();
}

async function saveChanges() {
  if (state.saving || state.dirty.size === 0) return;

  const submitted = Object.fromEntries(state.dirty);
  setSaving(true);
  clearFieldErrors();
  hideSettingsError();

  try {
    const payload = await fetchJson('/api/settings', {
      method: 'PUT',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ values: submitted }),
    });

    const data = unwrapData(payload);
    if (!data || typeof data !== 'object') {
      throw new Error('The server returned an invalid settings response.');
    }

    const updatedCount = Array.isArray(data.updated)
      ? data.updated.length
      : Object.keys(submitted).length;

    applySavedValues(submitted, data);
    state.dirty.clear();
    state.secretClears.clear();
    clearDraft();

    renderSettings();
    updateMeta(state.snapshot);
    showRestartBanner(data.restartKeys ?? data.pendingRestartKeys ?? []);
    updatePendingBanner(data.pendingRestartKeys ?? data.restartKeys ?? []);
    showAppliedBanner(data.applied ?? []);
    showWarnings(data.warnings ?? []);
    hideSettingsError();

    showToast(
      updatedCount === 1 ? 'Saved 1 setting.' : `Saved ${formatNumber(updatedCount)} settings.`,
      'ok',
    );

    const revision = (state.revision += 1);
    void refreshSnapshotAfterSave(revision);
  } catch (error) {
    handleSaveError(error);
  } finally {
    setSaving(false);
    updateSaveBar();
    openPendingFocus();
  }
}

function handleSaveError(error) {
  const status = Number(error?.status) || 0;
  const fields = error && error.fields && typeof error.fields === 'object' ? error.fields : null;

  if (status === 400 && fields && Object.keys(fields).length > 0) {
    const applied = applyFieldErrors(fields);
    if (applied) {
      showToast('Some settings need attention. Check the highlighted fields.', 'danger');
      return;
    }
  }

  const message = describeError(error, 'save');
  showSettingsError(
    errorTitleFor(error, 'save'),
    message,
    () => saveChanges(),
  );
  showToast(message, 'danger');
}

async function refreshSnapshotAfterSave(revision) {
  try {
    const payload = await fetchJson('/api/settings', { method: 'GET' });
    const data = unwrapData(payload);
    if (!data || !Array.isArray(data.groups)) return;
    if (state.dirty.size > 0 || state.revision !== revision) return;

    state.snapshot = data;
    renderSettings();
    updateMeta(data);
    updatePendingBanner(data.pendingRestartKeys);
  } catch {}
}

function applySavedValues(values, data) {
  const snapshot = state.snapshot;
  if (!snapshot) return;

  for (const [key, raw] of Object.entries(values)) {
    const field = state.fields.get(key);
    if (!field) continue;

    if (isSecretField(field)) {
      if (field.overriddenByEnvironment) {
        field.isSet = true;
        field.source = 'environment';
      } else if (raw === '' || raw === null || raw === undefined) {
        field.isSet = false;
        field.source = 'default';
      } else {
        field.isSet = true;
        field.source = 'env-file';
      }
      field.value = null;
      continue;
    }

    if (field.overriddenByEnvironment) {
      field.isSet = true;
      field.source = 'environment';
      continue;
    }

    const cleared = raw === '' || raw === null || raw === undefined;
    if (cleared) {
      field.value = defaultValueFor(field);
      field.isSet = false;
      field.source = 'default';
    } else {
      field.value = convertSubmittedValue(field, raw);
      field.isSet = true;
      field.source = 'env-file';
    }
  }

  snapshot.pendingRestartKeys = Array.isArray(data.pendingRestartKeys)
    ? data.pendingRestartKeys
    : Array.isArray(data.restartKeys)
      ? data.restartKeys
      : snapshot.pendingRestartKeys;

  if (typeof data.envFile === 'string' && data.envFile) snapshot.envFile = data.envFile;
  if (Object.prototype.hasOwnProperty.call(data, 'backupFile')) snapshot.backupFile = data.backupFile;
}

function updateMeta(data) {
  if (!data) return;
  elements.envFile.textContent = data.envFile || '.env';
  elements.backupFile.textContent = data.backupFile || 'No backup yet';
}

function updatePendingBanner(keys) {
  const list = Array.isArray(keys) ? keys.filter(Boolean) : [];
  if (list.length === 0 || !elements.restartBanner.hidden) {
    hidePendingBanner();
    return;
  }
  elements.pendingKeys.textContent = list.join(', ');
  elements.pendingBanner.hidden = false;
}

function hidePendingBanner() {
  elements.pendingBanner.hidden = true;
}

function showRestartBanner(keys) {
  const list = Array.isArray(keys) ? keys.filter(Boolean) : [];
  if (list.length === 0) {
    hideRestartBanner();
    return;
  }
  elements.restartKeys.textContent = list.join(', ');
  elements.restartCommand.textContent = RESTART_COMMAND;
  elements.restartBanner.hidden = false;
  hidePendingBanner();
}

function hideRestartBanner() {
  elements.restartBanner.hidden = true;
}

function showAppliedBanner(keys) {
  const list = Array.isArray(keys) ? keys.filter(Boolean) : [];
  if (list.length === 0) {
    hideAppliedBanner();
    return;
  }
  elements.appliedKeys.textContent = list.join(', ');
  elements.appliedBanner.hidden = false;
}

function hideAppliedBanner() {
  elements.appliedBanner.hidden = true;
}

function showWarnings(warnings) {
  const list = Array.isArray(warnings)
    ? warnings.filter((warning) => typeof warning === 'string' && warning.trim() !== '')
    : [];

  elements.warningsList.replaceChildren();
  if (list.length === 0) {
    elements.warningsBanner.hidden = true;
    return;
  }

  for (const warning of list) {
    const item = document.createElement('li');
    item.textContent = warning;
    elements.warningsList.append(item);
  }
  elements.warningsBanner.hidden = false;
}

function showSettingsError(title, message, action) {
  state.errorAction = typeof action === 'function' ? action : null;
  if (elements.errorTitle) elements.errorTitle.textContent = title;
  elements.errorMessage.textContent = message;
  elements.errorRetry.hidden = !state.errorAction;
  elements.errorBanner.hidden = false;
}

function hideSettingsError() {
  elements.errorBanner.hidden = true;
  state.errorAction = null;
}

function describeError(error, context) {
  const status = Number(error?.status) || 0;
  if (status === 401) return 'Your session is not authorized. Sign in and try again.';
  if (status === 403) return 'The request was blocked by the origin check. Reload the page and try again.';
  if (status === 0) return 'Unable to reach the server. Start the host, then retry.';
  if (error && typeof error.message === 'string' && error.message.trim()) return error.message;
  return context === 'save' ? 'Unable to save settings.' : 'Unable to load settings.';
}

function errorTitleFor(error, context) {
  const status = Number(error?.status) || 0;
  if (status === 401) return 'Sign in required';
  if (status === 403) return 'Request blocked';
  if (status === 0) return 'Server unreachable';
  return context === 'save' ? 'Unable to save settings' : 'Unable to load settings';
}

function snapshotValue(field) {
  if (field.type === 'boolean') return Boolean(field.value);
  if (field.type === 'number') {
    return field.value === null || field.value === undefined || field.value === ''
      ? null
      : Number(field.value);
  }
  return field.value === null || field.value === undefined ? '' : String(field.value);
}

function controlValue(field) {
  if (state.dirty.has(field.key)) return state.dirty.get(field.key);
  return field.value;
}

function valueEquals(a, b) {
  if (a === b) return true;
  const aEmpty = a === null || a === undefined || a === '';
  const bEmpty = b === null || b === undefined || b === '';
  if (aEmpty && bEmpty) return true;
  return String(a) === String(b);
}

function stringValue(value) {
  return value === null || value === undefined ? '' : String(value);
}

function defaultValueFor(field) {
  const raw = field.defaultValue;
  if (raw === null || raw === undefined) return null;
  if (field.type === 'number') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (field.type === 'boolean') {
    const normalized = String(raw).trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }
  return String(raw);
}

function convertSubmittedValue(field, raw) {
  if (field.type === 'number') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  if (field.type === 'boolean') {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
  }
  return String(raw);
}

function unitLabel(unit) {
  const labels = {
    ms: 'ms',
    seconds: 's',
    bytes: 'bytes',
    percent: '%',
    pixels: 'px',
  };
  return labels[unit] ?? unit;
}

function elementId(kind, key) {
  return `setting-${kind}-${key}`;
}

function normalizeDraftValue(field, value) {
  if (field.type === 'boolean') {
    return typeof value === 'boolean' ? value : undefined;
  }
  if (field.type === 'number') {
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function applyControlValue(node, value) {
  if (node.field.type === 'boolean') {
    node.control.checked = Boolean(value);
    if (node.switchState) node.switchState.textContent = node.control.checked ? 'On' : 'Off';
    return;
  }
  node.control.value = value === null || value === undefined ? '' : String(value);
}

function restoreDraft() {
  let raw = null;
  try {
    raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw) return;

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearDraft();
    return;
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.values || typeof parsed.values !== 'object') {
    clearDraft();
    return;
  }

  let restored = 0;
  for (const [key, draftValue] of Object.entries(parsed.values)) {
    const node = state.fieldNodes.get(key);
    if (!node || isSecretField(node.field)) continue;

    const value = normalizeDraftValue(node.field, draftValue);
    if (value === undefined) continue;
    if (valueEquals(value, snapshotValue(node.field))) continue;

    state.dirty.set(key, value);
    applyControlValue(node, value);
    markDirty(node);
    restored += 1;
  }

  if (restored === 0) {
    clearDraft();
    return;
  }

  updateSaveBar();
  showToast('Restored unsaved settings from this browser.', 'info');
}

function writeDraftNow() {
  const values = {};
  for (const [key, value] of state.dirty) {
    const node = state.fieldNodes.get(key);
    if (!node || isSecretField(node.field)) continue;
    values[key] = value;
  }

  try {
    if (Object.keys(values).length === 0) {
      window.localStorage.removeItem(DRAFT_STORAGE_KEY);
    } else {
      window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, values }));
    }
  } catch {}
}

function clearDraft() {
  scheduleDraftWrite.cancel();
  try {
    window.localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {}
}

function unwrapData(payload) {
  if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'ok')) {
    if (payload.ok === false) {
      const error = new Error(payload.error?.message || 'Request failed.');
      error.code = payload.error?.code || 'request_failed';
      error.fields = payload.error?.fields && typeof payload.error.fields === 'object'
        ? payload.error.fields
        : {};
      throw error;
    }
    return payload.data;
  }
  return payload;
}

