#!/usr/bin/env node
'use strict';

/**
 * UAGC WebScraper
 * A dependency-free Node.js crawler + dashboard API.
 *
 * Requires Node.js 18+ for global fetch and AbortController.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { once } = require('events');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data', 'scans');
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 25000);
const LINK_TIMEOUT_MS = Number(process.env.LINK_TIMEOUT_MS || 12000);
// Accuracy-first default: fewer workers reduce noisy failures while still crawling efficiently.
const DEFAULT_WORKERS = clamp(Number(process.env.CRAWL_WORKERS || 12), 1, 64);
const MAX_LINK_CHECKS_PER_PAGE = Number(process.env.MAX_LINK_CHECKS_PER_PAGE || 125);
const MAX_FETCH_RETRIES = clamp(Number(process.env.MAX_FETCH_RETRIES || 2), 0, 5);
const RETRY_BASE_DELAY_MS = Number(process.env.RETRY_BASE_DELAY_MS || 350);
const ALLOW_PRIVATE_NETWORKS = String(process.env.ALLOW_PRIVATE_NETWORKS || '').toLowerCase() === 'true';
const USER_AGENT = process.env.USER_AGENT || 'UAGC-WebScraper/1.4 (+https://www.uagc.edu)';

fs.mkdirSync(DATA_DIR, { recursive: true });

const activeScans = new Map();

const CSV_FIELDS = ['page_url', 'content_type', 'match_detail', 'context'];
const CSV_HEADER_LABELS = ['Page URL', 'Content Type', 'Match Detail', 'Context'];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

const SKIP_CRAWL_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tif', '.tiff',
  '.mp4', '.m4v', '.mov', '.avi', '.wmv', '.webm', '.mp3', '.wav', '.aac', '.ogg',
  '.zip', '.rar', '.7z', '.gz', '.tar', '.dmg', '.exe', '.msi',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.rtf', '.csv', '.xml'
]);

const DOCUMENT_EXTENSIONS = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.rtf', '.csv'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.svg', '.gif'];
const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.avi', '.wmv', '.webm'];

function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00:00';
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  const m = Math.floor((seconds / 60) % 60).toString().padStart(2, '0');
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function csvRow(values) {
  return values.map(csvEscape).join(',') + '\r\n';
}

function csvHeaderRow() {
  return '\uFEFF' + csvRow(CSV_HEADER_LABELS).slice(0, -2) + '\r\n';
}

function csvFileName(prefix = 'UAGC_webscrape') {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${prefix}_${mm}_${dd}_${yy}.csv`;
}

function jsonFileName(prefix = 'UAGC_webscrape_progress') {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${prefix}_${mm}_${dd}_${yy}.json`;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function isPrivateHost(hostname) {
  if (!hostname) return true;
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const parts = ipv4Match.slice(1).map(Number);
    if (parts.some(n => n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
  }
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
  return false;
}

function normalizeUrl(rawUrl, baseUrl) {
  try {
    const url = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.replace(/\/+$/, '/');
    }
    return url.toString();
  } catch (_) {
    return null;
  }
}

function getExtension(urlString) {
  try {
    const pathname = new URL(urlString).pathname.toLowerCase();
    const ext = path.extname(pathname);
    return ext || '';
  } catch (_) {
    return '';
  }
}

function looksLikePdf(urlString, contentType = '') {
  return getExtension(urlString) === '.pdf' || /application\/pdf/i.test(contentType);
}

function sameHost(urlString, host) {
  try {
    return new URL(urlString).hostname.toLowerCase() === host.toLowerCase();
  } catch (_) {
    return false;
  }
}

function scopeAllows(scan, urlString) {
  try {
    const url = new URL(urlString);
    if (scan.scope !== 'subdirectory') return true;
    return url.pathname.startsWith(scan.startPathPrefix);
  } catch (_) {
    return false;
  }
}

function shouldCrawlUrl(scan, urlString) {
  if (!urlString || scan.visited.has(urlString) || scan.queuedSet.has(urlString)) return false;
  if (!sameHost(urlString, scan.host)) return false;
  if (!scopeAllows(scan, urlString)) return false;
  const ext = getExtension(urlString);
  if (ext === '.pdf') return false;
  if (SKIP_CRAWL_EXTENSIONS.has(ext)) return false;
  return true;
}

function enqueueUrl(scan, rawUrl, baseUrl, source = 'link') {
  if (scan.cancelled) return false;
  const normalized = normalizeUrl(rawUrl, baseUrl);
  if (!normalized) return false;

  scan.discovered.add(normalized);
  scan.stats.urlsDiscovered = scan.discovered.size;

  if (shouldCrawlUrl(scan, normalized)) {
    scan.queue.push(normalized);
    scan.queuedSet.add(normalized);
    scan.queuePreview = scan.queue.slice(0, 12);
    return true;
  }

  if (source === 'sitemap' && sameHost(normalized, scan.host) && getExtension(normalized) === '.pdf') {
    scan.pdfCandidates.add(normalized);
  }

  return false;
}

function stripHtml(html) {
  return decodeEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function parseAttrs(tag) {
  const attrs = {};
  const text = String(tag || '').replace(/^<\/?[\w:-]+\s*/i, '').replace(/\/?\s*>$/i, '');
  const attrRegex = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = attrRegex.exec(text))) {
    const name = match[1].toLowerCase();
    if (!name || name === '/') continue;
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function extractOpenTags(html, tagName) {
  const regex = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  return String(html || '').match(regex) || [];
}

function extractPairedTags(html, tagName) {
  const regex = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const results = [];
  let match;
  while ((match = regex.exec(String(html || '')))) {
    results.push({
      full: match[0],
      attrs: parseAttrs(`<${tagName}${match[1] || ''}>`),
      inner: match[2] || '',
      text: stripHtml(match[2] || '')
    });
  }
  return results;
}

function firstMatch(html, regex) {
  const match = String(html || '').match(regex);
  return match ? decodeEntities(match[1] || match[0]).trim() : '';
}

function contentSnippet(text, needle, length = 180) {
  if (!text) return '';
  const haystack = String(text);
  const idx = needle ? haystack.toLowerCase().indexOf(String(needle).toLowerCase()) : 0;
  const start = idx >= 0 ? Math.max(0, idx - Math.floor(length / 2)) : 0;
  return haystack.slice(start, start + length).replace(/\s+/g, ' ').trim();
}

function words(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9']+/g) || [];
}

function simpleStem(token) {
  return String(token || '').toLowerCase().replace(/(ing|edly|edly|ed|ly|es|s)$/i, '');
}

function regexEscape(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textIncludes(text, needle, options = {}) {
  if (!needle) return false;
  const source = options.caseSensitive ? String(text || '') : String(text || '').toLowerCase();
  const target = options.caseSensitive ? String(needle) : String(needle).toLowerCase();

  if (options.stemming) {
    const sourceSet = new Set(words(source).map(simpleStem));
    return words(target).every(token => sourceSet.has(simpleStem(token)));
  }

  if (options.exact) {
    const flags = options.caseSensitive ? 'g' : 'gi';
    const re = new RegExp(`\\b${regexEscape(String(needle))}\\b`, flags);
    return re.test(String(text || ''));
  }

  return source.includes(target);
}

function phraseFound(text, phrase, options = {}) {
  if (!phrase) return false;
  const source = options.caseSensitive ? String(text || '') : String(text || '').toLowerCase();
  const target = options.caseSensitive ? String(phrase) : String(phrase).toLowerCase();

  if (options.exact) return source.includes(target);

  const targetWords = words(target);
  if (!targetWords.length) return false;
  const sourceWords = words(source);

  if (options.proximity) {
    const maxDistance = Number(options.proximityDistance || 12);
    const indexes = targetWords.map(w => sourceWords.reduce((acc, word, idx) => {
      if (word === w) acc.push(idx);
      return acc;
    }, []));
    if (indexes.some(list => !list.length)) return false;
    const firstList = indexes[0];
    return firstList.some(startIdx => targetWords.every((w, offset) => {
      return indexes[offset].some(i => Math.abs(i - startIdx) <= maxDistance);
    }));
  }

  if (options.partial) return targetWords.every(w => sourceWords.includes(w));

  return source.includes(target);
}

function fingerprintBlock(attrs, text) {
  const attrText = Object.entries(attrs || {}).map(([key, value]) => `${key} ${value}`).join(' ');
  const haystack = `${attrText} ${text || ''}`.toLowerCase();
  return haystack;
}

function selected(scan, type) {
  return Boolean(scan.options.contentTypes && scan.options.contentTypes[type]);
}

function detail(scan, type, name) {
  const group = scan.options.details && scan.options.details[type];
  if (!group || Object.keys(group).length === 0) return true;
  return Boolean(group[name]);
}

function selectedDetails(scan, type) {
  return (scan.options.details && scan.options.details[type]) || {};
}

function endWritable(stream) {
  if (!stream || stream.destroyed || stream.writableEnded) return Promise.resolve();
  return new Promise(resolve => stream.end(resolve));
}

function addResult(scan, result) {
  if (scan.cancelled) return;
  scan.resultCount += 1;

  const enriched = {
    row_id: String(scan.resultCount),
    scan_id: scan.id,
    found_at: nowIso(),
    page_url: result.pageUrl || '',
    content_type: result.contentType || '',
    match_detail: result.matchDetail || '',
    asset_type: result.assetType || '',
    status: result.status || 'Matched',
    asset_url: result.assetUrl || '',
    context: result.context || ''
  };

  scan.stats.matchesFound = scan.resultCount;

  if (scan.previewResults.length < 500) {
    scan.previewResults.push(enriched);
  }
  scan.recentMatches.unshift(enriched);
  if (scan.recentMatches.length > 50) scan.recentMatches.length = 50;

  scan.csvStream.write(csvRow(CSV_FIELDS.map(key => enriched[key])));
  scan.jsonlStream.write(JSON.stringify(enriched) + '\n');

  if (scan.resultCount % 10 === 0 || scan.recentMatches.length <= 5) {
    broadcast(scan);
  }
}


const EDITABLE_CSV_FIELDS = new Set([
  'page_url',
  'content_type',
  'match_detail',
  'context'
]);

function editableFieldValue(value) {
  return String(value ?? '').replace(/\u0000/g, '');
}

function applyCsvEdits(scan, row) {
  const edit = scan.edits && scan.edits.get(String(row.row_id || ''));
  return edit ? { ...row, ...edit } : row;
}

function applyCsvEditsToCollections(scan, rowId, fields) {
  for (const list of [scan.previewResults, scan.recentMatches]) {
    if (!Array.isArray(list)) continue;
    const row = list.find(item => String(item.row_id) === String(rowId));
    if (row) Object.assign(row, fields);
  }
}

function saveResultEdits(scan, updates) {
  if (!Array.isArray(updates)) {
    const error = new Error('Edits payload must include an updates array.');
    error.statusCode = 400;
    throw error;
  }

  let saved = 0;
  for (const update of updates) {
    const rowId = String(update?.row_id || '').trim();
    if (!rowId) continue;
    const nextFields = {};
    for (const [field, value] of Object.entries(update.fields || {})) {
      if (EDITABLE_CSV_FIELDS.has(field)) nextFields[field] = editableFieldValue(value);
    }
    if (!Object.keys(nextFields).length) continue;
    const current = scan.edits.get(rowId) || {};
    scan.edits.set(rowId, { ...current, ...nextFields });
    applyCsvEditsToCollections(scan, rowId, nextFields);
    saved += 1;
  }

  try {
    const editsPath = path.join(path.dirname(scan.csvPath), 'edits.json');
    fs.writeFileSync(editsPath, JSON.stringify(Object.fromEntries(scan.edits), null, 2));
  } catch (_) {
    // Edits are still kept in memory for this run if disk persistence fails.
  }

  return { saved, totalEdits: scan.edits.size };
}

async function streamEditableCsv(scan, res) {
  res.write(csvHeaderRow());

  if (!scan.jsonlPath || !fs.existsSync(scan.jsonlPath)) {
    res.end();
    return;
  }

  const input = fs.createReadStream(scan.jsonlPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (_) {
      continue;
    }
    row = applyCsvEdits(scan, row);
    if (!res.write(csvRow(CSV_FIELDS.map(key => row[key])))) {
      await once(res, 'drain');
    }
  }

  res.end();
}

function snapshot(scan) {
  const now = Date.now();
  const elapsedSeconds = Math.max(0, (now - scan.startedAt) / 1000);
  const recentCutoff = now - 60000;
  scan.recentPageCompletions = scan.recentPageCompletions.filter(ts => ts >= recentCutoff);
  const currentSpeed = scan.recentPageCompletions.length || (elapsedSeconds > 0 ? Math.round((scan.stats.pagesScanned / elapsedSeconds) * 60) : 0);
  const avgResponseTime = scan.responseTimes.length
    ? Math.round(scan.responseTimes.reduce((sum, value) => sum + value, 0) / scan.responseTimes.length)
    : 0;
  const remainingEstimate = currentSpeed > 0 ? Math.round((scan.queue.length / currentSpeed) * 60) : 0;
  const progress = scan.stats.urlsDiscovered > 0
    ? Math.min(99, Math.round((scan.stats.pagesScanned / Math.max(scan.stats.urlsDiscovered, 1)) * 100))
    : 0;

  return {
    id: scan.id,
    status: scan.status,
    paused: scan.paused,
    startUrl: scan.startUrl,
    scope: scan.scope,
    progress: scan.status === 'completed' ? 100 : progress,
    currentUrl: scan.currentUrl,
    stats: {
      ...scan.stats,
      activeWorkers: scan.activeWorkers,
      queuedUrls: scan.queue.length,
      visitedUrls: scan.visited.size,
      currentSpeed,
      throughput: currentSpeed,
      avgResponseTime,
      elapsedSeconds: Math.round(elapsedSeconds),
      elapsedText: formatDuration(elapsedSeconds),
      estimatedRemainingSeconds: remainingEstimate,
      estimatedRemainingText: formatDuration(remainingEstimate),
      workers: scan.maxWorkers,
      csvFileName: csvFileName()
    },
    recentMatches: scan.recentMatches.slice(0, 8),
    previewResults: scan.previewResults.slice(0, 8),
    queuePreview: scan.queue.slice(0, 8),
    errors: scan.errors.slice(-8)
  };
}

function broadcast(scan) {
  const data = `data: ${JSON.stringify(snapshot(scan))}\n\n`;
  for (const client of scan.clients) {
    try {
      client.write(data);
    } catch (_) {
      scan.clients.delete(client);
    }
  }
}

function cancelScan(scan) {
  if (!scan || ['completed', 'failed', 'stopped'].includes(scan.status)) return false;
  scan.cancelled = true;
  scan.paused = false;
  scan.status = 'stopped';
  scan.completedAt = scan.completedAt || Date.now();
  scan.currentUrl = '';
  scan.queue.length = 0;
  scan.queuedSet.clear();
  scan.queuePreview = [];

  try { scan.abortController?.abort(); } catch (_) {}
  for (const controller of scan.fetchControllers || []) {
    try { controller.abort(); } catch (_) {}
  }

  broadcast(scan);
  return true;
}

function launchScan(options) {
  const scan = createScan(options);
  runScan(scan).catch(error => {
    if (scan.cancelled) {
      scan.status = 'stopped';
      scan.completedAt = scan.completedAt || Date.now();
    } else {
      scan.status = 'failed';
      scan.errors.push({ message: error.message, at: nowIso() });
    }
    Promise.all([endWritable(scan.csvStream), endWritable(scan.jsonlStream)]).catch(() => {});
    broadcast(scan);
  });
  return scan;
}

function createScan(rawOptions) {
  const startUrl = normalizeUrl(rawOptions.startUrl || 'https://www.uagc.edu');
  if (!startUrl || !isHttpUrl(startUrl)) {
    const error = new Error('Start URL must be a valid http or https URL.');
    error.statusCode = 400;
    throw error;
  }

  const start = new URL(startUrl);
  if (!ALLOW_PRIVATE_NETWORKS && isPrivateHost(start.hostname)) {
    const error = new Error('Private or local network URLs are blocked by default. Set ALLOW_PRIVATE_NETWORKS=true for local testing.');
    error.statusCode = 400;
    throw error;
  }

  const id = crypto.randomUUID();
  const runDir = path.join(DATA_DIR, id);
  fs.mkdirSync(runDir, { recursive: true });
  const csvPath = path.join(runDir, 'results.csv');
  const jsonlPath = path.join(runDir, 'results.jsonl');
  const csvStream = fs.createWriteStream(csvPath, { flags: 'a' });
  const jsonlStream = fs.createWriteStream(jsonlPath, { flags: 'a' });
  csvStream.write(csvHeaderRow());

  const scope = rawOptions.scope === 'subdirectory' ? 'subdirectory' : 'all';
  const startPathPrefix = start.pathname.endsWith('/') ? start.pathname : path.posix.dirname(start.pathname) + '/';

  const scan = {
    id,
    startUrl,
    origin: start.origin,
    host: start.hostname.toLowerCase(),
    startPathPrefix,
    scope,
    includeExternalPdfs: Boolean(rawOptions.includeExternalPdfs),
    maxWorkers: clamp(Number(rawOptions.workers || DEFAULT_WORKERS), 1, 64),
    options: sanitizeOptions(rawOptions),
    status: 'queued',
    paused: false,
    cancelled: false,
    abortController: new AbortController(),
    fetchControllers: new Set(),
    startedAt: Date.now(),
    completedAt: null,
    queue: [],
    queuedSet: new Set(),
    visited: new Set(),
    discovered: new Set(),
    pdfCandidates: new Set(),
    linkStatusCache: new Map(),
    activeWorkers: 0,
    currentUrl: '',
    resultCount: 0,
    stats: {
      pagesScanned: 0,
      urlsDiscovered: 0,
      matchesFound: 0,
      bytesDownloaded: 0,
      failedRequests: 0,
      sitemapUrlsAdded: 0,
      pdfsDetected: 0,
      imagesDetected: 0,
      videosDetected: 0
    },
    recentPageCompletions: [],
    responseTimes: [],
    previewResults: [],
    recentMatches: [],
    queuePreview: [],
    errors: [],
    clients: new Set(),
    csvPath,
    jsonlPath,
    csvStream,
    jsonlStream,
    edits: new Map()
  };

  enqueueUrl(scan, startUrl, null, 'seed');
  activeScans.set(id, scan);
  return scan;
}

function sanitizeOptions(rawOptions) {
  const defaults = defaultOptions();
  const merged = {
    ...defaults,
    ...rawOptions,
    contentTypes: { ...defaults.contentTypes, ...(rawOptions.contentTypes || {}) },
    details: mergeDeep(defaults.details, rawOptions.details || {})
  };
  merged.terms = cleanArray(rawOptions.terms);
  merged.phrases = cleanArray(rawOptions.phrases);
  merged.proximityDistance = clamp(Number(rawOptions.proximityDistance || 12), 2, 50);
  merged.scope = rawOptions.scope === 'subdirectory' ? 'subdirectory' : 'all';
  merged.includeExternalPdfs = Boolean(rawOptions.includeExternalPdfs);
  merged.workers = clamp(Number(rawOptions.workers || DEFAULT_WORKERS), 1, 64);

  // Removed from the dashboard per request. Keep them disabled even if an older client posts them.
  ['paragraphTypes', 'headings', 'structuredData', 'analytics', 'blocks', 'tables', 'documents'].forEach(key => {
    merged.contentTypes[key] = false;
    delete merged.details[key];
  });

  return merged;
}

function mergeDeep(base, overlay) {
  const output = { ...base };
  for (const [key, value] of Object.entries(overlay || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = mergeDeep(base[key] || {}, value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function cleanArray(value) {
  if (Array.isArray(value)) {
    return value.map(v => String(v || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/[\n,]+/)
    .map(v => v.trim())
    .filter(Boolean);
}

function defaultOptions() {
  return {
    startUrl: 'https://www.uagc.edu',
    scope: 'all',
    workers: DEFAULT_WORKERS,
    includeExternalPdfs: false,
    accuracyMode: true,
    terms: [],
    phrases: [],
    contentTypes: {
      term: true,
      phrase: true,
      images: true,
      videos: true,
      pdf: true,
      links: true,
      metadata: true,
      forms: true,
      accessibility: true,
      seo: true
    },
    details: {
      term: { exact: false, caseSensitive: false, stemming: false },
      phrase: { exact: true, partial: false, proximity: false },
      images: { jpg: true, jpeg: true, png: true, webp: true, svg: true, gif: true, alt: true, missingAlt: true },
      videos: { youtube: true, html5: true, transcript: true, captions: true },
      pdf: { linked: true, embedded: true, downloadable: true, fileSize: true },
      links: { internal: true, external: true, broken: false },
      metadata: { title: true, description: true, canonical: true, robots: true, openGraph: false },
      forms: { inquiry: true, lead: true, application: true, allForms: true },
      accessibility: { emptyHeadings: true, duplicateIds: true, missingLabels: true },
      seo: { missingTitle: true, missingMetaDescription: true, noindex: true, missingCanonical: false }
    }
  };
}

async function runScan(scan) {
  scan.status = 'discovering';
  broadcast(scan);

  await discoverSitemaps(scan);
  if (scan.cancelled) {
    scan.status = 'stopped';
    scan.completedAt = scan.completedAt || Date.now();
    await Promise.all([endWritable(scan.csvStream), endWritable(scan.jsonlStream)]);
    broadcast(scan);
    return;
  }
  scan.status = 'running';
  broadcast(scan);

  const workers = Array.from({ length: scan.maxWorkers }, (_, index) => workerLoop(scan, index));
  await Promise.all(workers);

  if (scan.cancelled) {
    scan.status = 'stopped';
    scan.completedAt = scan.completedAt || Date.now();
  } else {
    scan.status = 'completed';
    scan.completedAt = Date.now();
  }

  await Promise.all([endWritable(scan.csvStream), endWritable(scan.jsonlStream)]);
  broadcast(scan);
}

async function workerLoop(scan, workerId) {
  while (!scan.cancelled) {
    if (scan.paused) {
      await sleep(300);
      continue;
    }

    const nextUrl = scan.queue.shift();
    if (nextUrl) {
      scan.queuedSet.delete(nextUrl);
      if (scan.visited.has(nextUrl)) continue;
      scan.activeWorkers += 1;
      try {
        await processUrl(scan, nextUrl, workerId);
      } finally {
        scan.activeWorkers -= 1;
      }
      continue;
    }

    if (scan.activeWorkers === 0 && scan.queue.length === 0) {
      break;
    }
    await sleep(150);
  }
}

async function processUrl(scan, urlString, workerId) {
  scan.currentUrl = urlString;
  scan.visited.add(urlString);
  const started = Date.now();

  try {
    const response = await fetchWithTimeout(urlString, FETCH_TIMEOUT_MS, { method: 'GET', cancelSignal: scan.abortController.signal, controllerSet: scan.fetchControllers });
    if (scan.cancelled) return;
    const contentType = response.headers.get('content-type') || '';
    const contentLength = Number(response.headers.get('content-length') || 0);
    const elapsed = Date.now() - started;
    recordResponseTime(scan, elapsed);

    if (!response.ok) {
      scan.stats.failedRequests += 1;
      scan.errors.push({ url: urlString, status: response.status, message: response.statusText, at: nowIso() });
      if (selected(scan, 'links') && detail(scan, 'links', 'broken')) {
        addResult(scan, {
          pageUrl: urlString,
          contentType: 'Links',
          matchDetail: `HTTP ${response.status} ${response.statusText}`,
          assetType: 'Page URL',
          status: 'Broken',
          assetUrl: urlString,
          context: 'Page request returned a non-success HTTP status.'
        });
      }
      return;
    }

    if (looksLikePdf(urlString, contentType)) {
      scan.stats.pdfsDetected += 1;
      if (selected(scan, 'pdf')) {
        addResult(scan, {
          pageUrl: urlString,
          contentType: 'PDF',
          matchDetail: contentLength ? `PDF document (${formatBytes(contentLength)})` : 'PDF document',
          assetType: 'PDF File',
          status: 'Detected',
          assetUrl: urlString,
          context: 'PDF was discovered in the crawl queue or sitemap.'
        });
      }
      scan.stats.pagesScanned += 1;
      scan.recentPageCompletions.push(Date.now());
      return;
    }

    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      return;
    }

    const html = await response.text();
    if (scan.cancelled) return;
    scan.stats.bytesDownloaded += Buffer.byteLength(html, 'utf8');

    const links = extractLinks(html, urlString);
    if (scan.cancelled) return;
    for (const link of links.allUrls) {
      if (scan.cancelled) return;
      enqueueUrl(scan, link, urlString, 'link');
    }

    if (scan.cancelled) return;
    await analyzeHtml(scan, urlString, html, links);

    scan.stats.pagesScanned += 1;
    scan.recentPageCompletions.push(Date.now());

    if (scan.stats.pagesScanned % 5 === 0) {
      broadcast(scan);
    }
  } catch (error) {
    scan.stats.failedRequests += 1;
    scan.errors.push({ url: urlString, message: error.message, at: nowIso() });
    if (scan.errors.length > 100) scan.errors.splice(0, scan.errors.length - 100);
  }
}

function recordResponseTime(scan, ms) {
  scan.responseTimes.push(ms);
  if (scan.responseTimes.length > 200) scan.responseTimes.splice(0, scan.responseTimes.length - 200);
}

function shouldRetryResponse(response) {
  return [408, 425, 429, 500, 502, 503, 504].includes(response.status);
}

function retryDelay(attempt) {
  const base = RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * RETRY_BASE_DELAY_MS);
  return base + jitter;
}

async function fetchWithTimeout(urlString, timeoutMs, options = {}) {
  const { retries = MAX_FETCH_RETRIES, retryDelayMs, headers = {}, cancelSignal, controllerSet, ...fetchOptions } = options;
  const maxAttempts = Math.max(1, Number(retries) + 1);
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    let cancelListener = null;
    if (controllerSet) controllerSet.add(controller);
    if (cancelSignal) {
      if (cancelSignal.aborted) controller.abort();
      else {
        cancelListener = () => controller.abort();
        cancelSignal.addEventListener('abort', cancelListener, { once: true });
      }
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (cancelSignal?.aborted) throw new Error('Request cancelled.');
      const response = await fetch(urlString, {
        redirect: 'follow',
        ...fetchOptions,
        headers: {
          'user-agent': USER_AGENT,
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.7,*/*;q=0.5',
          ...headers
        },
        signal: controller.signal
      });

      if (attempt < maxAttempts && shouldRetryResponse(response)) {
        try { await response.body?.cancel(); } catch (_) {}
        if (cancelSignal?.aborted) throw new Error('Request cancelled.');
        await sleep(retryDelayMs ?? retryDelay(attempt));
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;
      if (cancelSignal?.aborted) throw error;
      if (attempt >= maxAttempts) break;
      await sleep(retryDelayMs ?? retryDelay(attempt));
    } finally {
      clearTimeout(timer);
      if (cancelSignal && cancelListener) cancelSignal.removeEventListener('abort', cancelListener);
      if (controllerSet) controllerSet.delete(controller);
    }
  }

  throw lastError || new Error('Request failed after retry attempts.');
}

async function fetchText(urlString, timeoutMs = FETCH_TIMEOUT_MS, scan = null) {
  const response = await fetchWithTimeout(urlString, timeoutMs, { method: 'GET', cancelSignal: scan?.abortController?.signal, controllerSet: scan?.fetchControllers });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}

async function discoverSitemaps(scan) {
  const sitemapUrls = new Set([
    `${scan.origin}/sitemap.xml`,
    `${scan.origin}/sitemap_index.xml`,
    `${scan.origin}/sitemap-index.xml`
  ]);

  try {
    const robots = await fetchText(`${scan.origin}/robots.txt`, 8000, scan);
    robots.split(/\r?\n/).forEach(line => {
      const match = line.match(/^\s*sitemap\s*:\s*(.+)$/i);
      if (match && isHttpUrl(match[1].trim())) sitemapUrls.add(match[1].trim());
    });
  } catch (_) {
    // A missing robots.txt is common enough that it should not stop a crawl.
  }

  const seenSitemaps = new Set();
  const queue = Array.from(sitemapUrls);
  let depth = 0;

  while (queue.length && depth < 50 && !scan.cancelled) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);
    depth += 1;

    try {
      const xml = await fetchText(sitemapUrl, 12000, scan);
      const locs = extractLocs(xml);
      for (const loc of locs) {
        if (scan.cancelled) break;
        if (/\.xml(\.gz)?(\?.*)?$/i.test(loc)) {
          const normalized = normalizeUrl(loc, sitemapUrl);
          if (normalized && !seenSitemaps.has(normalized)) queue.push(normalized);
        } else {
          const added = enqueueUrl(scan, loc, sitemapUrl, 'sitemap');
          if (added) scan.stats.sitemapUrlsAdded += 1;
        }
      }
    } catch (error) {
      if (!scan.cancelled) {
        scan.errors.push({ url: sitemapUrl, message: `Sitemap read failed: ${error.message}`, at: nowIso() });
      }
    }
  }
}

function extractLocs(xml) {
  const locs = [];
  const regex = /<loc[^>]*>([\s\S]*?)<\/loc>/gi;
  let match;
  while ((match = regex.exec(String(xml || '')))) {
    const loc = decodeEntities(match[1]).trim();
    if (loc) locs.push(loc);
  }
  return locs;
}

function extractLinks(html, pageUrl) {
  const anchors = extractOpenTags(html, 'a').map(tag => ({ tag, attrs: parseAttrs(tag), type: 'anchor' }));
  const links = extractOpenTags(html, 'link').map(tag => ({ tag, attrs: parseAttrs(tag), type: 'link' }));
  const scripts = extractOpenTags(html, 'script').map(tag => ({ tag, attrs: parseAttrs(tag), type: 'script' }));
  const images = extractOpenTags(html, 'img').map(tag => ({ tag, attrs: parseAttrs(tag), type: 'img' }));
  const sources = extractOpenTags(html, 'source').map(tag => ({ tag, attrs: parseAttrs(tag), type: 'source' }));
  const iframes = extractOpenTags(html, 'iframe').map(tag => ({ tag, attrs: parseAttrs(tag), type: 'iframe' }));
  const embeds = extractOpenTags(html, 'embed').map(tag => ({ tag, attrs: parseAttrs(tag), type: 'embed' }));
  const objects = extractOpenTags(html, 'object').map(tag => ({ tag, attrs: parseAttrs(tag), type: 'object' }));
  const videos = extractOpenTags(html, 'video').map(tag => ({ tag, attrs: parseAttrs(tag), type: 'video' }));
  const tracks = extractOpenTags(html, 'track').map(tag => ({ tag, attrs: parseAttrs(tag), type: 'track' }));

  const linkItems = [...anchors, ...links, ...scripts, ...images, ...sources, ...iframes, ...embeds, ...objects, ...videos, ...tracks]
    .map(item => {
      const raw = item.attrs.href || item.attrs.src || item.attrs.data || '';
      const normalized = normalizeUrl(raw, pageUrl);
      return normalized ? { ...item, url: normalized, raw } : null;
    })
    .filter(Boolean);

  const srcsetUrls = [];
  [...images, ...sources].forEach(item => {
    if (!item.attrs.srcset) return;
    item.attrs.srcset.split(',').forEach(part => {
      const raw = part.trim().split(/\s+/)[0];
      const normalized = normalizeUrl(raw, pageUrl);
      if (normalized) srcsetUrls.push({ ...item, url: normalized, raw, type: `${item.type}:srcset` });
    });
  });

  return {
    anchors,
    linkItems: [...linkItems, ...srcsetUrls],
    allUrls: [...new Set([...linkItems.map(i => i.url), ...srcsetUrls.map(i => i.url)])]
  };
}

async function analyzeHtml(scan, pageUrl, html, links) {
  if (scan.cancelled) return;
  const text = stripHtml(html);

  analyzeTerms(scan, pageUrl, text);
  analyzePhrases(scan, pageUrl, text);
  analyzeImages(scan, pageUrl, html, links);
  analyzeVideos(scan, pageUrl, html, links);
  await analyzePdfs(scan, pageUrl, links);
  await analyzeLinks(scan, pageUrl, links);
  analyzeMetadata(scan, pageUrl, html);
  analyzeSeo(scan, pageUrl, html);
  analyzeForms(scan, pageUrl, html);
  analyzeAccessibility(scan, pageUrl, html);
}

function analyzeTerms(scan, pageUrl, text) {
  if (!selected(scan, 'term') || !scan.options.terms.length) return;
  const settings = selectedDetails(scan, 'term');
  for (const term of scan.options.terms) {
    if (textIncludes(text, term, settings)) {
      addResult(scan, {
        pageUrl,
        contentType: 'Term',
        matchDetail: term,
        assetType: 'HTML Text',
        status: 'Matched',
        context: contentSnippet(text, term)
      });
    }
  }
}

function analyzePhrases(scan, pageUrl, text) {
  if (!selected(scan, 'phrase') || !scan.options.phrases.length) return;
  const settings = { ...selectedDetails(scan, 'phrase'), proximityDistance: scan.options.proximityDistance };
  for (const phrase of scan.options.phrases) {
    if (phraseFound(text, phrase, settings)) {
      addResult(scan, {
        pageUrl,
        contentType: 'Phrase',
        matchDetail: phrase,
        assetType: 'HTML Text',
        status: 'Matched',
        context: contentSnippet(text, phrase)
      });
    }
  }
}

function imageDetailAllows(scan, ext) {
  const clean = ext.replace('.', '').toLowerCase();
  if (!clean) return true;
  if (clean === 'jpg' || clean === 'jpeg') return detail(scan, 'images', 'jpg') || detail(scan, 'images', 'jpeg');
  return detail(scan, 'images', clean);
}

function analyzeImages(scan, pageUrl, html, links) {
  if (!selected(scan, 'images')) return;
  const imgTags = extractOpenTags(html, 'img');
  const sourceTags = extractOpenTags(html, 'source');
  const tags = [...imgTags.map(tag => ({ tag, sourceTag: false })), ...sourceTags.map(tag => ({ tag, sourceTag: true }))];

  tags.forEach(item => {
    const attrs = parseAttrs(item.tag);
    const src = attrs.src || attrs['data-src'] || attrs.srcset || '';
    const firstSrc = src.split(',')[0].trim().split(/\s+/)[0];
    const imgUrl = normalizeUrl(firstSrc, pageUrl) || '';
    const ext = getExtension(imgUrl);
    const imageKind = ext ? ext.replace('.', '').toUpperCase() : 'Image';

    if (imgUrl && imageDetailAllows(scan, ext)) {
      scan.stats.imagesDetected += 1;
      addResult(scan, {
        pageUrl,
        contentType: 'Images',
        matchDetail: attrs.alt ? `Image ${imageKind} with alt text` : `Image ${imageKind}`,
        assetType: `${imageKind} Image`,
        status: 'Detected',
        assetUrl: imgUrl,
        context: attrs.alt || attrs.title || ''
      });
    }

    if (!item.sourceTag && detail(scan, 'images', 'missingAlt') && !('alt' in attrs)) {
      addResult(scan, {
        pageUrl,
        contentType: 'Images',
        matchDetail: 'Missing alt attribute',
        assetType: 'Accessibility Issue',
        status: 'Needs Review',
        assetUrl: imgUrl,
        context: item.tag.slice(0, 180)
      });
    }

    if (!item.sourceTag && detail(scan, 'images', 'alt') && attrs.alt) {
      addResult(scan, {
        pageUrl,
        contentType: 'Images',
        matchDetail: `Alt text: ${attrs.alt}`,
        assetType: 'Image Alt Text',
        status: 'Matched',
        assetUrl: imgUrl,
        context: attrs.alt
      });
    }
  });
}

function splitClasses(value = '') {
  return String(value || '').split(/\s+/).map(item => item.trim()).filter(Boolean);
}

function titleCase(value = '') {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function cleanTypeName(value = '') {
  const cleaned = decodeEntities(String(value || ''))
    .replace(/^block--?/i, '')
    .replace(/^paragraph--type--/i, '')
    .replace(/^paragraph--?/i, '')
    .replace(/^component--?/i, '')
    .replace(/^layout--?/i, '')
    .replace(/^region--?/i, '')
    .replace(/^views?-?/i, '')
    .replace(/^field--name--?/i, '')
    .replace(/^js[-_]/i, '')
    .replace(/^uagc[-_]/i, '')
    .replace(/^node--?/i, '')
    .replace(/^data[-_]?/i, '')
    .replace(/--view-mode-.+$/i, '')
    .replace(/__.+$/i, '')
    .replace(/[^a-z0-9_-]+/gi, ' ')
    .trim();
  return titleCase(cleaned);
}

const GENERIC_CMS_TYPES = new Set([
  'Block', 'Component', 'Container', 'Content', 'Wrapper', 'Inner', 'Row', 'Column', 'Columns', 'Section',
  'Layout', 'Region', 'Page', 'Main', 'Body', 'View', 'Views', 'Paragraph', 'Html', 'Field', 'Node', 'Grid',
  'Clearfix', 'Active', 'Contextual Region', 'Visually Hidden', 'Table'
]);

function addType(types, value) {
  const label = cleanTypeName(value);
  if (!label || label.length < 2 || label.length > 90 || GENERIC_CMS_TYPES.has(label)) return;
  types.add(label);
}

function extractCmsTypes(attrs = {}, mode = 'block') {
  const types = new Set();
  const attrNames = mode === 'table'
    ? ['data-table-type', 'data-component', 'data-component-name', 'data-content-type', 'data-module', 'data-module-type', 'data-view', 'data-entity-bundle', 'data-bundle', 'data-drupal-selector', 'data-testid', 'data-cy']
    : ['data-block', 'data-block-type', 'data-component', 'data-component-name', 'data-content-type', 'data-module', 'data-module-type', 'data-region', 'data-view', 'data-paragraph-type', 'data-entity-bundle', 'data-bundle', 'data-drupal-selector', 'data-drupal-block', 'data-testid', 'data-cy'];

  for (const name of attrNames) {
    if (attrs[name]) addType(types, attrs[name]);
  }

  if (attrs.id && /(^|[-_])(block|component|paragraph|module|region|layout|table|view)([-_]|$)/i.test(attrs.id)) {
    addType(types, attrs.id);
  }

  for (const className of splitClasses(attrs.class)) {
    if (mode === 'table') {
      if (/(^|[-_])(table|tablefield|datatable|data-table|responsive-table|comparison|tuition|fees|cost|accreditation|curriculum|program)([-_]|$)/i.test(className)) {
        addType(types, className);
      }
      continue;
    }

    if (/^(block|block--|paragraph--type--|paragraph|component|component--|module|module--|layout|layout--|region|region--|view|views|field--name|webform)([-_]|$)/i.test(className)) {
      addType(types, className);
    }
  }

  return [...types];
}

function hasBlockEvidence(attrs = {}, text = '') {
  const attrText = Object.entries(attrs).map(([key, value]) => `${key}=${value}`).join(' ');
  if (/(data-block|data-component|data-content-type|data-module|data-region|data-paragraph|data-drupal|data-entity-bundle)/i.test(attrText)) return true;
  if (/(^|\s)(block|block--|paragraph|paragraph--type--|component|component--|module|layout|region|views-element-container|webform)([-_\s]|$)/i.test(attrs.class || '')) return true;
  if (/^(block|paragraph|component|module|region|layout|view)[-_]/i.test(attrs.id || '')) return true;
  return false;
}

function blockContext(block) {
  const attrs = [];
  if (block.attrs.id) attrs.push(`id=${block.attrs.id}`);
  if (block.attrs.class) attrs.push(`class=${block.attrs.class}`);
  const attrText = attrs.join(' | ');
  const text = block.text.slice(0, 180);
  return attrText ? `${attrText} | ${text}`.slice(0, 260) : text;
}

function analyzeVideos(scan, pageUrl, html, links) {
  if (!selected(scan, 'videos')) return;

  links.linkItems.forEach(item => {
    const url = item.url;
    const ext = getExtension(url);
    if (detail(scan, 'videos', 'youtube') && /youtube\.com|youtu\.be|vimeo\.com/i.test(url)) {
      scan.stats.videosDetected += 1;
      addResult(scan, {
        pageUrl,
        contentType: 'Videos',
        matchDetail: /youtube/i.test(url) ? 'YouTube embed' : 'Video embed',
        assetType: 'Embedded Video',
        status: 'Detected',
        assetUrl: url,
        context: item.tag.slice(0, 180)
      });
    }
    if (detail(scan, 'videos', 'html5') && VIDEO_EXTENSIONS.includes(ext)) {
      scan.stats.videosDetected += 1;
      addResult(scan, {
        pageUrl,
        contentType: 'Videos',
        matchDetail: `HTML5 video ${ext.toUpperCase().replace('.', '')}`,
        assetType: 'Video File',
        status: 'Detected',
        assetUrl: url,
        context: item.tag.slice(0, 180)
      });
    }
  });

  const trackTags = extractOpenTags(html, 'track');
  trackTags.forEach(tag => {
    const attrs = parseAttrs(tag);
    const kind = String(attrs.kind || '').toLowerCase();
    const src = normalizeUrl(attrs.src || '', pageUrl);
    if (detail(scan, 'videos', 'captions') && /caption|subtitle/.test(kind)) {
      addResult(scan, {
        pageUrl,
        contentType: 'Videos',
        matchDetail: `${kind || 'Caption'} track`,
        assetType: 'Video Captions',
        status: 'Detected',
        assetUrl: src,
        context: tag.slice(0, 180)
      });
    }
  });

  if (detail(scan, 'videos', 'transcript') && /transcript/i.test(stripHtml(html))) {
    addResult(scan, {
      pageUrl,
      contentType: 'Videos',
      matchDetail: 'Transcript reference',
      assetType: 'Transcript Text',
      status: 'Detected',
      context: contentSnippet(stripHtml(html), 'transcript')
    });
  }
}

async function analyzePdfs(scan, pageUrl, links) {
  if (!selected(scan, 'pdf')) return;
  const pdfItems = links.linkItems.filter(item => looksLikePdf(item.url));
  for (const item of pdfItems) {
    const isSame = sameHost(item.url, scan.host);
    if (!isSame && !scan.includeExternalPdfs) continue;
    scan.stats.pdfsDetected += 1;
    let sizeText = '';
    if (detail(scan, 'pdf', 'fileSize')) {
      const size = await tryHeadSize(scan, item.url);
      if (size) sizeText = ` (${formatBytes(size)})`;
    }
    const isEmbedded = /iframe|embed|object/i.test(item.type);
    const isDownloadable = /download/i.test(item.tag) || /download/i.test(item.attrs.download || '');

    if ((isEmbedded && detail(scan, 'pdf', 'embedded')) || (!isEmbedded && detail(scan, 'pdf', 'linked')) || (isDownloadable && detail(scan, 'pdf', 'downloadable'))) {
      addResult(scan, {
        pageUrl,
        contentType: 'PDF',
        matchDetail: `${isEmbedded ? 'Embedded' : 'Linked'} PDF${sizeText}`,
        assetType: isEmbedded ? 'Embedded PDF' : 'PDF File',
        status: 'Detected',
        assetUrl: item.url,
        context: item.tag.slice(0, 180)
      });
    }
  }
}

async function analyzeLinks(scan, pageUrl, links) {
  if (!selected(scan, 'links')) return;
  const anchorItems = links.anchors
    .map(item => ({ ...item, url: normalizeUrl(item.attrs.href || '', pageUrl) }))
    .filter(item => item.url);

  let checkedCount = 0;
  for (const item of anchorItems) {
    const isInternal = sameHost(item.url, scan.host);
    if (isInternal && detail(scan, 'links', 'internal')) {
      addResult(scan, {
        pageUrl,
        contentType: 'Links',
        matchDetail: 'Internal link',
        assetType: 'Anchor Link',
        status: 'Detected',
        assetUrl: item.url,
        context: stripHtml(item.tag).slice(0, 180)
      });
    }
    if (!isInternal && detail(scan, 'links', 'external')) {
      addResult(scan, {
        pageUrl,
        contentType: 'Links',
        matchDetail: 'External link',
        assetType: 'Anchor Link',
        status: 'Detected',
        assetUrl: item.url,
        context: stripHtml(item.tag).slice(0, 180)
      });
    }
    if (detail(scan, 'links', 'broken') && checkedCount < MAX_LINK_CHECKS_PER_PAGE) {
      checkedCount += 1;
      const status = await checkLinkStatus(scan, item.url);
      if (status.broken) {
        addResult(scan, {
          pageUrl,
          contentType: 'Links',
          matchDetail: status.label,
          assetType: 'Broken Link',
          status: 'Broken',
          assetUrl: item.url,
          context: stripHtml(item.tag).slice(0, 180)
        });
      }
    }
  }
}

async function checkLinkStatus(scan, urlString) {
  if (scan.linkStatusCache.has(urlString)) return scan.linkStatusCache.get(urlString);
  const promise = (async () => {
    try {
      const response = await fetchWithTimeout(urlString, LINK_TIMEOUT_MS, { method: 'HEAD', cancelSignal: scan.abortController.signal, controllerSet: scan.fetchControllers });
      if (response.status === 405) {
        const getResponse = await fetchWithTimeout(urlString, LINK_TIMEOUT_MS, { method: 'GET', cancelSignal: scan.abortController.signal, controllerSet: scan.fetchControllers });
        return { broken: getResponse.status >= 400, label: `HTTP ${getResponse.status}` };
      }
      return { broken: response.status >= 400, label: `HTTP ${response.status}` };
    } catch (error) {
      return { broken: true, label: `Request failed: ${error.message}` };
    }
  })();
  scan.linkStatusCache.set(urlString, promise);
  const resolved = await promise;
  scan.linkStatusCache.set(urlString, resolved);
  return resolved;
}

async function tryHeadSize(scan, urlString) {
  try {
    const response = await fetchWithTimeout(urlString, LINK_TIMEOUT_MS, { method: 'HEAD', cancelSignal: scan.abortController.signal, controllerSet: scan.fetchControllers });
    const size = Number(response.headers.get('content-length') || 0);
    return size > 0 ? size : 0;
  } catch (_) {
    return 0;
  }
}

function analyzeMetadata(scan, pageUrl, html) {
  if (!selected(scan, 'metadata')) return;
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaTags = extractOpenTags(html, 'meta').map(tag => parseAttrs(tag));
  const linkTags = extractOpenTags(html, 'link').map(tag => parseAttrs(tag));
  const description = metaTags.find(attrs => /description/i.test(attrs.name || ''))?.content || '';
  const robots = metaTags.find(attrs => /robots/i.test(attrs.name || ''))?.content || '';
  const canonical = linkTags.find(attrs => /canonical/i.test(attrs.rel || ''))?.href || '';

  if (detail(scan, 'metadata', 'title')) {
    addResult(scan, { pageUrl, contentType: 'Metadata', matchDetail: title ? `Title: ${title}` : 'Missing title tag', assetType: 'Title Tag', status: title ? 'Matched' : 'Needs Review', context: title });
  }
  if (detail(scan, 'metadata', 'description')) {
    addResult(scan, { pageUrl, contentType: 'Metadata', matchDetail: description ? 'Meta description found' : 'Missing meta description', assetType: 'Meta Tag', status: description ? 'Matched' : 'Needs Review', context: description });
  }
  if (detail(scan, 'metadata', 'canonical')) {
    addResult(scan, { pageUrl, contentType: 'Metadata', matchDetail: canonical ? `Canonical: ${canonical}` : 'Missing canonical link', assetType: 'Canonical Link', status: canonical ? 'Matched' : 'Needs Review', assetUrl: normalizeUrl(canonical, pageUrl), context: canonical });
  }
  if (detail(scan, 'metadata', 'robots')) {
    addResult(scan, { pageUrl, contentType: 'Metadata', matchDetail: robots ? `Robots: ${robots}` : 'No robots meta tag', assetType: 'Robots Meta', status: robots ? 'Detected' : 'Not Found', context: robots });
  }
  if (detail(scan, 'metadata', 'openGraph')) {
    const ogTags = metaTags.filter(attrs => /^og:/i.test(attrs.property || attrs.name || ''));
    addResult(scan, {
      pageUrl,
      contentType: 'Metadata',
      matchDetail: ogTags.length ? `Open Graph tags: ${ogTags.length}` : 'No Open Graph tags',
      assetType: 'Social Metadata',
      status: ogTags.length ? 'Detected' : 'Needs Review',
      context: ogTags.map(attrs => `${attrs.property || attrs.name}=${attrs.content || ''}`).join(' | ').slice(0, 220)
    });
  }
}

function analyzeSeo(scan, pageUrl, html) {
  if (!selected(scan, 'seo')) return;
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaTags = extractOpenTags(html, 'meta').map(tag => parseAttrs(tag));
  const linkTags = extractOpenTags(html, 'link').map(tag => parseAttrs(tag));
  const description = metaTags.find(attrs => /description/i.test(attrs.name || ''))?.content || '';
  const robots = metaTags.find(attrs => /robots/i.test(attrs.name || ''))?.content || '';
  const canonical = linkTags.find(attrs => /canonical/i.test(attrs.rel || ''))?.href || '';

  if (detail(scan, 'seo', 'missingTitle') && !title) {
    addResult(scan, { pageUrl, contentType: 'SEO', matchDetail: 'Missing title tag', assetType: 'SEO Issue', status: 'Needs Review', context: 'No <title> element detected.' });
  }
  if (detail(scan, 'seo', 'missingMetaDescription') && !description) {
    addResult(scan, { pageUrl, contentType: 'SEO', matchDetail: 'Missing meta description', assetType: 'SEO Issue', status: 'Needs Review', context: 'No meta description detected.' });
  }
  if (detail(scan, 'seo', 'noindex') && /noindex/i.test(robots)) {
    addResult(scan, { pageUrl, contentType: 'SEO', matchDetail: 'Noindex directive', assetType: 'SEO Directive', status: 'Detected', context: robots });
  }
  if (detail(scan, 'seo', 'missingCanonical') && !canonical) {
    addResult(scan, { pageUrl, contentType: 'SEO', matchDetail: 'Missing canonical link', assetType: 'SEO Issue', status: 'Needs Review', context: 'No rel=canonical link detected.' });
  }
}

function analyzeForms(scan, pageUrl, html) {
  if (!selected(scan, 'forms')) return;
  const forms = extractPairedTags(html, 'form');
  forms.forEach(form => {
    const h = fingerprintBlock(form.attrs, form.text);
    const action = normalizeUrl(form.attrs.action || '', pageUrl) || form.attrs.action || '';
    const matches = [
      ['inquiry', /inquiry|request information|rfi|contact|get info/i, 'Inquiry form'],
      ['lead', /lead|marketo|salesforce|pardot|hubspot/i, 'Lead form'],
      ['application', /apply|application|admission/i, 'Application form']
    ];
    matches.forEach(([key, regex, label]) => {
      if (detail(scan, 'forms', key) && regex.test(h + ' ' + action)) {
        addResult(scan, {
          pageUrl,
          contentType: 'Forms',
          matchDetail: label,
          assetType: 'HTML Form',
          status: 'Detected',
          assetUrl: action,
          context: form.text.slice(0, 220) || form.full.slice(0, 220)
        });
      }
    });
  });
}

function analyzeAccessibility(scan, pageUrl, html) {
  if (!selected(scan, 'accessibility')) return;
  if (detail(scan, 'accessibility', 'emptyHeadings')) {
    ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach(tag => {
      extractPairedTags(html, tag).forEach(heading => {
        if (!heading.text.trim()) {
          addResult(scan, {
            pageUrl,
            contentType: 'Accessibility',
            matchDetail: `Empty ${tag.toUpperCase()} heading`,
            assetType: 'Heading Issue',
            status: 'Needs Review',
            context: heading.full.slice(0, 180)
          });
        }
      });
    });
  }

  if (detail(scan, 'accessibility', 'duplicateIds')) {
    const ids = new Map();
    const allOpenTags = String(html).match(/<[^/!][^>]*>/g) || [];
    allOpenTags.forEach(tag => {
      const attrs = parseAttrs(tag);
      if (attrs.id) ids.set(attrs.id, (ids.get(attrs.id) || 0) + 1);
    });
    ids.forEach((count, id) => {
      if (count > 1) {
        addResult(scan, {
          pageUrl,
          contentType: 'Accessibility',
          matchDetail: `Duplicate id: ${id}`,
          assetType: 'DOM Issue',
          status: 'Needs Review',
          context: `${count} elements use id="${id}"`
        });
      }
    });
  }

  if (detail(scan, 'accessibility', 'missingLabels')) {
    const inputs = extractOpenTags(html, 'input').map(tag => ({ tag, attrs: parseAttrs(tag) }));
    const labels = extractPairedTags(html, 'label').map(label => label.attrs.for).filter(Boolean);
    const labelSet = new Set(labels);
    inputs.forEach(input => {
      const type = String(input.attrs.type || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset'].includes(type)) return;
      if (!input.attrs['aria-label'] && !input.attrs['aria-labelledby'] && (!input.attrs.id || !labelSet.has(input.attrs.id))) {
        addResult(scan, {
          pageUrl,
          contentType: 'Accessibility',
          matchDetail: 'Input missing accessible label',
          assetType: 'Form Accessibility',
          status: 'Needs Review',
          context: input.tag.slice(0, 180)
        });
      }
    });
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendError(res, error) {
  const status = error.statusCode || 500;
  sendJson(res, status, { error: error.message || 'Unexpected server error' });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error('Request body too large.'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === '/') pathname = '/index.html';

  const requestedPath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!requestedPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(requestedPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(requestedPath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
    });
    res.end(data);
  });
}

function getScanOrThrow(id) {
  const scan = activeScans.get(id);
  if (!scan) {
    const error = new Error('Scan not found.');
    error.statusCode = 404;
    throw error;
  }
  return scan;
}

async function handleApi(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;

  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true, app: 'UAGC WebScraper', activeScans: activeScans.size });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/scan/start') {
      const options = await parseBody(req);
      const scan = launchScan(options);
      sendJson(res, 201, { id: scan.id, status: scan.status, snapshot: snapshot(scan) });
      return;
    }

    const match = pathname.match(/^\/api\/scan\/([^/]+)(?:\/(.+))?$/);
    if (!match) {
      sendJson(res, 404, { error: 'API route not found.' });
      return;
    }

    const scan = getScanOrThrow(match[1]);
    const action = match[2] || 'status';

    if (req.method === 'GET' && action === 'status') {
      sendJson(res, 200, snapshot(scan));
      return;
    }

    if (req.method === 'GET' && action === 'events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write(`data: ${JSON.stringify(snapshot(scan))}\n\n`);
      scan.clients.add(res);
      const heartbeat = setInterval(() => {
        try { res.write(': keep-alive\n\n'); } catch (_) { clearInterval(heartbeat); }
      }, 15000);
      req.on('close', () => {
        clearInterval(heartbeat);
        scan.clients.delete(res);
      });
      return;
    }

    if (req.method === 'POST' && action === 'pause') {
      scan.paused = true;
      scan.status = 'paused';
      broadcast(scan);
      sendJson(res, 200, snapshot(scan));
      return;
    }

    if (req.method === 'POST' && action === 'resume') {
      scan.paused = false;
      scan.status = 'running';
      broadcast(scan);
      sendJson(res, 200, snapshot(scan));
      return;
    }

    if (req.method === 'POST' && action === 'stop') {
      cancelScan(scan);
      sendJson(res, 200, snapshot(scan));
      return;
    }

    if (req.method === 'GET' && action === 'progress.json') {
      const body = JSON.stringify(snapshot(scan), null, 2);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${jsonFileName()}"`,
        'cache-control': 'no-store'
      });
      res.end(body);
      return;
    }

    if (req.method === 'POST' && action === 'result-edits') {
      const body = await parseBody(req);
      const saved = saveResultEdits(scan, body.updates || []);
      broadcast(scan);
      sendJson(res, 200, { ok: true, ...saved, snapshot: snapshot(scan) });
      return;
    }

    if (req.method === 'GET' && action === 'results.csv') {
      const requestedName = String(requestUrl.searchParams.get('filename') || '').trim();
      const safeName = requestedName
        ? requestedName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_')
        : csvFileName();
      const filename = safeName.toLowerCase().endsWith('.csv') ? safeName : `${safeName}.csv`;
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store'
      });
      await streamEditableCsv(scan, res);
      return;
    }

    sendJson(res, 404, { error: 'Scan action not found.' });
  } catch (error) {
    sendError(res, error);
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    handleApi(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`UAGC WebScraper running at http://localhost:${PORT}`);
  console.log(`Worker concurrency: ${DEFAULT_WORKERS}. Private network scans allowed: ${ALLOW_PRIVATE_NETWORKS}`);
});
