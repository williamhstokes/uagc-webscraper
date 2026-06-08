const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  scanId: null,
  eventSource: null,
  snapshot: null,
  scope: 'all',
  canvasReady: false,
  pollingTimer: null,
  pendingEdits: new Map(),
  completedNotifiedFor: null
};

const elements = {
  startUrl: $('#startUrl'),
  workerCount: $('#workerCount'),
  includeExternalPdfs: $('#includeExternalPdfs'),
  alert: $('#alert'),
  startBtn: $('#startBtn'),
  pauseBtn: $('#pauseBtn'),
  resumeBtn: $('#resumeBtn'),
  cancelBtn: $('#cancelBtn'),
  pauseCanvasBtn: $('#pauseCanvasBtn'),
  selectAllBtn: $('#selectAllBtn'),
  downloadProgressTop: $('#downloadProgressTop'),
  downloadProgressCard: $('#downloadProgressCard'),
  downloadCsvCard: $('#downloadCsvCard'),
  downloadCsvInline: $('#downloadCsvInline'),
  saveCsvEditsBtn: $('#saveCsvEditsBtn'),
  csvFileName: $('#csvFileName'),
  liveStatusDot: $('#liveStatusDot'),
  liveStatusText: $('#liveStatusText'),
  resultsBody: $('#resultsBody'),
  resultSummary: $('#resultSummary'),
  recentList: $('#recentList'),
  recentCount: $('#recentCount'),
  queueList: $('#queueList'),
  queueCount: $('#queueCount'),
  canvas: $('#progressCanvas')
};

function setDisabled(element, value) {
  if (element) element.disabled = value;
}

function setText(element, value) {
  if (element) element.textContent = value;
}

const ctx = elements.canvas ? elements.canvas.getContext('2d') : null;
const progressImage = new Image();
progressImage.src = '/assets/progress-bg.png';
progressImage.onload = () => {
  state.canvasReady = true;
  drawProgress(state.snapshot);
};

const detailNameMap = {
  term: { exactMatch: 'exact', caseSensitive: 'caseSensitive', stemming: 'stemming' },
  phrase: { exactPhrase: 'exact', partialPhrase: 'partial', proximity: 'proximity' },
  images: { jpeg: ['jpeg', 'jpg'], png: 'png', webp: 'webp', svg: 'svg', gif: 'gif', altText: 'alt', missingAlt: 'missingAlt' },
  videos: { youtubeEmbed: 'youtube', html5Video: 'html5', transcript: 'transcript', captions: 'captions' },
  pdf: { linkedPdfs: 'linked', embeddedPdfs: 'embedded', downloadablePdfs: 'downloadable', fileSize: 'fileSize' },
  links: { internal: 'internal', external: 'external', brokenLinks: 'broken' },
  metadata: { titleTag: 'title', metaDescription: 'description', canonical: 'canonical', robots: 'robots', openGraph: 'openGraph' },
  forms: { inquiryForm: 'inquiry', leadForm: 'lead', applicationForm: 'application', allForms: 'allForms' },
  accessibility: { emptyHeadings: 'emptyHeadings', duplicateIds: 'duplicateIds', missingLabels: 'missingLabels' },
  seo: { missingTitle: 'missingTitle', missingMetaDescription: 'missingMetaDescription', noindex: 'noindex', missingCanonical: 'missingCanonical' }
};

function htmlEscape(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseList(value = '') {
  return String(value)
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function showAlert(message, tone = 'info') {
  elements.alert.hidden = false;
  elements.alert.textContent = message;
  elements.alert.dataset.tone = tone;
  window.clearTimeout(showAlert.timer);
  showAlert.timer = window.setTimeout(() => {
    elements.alert.hidden = true;
  }, tone === 'error' ? 8000 : 4500);
}

function collectOptions() {
  const contentTypes = {};
  const details = {};
  let terms = [];
  let phrases = [];

  $$('.filter-card').forEach((card) => {
    const key = card.dataset.filter;
    const enabled = Boolean($('[data-enabled]', card)?.checked);
    contentTypes[key] = enabled;
    details[key] = {};

    $$('[data-option]', card).forEach((input) => {
      const map = detailNameMap[key]?.[input.dataset.option] || input.dataset.option;
      const checked = Boolean(input.checked);
      if (Array.isArray(map)) {
        map.forEach((mappedKey) => {
          details[key][mappedKey] = checked;
        });
      } else {
        details[key][map] = checked;
      }
    });


    if (key === 'forms' && details[key].allForms) {
      details[key].inquiry = true;
      details[key].lead = true;
      details[key].application = true;
    }

    const query = $('[data-query]', card);
    if (query && key === 'term') terms = parseList(query.value);
    if (query && key === 'phrase') phrases = parseList(query.value);
  });

  ['paragraphTypes', 'headings', 'structuredData', 'analytics', 'blocks', 'tables', 'documents'].forEach((removedType) => {
    contentTypes[removedType] = false;
    delete details[removedType];
  });

  return {
    startUrl: elements.startUrl.value.trim(),
    scope: state.scope,
    workers: Number(elements.workerCount.value || 12),
    includeExternalPdfs: Boolean(elements.includeExternalPdfs.checked),
    terms,
    phrases,
    contentTypes,
    details
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed with HTTP ${response.status}`);
  }
  return data;
}

function connectEvents(scanId) {
  closeScanStream();
  state.eventSource = new EventSource(`/api/scan/${scanId}/events`);
  state.eventSource.onmessage = (event) => {
    updateDashboard(JSON.parse(event.data));
  };
  state.eventSource.onerror = () => {
    startPolling(scanId);
  };
}

function closeScanStream() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  if (state.pollingTimer) {
    window.clearInterval(state.pollingTimer);
    state.pollingTimer = null;
  }
}

function startPolling(scanId) {
  if (state.pollingTimer) return;
  state.pollingTimer = window.setInterval(async () => {
    try {
      const snapshot = await api(`/api/scan/${scanId}/status`, { method: 'GET', headers: {} });
      updateDashboard(snapshot);
      if (['completed', 'failed', 'stopped'].includes(snapshot.status)) {
        window.clearInterval(state.pollingTimer);
        state.pollingTimer = null;
      }
    } catch {
      // EventSource is the primary stream. Polling is only a quiet fallback.
    }
  }, 3000);
}

async function startScan() {
  const payload = collectOptions();
  if (!payload.startUrl) {
    showAlert('Add a Start URL before launching the crawl.', 'error');
    return;
  }

  closeScanStream();
  state.pendingEdits.clear();
  updateEditButton();

  setDisabled(elements.startBtn, true);
  showAlert('Starting scan engine...');

  try {
    const response = await api('/api/scan/start', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    state.scanId = response.id;
    updateDashboard(response.snapshot);
    connectEvents(response.id);
    showAlert('Scan launched in accuracy-first mode. Workers are validating pages now.');
  } catch (error) {
    setDisabled(elements.startBtn, false);
    showAlert(error.message, 'error');
  }
}

async function pauseScan() {
  if (!state.scanId) return;
  try {
    const snapshot = await api(`/api/scan/${state.scanId}/pause`, { method: 'POST', body: '{}' });
    updateDashboard(snapshot);
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

async function resumeScan() {
  if (!state.scanId) return;
  try {
    const snapshot = await api(`/api/scan/${state.scanId}/resume`, { method: 'POST', body: '{}' });
    updateDashboard(snapshot);
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

async function cancelScan() {
  if (!state.scanId) return;
  setDisabled(elements.cancelBtn, true);
  showAlert('Cancelling scan...');

  try {
    const snapshot = await api(`/api/scan/${state.scanId}/stop`, { method: 'POST', body: '{}' });
    updateDashboard(snapshot);
    closeScanStream();
    showAlert('Scan cancelled. You can still save edits and download the current CSV results.');
  } catch (error) {
    showAlert(error.message, 'error');
    updateControls(state.snapshot || {});
  }
}

function downloadProgress() {
  if (!state.scanId) return;
  window.location.href = `/api/scan/${state.scanId}/progress.json`;
}

async function saveCsvEdits(showMessage = true) {
  if (!state.scanId || state.pendingEdits.size === 0) return true;

  const updates = [...state.pendingEdits.entries()].map(([rowId, fields]) => ({
    row_id: rowId,
    fields
  }));

  try {
    const response = await api(`/api/scan/${state.scanId}/result-edits`, {
      method: 'POST',
      body: JSON.stringify({ updates })
    });
    state.pendingEdits.clear();
    updateEditButton();
    if (response.snapshot) updateDashboard(response.snapshot);
    if (showMessage) showAlert(`Saved ${formatNumber(response.saved || updates.length)} CSV edit${(response.saved || updates.length) === 1 ? '' : 's'}.`);
    return true;
  } catch (error) {
    showAlert(error.message, 'error');
    return false;
  }
}

function sanitizedCsvFileName(value) {
  const fallback = state.snapshot?.stats?.csvFileName || 'UAGC_webscrape_MM_DD_YY.csv';
  const raw = String(value || '').trim() || fallback;
  const clean = raw.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
  return clean.toLowerCase().endsWith('.csv') ? clean : `${clean}.csv`;
}

async function downloadCsv() {
  if (!state.scanId) return;
  const saved = await saveCsvEdits(false);
  if (!saved) return;
  const filename = sanitizedCsvFileName(elements.csvFileName?.value);
  if (elements.csvFileName) elements.csvFileName.value = filename;
  window.location.href = `/api/scan/${state.scanId}/results.csv?filename=${encodeURIComponent(filename)}`;
}

function updateDashboard(snapshot) {
  state.snapshot = snapshot;
  drawProgress(snapshot);
  updateControls(snapshot);
  updatePreview(snapshot.previewResults || []);
  updateRecent(snapshot.recentMatches || []);
  updateQueue(snapshot.queuePreview || [], snapshot.stats?.queuedUrls || 0);

  if (snapshot.status === 'completed' && snapshot.id && state.completedNotifiedFor !== snapshot.id) {
    state.completedNotifiedFor = snapshot.id;
    showAlert('Scan completed. Review any edits, adjust the CSV file name, then download when ready.');
  }
}

function updateControls(snapshot = {}) {
  const status = snapshot.status || 'idle';
  const running = ['queued', 'discovering', 'running'].includes(status);
  const paused = status === 'paused' || snapshot.paused;
  const done = ['completed', 'failed', 'stopped'].includes(status);

  setDisabled(elements.startBtn, running || paused);
  setDisabled(elements.pauseBtn, !running);
  setDisabled(elements.resumeBtn, !paused);
  setDisabled(elements.cancelBtn, !(running || paused));
  setDisabled(elements.pauseCanvasBtn, !(running || paused));
  setDisabled(elements.downloadProgressTop, !state.scanId);
  setDisabled(elements.downloadProgressCard, !state.scanId);
  setDisabled(elements.downloadCsvInline, !state.scanId);
  setDisabled(elements.downloadCsvCard, !state.scanId);
  setText(elements.downloadCsvCard, done ? 'Download Editable CSV' : 'Download Partial Editable CSV');
  updateEditButton();

  setText(elements.pauseCanvasBtn, paused ? '▶ Resume Scan' : 'Ⅱ Pause Scan');
  setText(elements.liveStatusText, statusLabel(snapshot));
  if (elements.liveStatusDot) elements.liveStatusDot.className = `dot ${statusClass(status)}`;
}

function statusClass(status) {
  if (status === 'completed') return 'done';
  if (status === 'paused') return 'paused';
  if (status === 'failed' || status === 'stopped') return 'error';
  if (['queued', 'discovering', 'running'].includes(status)) return 'running';
  return 'idle';
}

function statusLabel(snapshot = {}) {
  const status = snapshot.status || 'idle';
  if (status === 'discovering') return 'Reading sitemap seeds...';
  if (status === 'running') return 'Scanning published pages...';
  if (status === 'paused') return 'Scan paused';
  if (status === 'completed') return 'Scan completed';
  if (status === 'failed') return 'Scan failed';
  if (status === 'stopped') return 'Scan stopped';
  return 'Ready to scan';
}

function editableCell(row, field, extraClass = '') {
  const rowId = String(row.row_id || '');
  const pending = state.pendingEdits.get(rowId);
  const hasPendingValue = pending && Object.prototype.hasOwnProperty.call(pending, field);
  const value = hasPendingValue ? pending[field] : row[field] || '';
  const dirtyClass = hasPendingValue ? 'dirty' : '';
  return `<td class="editable-cell ${extraClass} ${dirtyClass}" contenteditable="plaintext-only" spellcheck="false" data-row-id="${htmlEscape(rowId)}" data-field="${htmlEscape(field)}" data-original="${htmlEscape(row[field] || '')}" title="Click to edit this CSV value">${htmlEscape(value)}</td>`;
}

async function saveCsvCellEdit(cell) {
  if (!state.scanId || !cell?.dataset?.rowId || !cell.dataset.field) return;
  const value = cell.textContent.trim();
  if (value === (cell.dataset.original || '')) return;

  cell.classList.add('saving');
  cell.classList.remove('saved', 'error');
  try {
    await api(`/api/scan/${state.scanId}/result-edits`, {
      method: 'POST',
      body: JSON.stringify({
        updates: [{
          row_id: cell.dataset.rowId,
          fields: { [cell.dataset.field]: value }
        }]
      })
    });
    cell.dataset.original = value;
    cell.classList.add('saved');
    window.setTimeout(() => cell.classList.remove('saved'), 1200);
  } catch (error) {
    cell.classList.add('error');
    showAlert(`CSV edit was not saved: ${error.message}`, 'error');
  } finally {
    cell.classList.remove('saving');
  }
}

function updatePreview(rows) {
  const visibleRows = rows.slice(-8).reverse();
  if (!visibleRows.length) {
    elements.resultsBody.innerHTML = '<tr><td colspan="4" class="empty">No matches yet. Start a scan and the little data lanterns will appear here.</td></tr>';
  } else {
    elements.resultsBody.innerHTML = visibleRows.map((row) => `
      <tr>
        ${editableCell(row, 'page_url', 'url-cell')}
        ${editableCell(row, 'content_type')}
        ${editableCell(row, 'match_detail')}
        ${editableCell(row, 'context')}
      </tr>
    `).join('');
  }
  const count = state.snapshot?.stats?.matchesFound || 0;
  const pending = pendingEditCount();
  setText(elements.resultSummary, `Showing ${visibleRows.length} of ${formatNumber(count)} matching results. Click preview cells to edit CSV values before download${pending ? ` • ${pending} unsaved edit${pending === 1 ? '' : 's'}` : ''}.`);
}


function pendingEditCount() {
  let total = 0;
  state.pendingEdits.forEach((fields) => {
    total += Object.keys(fields).length;
  });
  return total;
}

function updateEditButton() {
  if (!elements.saveCsvEditsBtn) return;
  const pending = pendingEditCount();
  setDisabled(elements.saveCsvEditsBtn, !state.scanId || pending === 0);
  setText(elements.saveCsvEditsBtn, pending ? `Save ${pending} CSV Edit${pending === 1 ? '' : 's'}` : 'Save CSV Edits');
}

function onPreviewEdit(event) {
  const cell = event.target.closest('[data-row-id][data-field]');
  if (!cell) return;

  const rowId = String(cell.dataset.rowId || '');
  const field = cell.dataset.field;
  const row = (state.snapshot?.previewResults || []).find((item) => String(item.row_id || '') === rowId);
  if (!row || !field) return;

  const value = cell.textContent.trim();
  const original = String(row[field] || '');
  const patch = { ...(state.pendingEdits.get(rowId) || {}) };

  if (value === original) delete patch[field];
  else patch[field] = value;

  if (Object.keys(patch).length) state.pendingEdits.set(rowId, patch);
  else state.pendingEdits.delete(rowId);

  cell.classList.toggle('dirty', Object.prototype.hasOwnProperty.call(patch, field));
  const count = state.snapshot?.stats?.matchesFound || 0;
  const visible = Math.min(8, (state.snapshot?.previewResults || []).length);
  const pending = pendingEditCount();
  setText(elements.resultSummary, `Showing ${visible} of ${formatNumber(count)} matching results. Click preview cells to edit CSV values before download${pending ? ` • ${pending} unsaved edit${pending === 1 ? '' : 's'}` : ''}.`);
  updateEditButton();
}

function updateRecent(rows) {
  setText(elements.recentCount, `${formatNumber(rows.length)} recent`);
  if (!rows.length) {
    elements.recentList.innerHTML = '<li class="empty">Recent matches will stream in live.</li>';
    return;
  }
  elements.recentList.innerHTML = rows.slice(0, 8).map((row) => `
    <li>
      <span class="activity-check">✓</span>
      <div>
        <strong>${htmlEscape(row.content_type)} · ${htmlEscape(row.match_detail)}</strong>
        <small>${htmlEscape(row.page_url)}</small>
      </div>
    </li>
  `).join('');
}

function updateQueue(queue, total) {
  setText(elements.queueCount, `${formatNumber(total)} URLs`);
  if (!queue.length) {
    elements.queueList.innerHTML = '<li class="empty">Queue is clear.</li>';
    return;
  }
  elements.queueList.innerHTML = queue.map((url) => `<li><span>${htmlEscape(url)}</span><em>Queued</em></li>`).join('');
}

function statusPillClass(status = '') {
  const normalized = status.toLowerCase();
  if (/broken|issue|review|failed/.test(normalized)) return 'warn';
  if (/detected|matched|found/.test(normalized)) return 'ok';
  return 'neutral';
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawCoverImage(ctx, image, width, height) {
  if (!state.canvasReady) return false;
  const scale = Math.max(width / image.width, height / image.height);
  const sw = width / scale;
  const sh = height / scale;
  const sx = (image.width - sw) / 2;
  const sy = (image.height - sh) / 2;
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, width, height);
  return true;
}

function drawProgress(snapshot) {
  const canvas = elements.canvas;
  if (!canvas || !ctx) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(900, rect.width || 1600);
  const height = Math.max(260, rect.height || 260);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const stats = snapshot?.stats || {};
  const progress = Number(snapshot?.progress || 0);
  const status = statusLabel(snapshot);

  ctx.clearRect(0, 0, width, height);
  if (!drawCoverImage(ctx, progressImage, width, height)) {
    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, '#0a2a5e');
    bg.addColorStop(1, '#081a33');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
  }

  ctx.fillStyle = 'rgba(6, 24, 51, 0.78)';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#ffffff';
  ctx.font = '700 22px Inter, Arial, sans-serif';
  ctx.fillText(status, 26, 52);

  ctx.fillStyle = '#78e08f';
  ctx.beginPath();
  ctx.arc(18, 44, 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 46px Inter, Arial, sans-serif';
  ctx.fillText(`${Math.round(progress)}%`, width / 2, 86);
  ctx.textAlign = 'left';

  const barX = 36;
  const barY = 112;
  const barW = width - 72;
  const barH = 18;
  roundedRect(ctx, barX, barY, barW, barH, 10);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
  ctx.fill();
  roundedRect(ctx, barX, barY, (barW * Math.min(100, progress)) / 100, barH, 10);
  const barFill = ctx.createLinearGradient(barX, 0, barX + barW, 0);
  barFill.addColorStop(0, '#1e74e8');
  barFill.addColorStop(1, '#30a8ff');
  ctx.fillStyle = barFill;
  ctx.fill();

  const metrics = [
    ['Pages Scanned', formatNumber(stats.pagesScanned)],
    ['URLs Discovered', formatNumber(stats.urlsDiscovered)],
    ['Current Speed', `${formatNumber(stats.currentSpeed)} pages/min`],
    ['Avg Response Time', `${formatNumber(stats.avgResponseTime)} ms`],
    ['Active Workers', formatNumber(stats.activeWorkers)],
    ['Elapsed Time', stats.elapsedText || formatDuration(stats.elapsedSeconds)],
    ['Est. Remaining', stats.estimatedRemainingText || formatDuration(stats.estimatedRemainingSeconds)]
  ];

  const colW = (width - 72) / metrics.length;
  metrics.forEach(([label, value], index) => {
    const x = 36 + index * colW;
    if (index > 0) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.beginPath();
      ctx.moveTo(x - 10, 162);
      ctx.lineTo(x - 10, 226);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255, 255, 255, 0.74)';
    ctx.font = '600 12px Inter, Arial, sans-serif';
    ctx.fillText(label, x, 174);
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 22px Inter, Arial, sans-serif';
    ctx.fillText(value, x, 202);
  });

  ctx.fillStyle = 'rgba(255, 255, 255, 0.76)';
  ctx.font = '600 12px Inter, Arial, sans-serif';
  const currentUrl = snapshot?.currentUrl ? `Current URL: ${snapshot.currentUrl}` : 'Awaiting scan launch';
  ctx.fillText(currentUrl.slice(0, 180), 36, height - 18);
}

function bindEvents() {
  $$('.segment[data-scope]').forEach((button) => {
    button.addEventListener('click', () => {
      state.scope = button.dataset.scope;
      $$('.segment[data-scope]').forEach((item) => item.classList.toggle('active', item === button));
    });
  });

  elements.selectAllBtn?.addEventListener('click', () => {
    const boxes = $$('.filters-grid input[type="checkbox"]');
    const shouldCheck = boxes.some((box) => !box.checked);
    boxes.forEach((box) => {
      box.checked = shouldCheck;
    });
    setText(elements.selectAllBtn, shouldCheck ? '☒ Clear All' : '☑ Select All');
  });

  elements.startBtn?.addEventListener('click', startScan);
  elements.pauseBtn?.addEventListener('click', pauseScan);
  elements.resumeBtn?.addEventListener('click', resumeScan);
  elements.cancelBtn?.addEventListener('click', cancelScan);
  elements.pauseCanvasBtn?.addEventListener('click', () => {
    if (state.snapshot?.paused || state.snapshot?.status === 'paused') resumeScan();
    else pauseScan();
  });
  elements.downloadProgressTop?.addEventListener('click', downloadProgress);
  elements.downloadProgressCard?.addEventListener('click', downloadProgress);
  elements.downloadCsvCard?.addEventListener('click', downloadCsv);
  elements.downloadCsvInline?.addEventListener('click', downloadCsv);
  elements.saveCsvEditsBtn?.addEventListener('click', () => saveCsvEdits(true));
  elements.resultsBody?.addEventListener('input', onPreviewEdit);
  elements.resultsBody?.addEventListener('keydown', (event) => {
    if (event.target.matches('.editable-cell') && event.key === 'Enter') {
      event.preventDefault();
      event.target.blur();
    }
  });
  window.addEventListener('resize', () => drawProgress(state.snapshot));
}

function initializeDefaults() {
  $$('.filters-grid input[type="checkbox"]').forEach((box) => {
    box.checked = false;
  });
  setText(elements.selectAllBtn, '☑ Select All');
  if (elements.csvFileName) {
    elements.csvFileName.value = defaultCsvFileName();
  }
}

function defaultCsvFileName() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `UAGC_webscrape_${mm}_${dd}_${yy}.csv`;
}

initializeDefaults();
bindEvents();
drawProgress(null);
