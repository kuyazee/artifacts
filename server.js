import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import AdmZip from 'adm-zip';
import express from 'express';
import { marked } from 'marked';
import { customAlphabet } from 'nanoid';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const API_KEY = process.env.ARTIFACTS_API_KEY;

if (!API_KEY) {
  console.error('ARTIFACTS_API_KEY env var is required');
  process.exit(1);
}

const ARTIFACTS_DIR = path.join(DATA_DIR, 'artifacts');
await fs.mkdir(ARTIFACTS_DIR, { recursive: true });

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 10);

// ---------------------------------------------------------------------------
// Server config (DATA_DIR/config.json) — global frame settings
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

function boolEnv(name) {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v === '1' || v.toLowerCase() === 'true';
}

const DEFAULT_CONFIG = {
  frame: {
    enabled: boolEnv('FRAME_ENABLED') ?? true,
    default: boolEnv('FRAME_DEFAULT') ?? true,
  },
};

function normalizeConfig(raw) {
  const frame = raw?.frame || {};
  return {
    frame: {
      enabled: typeof frame.enabled === 'boolean' ? frame.enabled : DEFAULT_CONFIG.frame.enabled,
      default: typeof frame.default === 'boolean' ? frame.default : DEFAULT_CONFIG.frame.default,
    },
  };
}

async function loadConfig() {
  try {
    return normalizeConfig(JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8')));
  } catch {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return DEFAULT_CONFIG;
  }
}

let config = await loadConfig();

async function updateConfig(patch) {
  const frame = patch?.frame || {};
  for (const key of ['enabled', 'default']) {
    if (frame[key] !== undefined && typeof frame[key] !== 'boolean') {
      throw new ApiError(400, `frame.${key} must be a boolean`);
    }
  }
  config = {
    frame: {
      enabled: frame.enabled ?? config.frame.enabled,
      default: frame.default ?? config.frame.default,
    },
  };
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
  return config;
}

// Whether the viewer frame is shown for this artifact: global master switch
// AND (per-item override, or the global default when the item has no override).
function frameActive(meta) {
  return config.frame.enabled && (typeof meta.frame === 'boolean' ? meta.frame : config.frame.default);
}

const JSX_SHELL = await fs.readFile(path.join(__dirname, 'shells', 'jsx.html'), 'utf8');
const MD_SHELL = await fs.readFile(path.join(__dirname, 'shells', 'md.html'), 'utf8');
const FRAME_SHELL = await fs.readFile(path.join(__dirname, 'shells', 'frame.html'), 'utf8');

const TYPES = ['html', 'jsx', 'tsx', 'md'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_TAGS = 10;
// A project is a single grouping label (one per artifact). Friendlier than a
// slug — Unicode letters/digits, spaces, and - _ . — but bounded, and must
// start with a letter or digit. Internal whitespace is collapsed on input.
const PROJECT_RE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} ._-]{0,63}$/u;
const SOURCE_EXT = { html: 'html', jsx: 'jsx', tsx: 'tsx', md: 'md' };

// Pinned versions shared with the jsx shell. `external=react` keeps packages on
// the shell's React instance — separate copies cause "Invalid hook call".
const BASE_IMPORT_MAP = {
  react: 'https://esm.sh/react@18.3.1',
  'react/jsx-runtime': 'https://esm.sh/react@18.3.1/jsx-runtime',
  'react-dom': 'https://esm.sh/react-dom@18.3.1',
  'react-dom/client': 'https://esm.sh/react-dom@18.3.1/client',
  recharts: 'https://esm.sh/recharts@2.15.0?external=react,react-dom',
  'lucide-react': 'https://esm.sh/lucide-react@0.462.0?external=react',
};

function buildJsxHtml(source, title) {
  const imports = { ...BASE_IMPORT_MAP };
  const importRe = /^\s*import\s+(?:[\w${},*\s]+from\s+)?['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(importRe)) {
    const spec = match[1];
    if (spec.startsWith('.') || spec.startsWith('/') || imports[spec]) continue;
    imports[spec] = `https://esm.sh/${spec}?external=react,react-dom`;
  }

  if (!/export\s+default\s/.test(source)) {
    throw new ApiError(400, 'jsx/tsx artifact must have a default export');
  }
  const rewritten = source
    .replace(/export\s+default\s+/, 'const __ArtifactDefault = ')
    .replaceAll('</script', '<\\/script');

  return JSX_SHELL
    .replace('{{TITLE}}', escapeHtml(title))
    .replace('{{IMPORT_MAP}}', JSON.stringify({ imports }, null, 2))
    .replace('{{SOURCE}}', rewritten);
}

function buildMdHtml(source, title) {
  return MD_SHELL
    .replace('{{TITLE}}', escapeHtml(title))
    .replace('{{CONTENT}}', marked.parse(source));
}

// Parent "frame" page: a slim toolbar with the artifact loaded in an iframe.
// Function replacements avoid `$`-substitution in the escaped values.
function buildFrameHtml(meta, rawUrl) {
  const title = escapeHtml(meta.title || meta.slug);
  const url = escapeHtml(rawUrl);
  return FRAME_SHELL
    .replaceAll('{{TITLE}}', () => title)
    .replaceAll('{{RAW_URL}}', () => url);
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function artifactDir(slug) {
  return path.join(ARTIFACTS_DIR, slug);
}

async function readMeta(slug) {
  try {
    return JSON.parse(await fs.readFile(path.join(artifactDir(slug), 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Zip sites
// ---------------------------------------------------------------------------

const ZIP_ALLOWED_EXT = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'json', 'txt', 'md', 'xml', 'csv',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'avif',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'wav', 'ogg', 'mp4', 'webm', 'pdf', 'wasm', 'map', 'webmanifest',
]);
const ZIP_MAX_FILES = 2000;
const ZIP_MAX_UNCOMPRESSED = 100 * 1024 * 1024;

// Validates the archive is a hostable static site and returns {relPath, entry}
// pairs, with a single shared top-level folder stripped if present.
function extractSiteFiles(zip) {
  const entries = zip
    .getEntries()
    .filter((e) => !e.isDirectory)
    .filter((e) => {
      const name = e.entryName;
      const base = path.posix.basename(name);
      return !name.startsWith('__MACOSX/') && base !== '.DS_Store' && base !== 'Thumbs.db';
    });

  if (!entries.length) throw new ApiError(400, 'zip contains no files');
  if (entries.length > ZIP_MAX_FILES) {
    throw new ApiError(400, `zip has too many files (${entries.length} > ${ZIP_MAX_FILES})`);
  }

  let totalSize = 0;
  for (const e of entries) {
    const name = e.entryName;
    if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..')) {
      throw new ApiError(400, `unsafe path in zip: ${name}`);
    }
    if (((e.attr >>> 16) & 0xf000) === 0xa000) {
      throw new ApiError(400, `symlinks not allowed in zip: ${name}`);
    }
    totalSize += e.header.size;
  }
  if (totalSize > ZIP_MAX_UNCOMPRESSED) {
    throw new ApiError(400, 'zip uncompressed size exceeds 100 MB');
  }

  // If everything lives in one top-level folder (common when zipping a dir), strip it.
  const tops = new Set(entries.map((e) => e.entryName.split('/')[0]));
  const strip = tops.size === 1 && entries.every((e) => e.entryName.includes('/'))
    ? `${[...tops][0]}/`
    : '';
  const files = entries.map((e) => ({ relPath: e.entryName.slice(strip.length), entry: e }));

  const unsupported = files
    .map((f) => f.relPath)
    .filter((p) => !ZIP_ALLOWED_EXT.has(path.posix.extname(p).slice(1).toLowerCase()));
  if (unsupported.length) {
    throw new ApiError(
      400,
      `unsupported files for static hosting: ${unsupported.slice(0, 10).join(', ')}` +
        (unsupported.length > 10 ? ` (+${unsupported.length - 10} more)` : ''),
    );
  }

  if (!files.some((f) => f.relPath === 'index.html')) {
    throw new ApiError(400, 'zip must contain index.html at its root');
  }
  return files;
}

async function saveZipArtifact(buffer, { slug, title, expiresAt, tags, project }) {
  if (slug !== undefined && !SLUG_RE.test(slug)) {
    throw new ApiError(400, 'slug must match [a-z0-9][a-z0-9-]{2,63}');
  }
  const expiry = expiresAt !== undefined ? parseExpiresAt(expiresAt) : undefined;
  const tagList = tags !== undefined ? parseTags(tags) : undefined;
  const projectName = project !== undefined ? parseProject(project) : undefined;

  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new ApiError(400, 'invalid zip file');
  }
  const files = extractSiteFiles(zip);

  const finalSlug = slug || nanoid();
  if (await readMeta(finalSlug)) {
    throw new ApiError(409, `slug "${finalSlug}" already exists`);
  }

  const siteDir = path.join(artifactDir(finalSlug), 'site');
  for (const { relPath, entry } of files) {
    const target = path.join(siteDir, relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, entry.getData());
  }
  const meta = {
    slug: finalSlug,
    type: 'zip',
    title: title || finalSlug,
    files: files.length,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (expiry !== undefined) meta.expiresAt = expiry;
  if (tagList?.length) meta.tags = tagList;
  if (projectName) meta.project = projectName;
  await fs.writeFile(path.join(artifactDir(finalSlug), 'meta.json'), JSON.stringify(meta, null, 2));
  return { slug: finalSlug, url: `${BASE_URL}/a/${finalSlug}/`, files: files.length };
}

// Accepts an array of strings or a comma-separated string (JSON bodies, zip
// query params, and CLI flags all funnel through here). Returns a deduped,
// lowercased array; empty means "clear".
function parseTags(value) {
  if (value === null) return [];
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null;
  if (!raw || raw.some((t) => typeof t !== 'string')) {
    throw new ApiError(400, 'tags must be an array of strings or a comma-separated string');
  }
  const tags = [...new Set(raw.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  for (const tag of tags) {
    if (!TAG_RE.test(tag)) {
      throw new ApiError(400, `invalid tag "${tag}" — tags must match [a-z0-9][a-z0-9-]{0,31}`);
    }
  }
  if (tags.length > MAX_TAGS) {
    throw new ApiError(400, `too many tags (${tags.length} > ${MAX_TAGS})`);
  }
  return tags;
}

// Returns a trimmed project name, or '' to clear it. null/'' both mean clear.
function parseProject(value) {
  if (value === null) return '';
  if (typeof value !== 'string') {
    throw new ApiError(400, 'project must be a string');
  }
  const project = value.trim().replace(/\s+/g, ' '); // collapse internal whitespace
  if (!project) return '';
  if (!PROJECT_RE.test(project)) {
    throw new ApiError(
      400,
      'project must be 1–64 chars of letters, digits, spaces, and - _ . (starting with a letter or digit)',
    );
  }
  return project;
}

function parseExpiresAt(value) {
  if (value === null || value === '') return undefined;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ApiError(400, 'expiresAt must be an ISO 8601 date string or null');
  }
  return new Date(value).toISOString();
}

function isExpired(meta) {
  return Boolean(meta.expiresAt && Date.parse(meta.expiresAt) <= Date.now());
}

async function saveArtifact({ content, type = 'html', slug, title, expiresAt, frame, tags, project }, { replace = false } = {}) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new ApiError(400, 'content (non-empty string) is required');
  }
  if (frame !== undefined && typeof frame !== 'boolean') {
    throw new ApiError(400, 'frame must be a boolean');
  }
  const expiry = expiresAt !== undefined ? parseExpiresAt(expiresAt) : undefined;
  const tagList = tags !== undefined ? parseTags(tags) : undefined;
  const projectName = project !== undefined ? parseProject(project) : undefined;
  if (!TYPES.includes(type)) {
    throw new ApiError(400, `type must be one of: ${TYPES.join(', ')}`);
  }
  if (slug !== undefined && !SLUG_RE.test(slug)) {
    throw new ApiError(400, 'slug must match [a-z0-9][a-z0-9-]{2,63}');
  }
  const finalSlug = slug || nanoid();
  const dir = artifactDir(finalSlug);
  const existing = await readMeta(finalSlug);
  if (existing && !replace) {
    throw new ApiError(409, `slug "${finalSlug}" already exists`);
  }
  if (replace && !existing) {
    throw new ApiError(404, `slug "${finalSlug}" not found`);
  }
  if (existing?.type === 'zip') {
    throw new ApiError(400, 'cannot replace a zip site with inline content; delete and re-upload');
  }

  const finalTitle = title || finalSlug;
  let html;
  if (type === 'html') html = content;
  else if (type === 'md') html = buildMdHtml(content, finalTitle);
  else html = buildJsxHtml(content, finalTitle);

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.html'), html);
  await fs.writeFile(path.join(dir, `source.${SOURCE_EXT[type]}`), content);
  const meta = {
    ...existing,
    slug: finalSlug,
    type,
    title: finalTitle,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (expiresAt !== undefined) meta.expiresAt = expiry;
  if (frame !== undefined) meta.frame = frame;
  if (tagList !== undefined) meta.tags = tagList.length ? tagList : undefined;
  if (projectName !== undefined) meta.project = projectName || undefined;
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return { slug: finalSlug, url: `${BASE_URL}/a/${finalSlug}` };
}

async function listArtifacts({ tag, project } = {}) {
  const entries = await fs.readdir(ARTIFACTS_DIR, { withFileTypes: true });
  const metas = await Promise.all(
    entries.filter((e) => e.isDirectory()).map((e) => readMeta(e.name)),
  );
  let items = metas
    .filter(Boolean)
    .map((m) => ({ ...m, tags: m.tags || [] }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (tag !== undefined) {
    const wanted = String(tag).trim().toLowerCase();
    items = items.filter((a) => a.tags.includes(wanted));
  }
  if (project !== undefined) {
    const wanted = String(project).trim();
    items = items.filter((a) => (a.project || '') === wanted);
  }
  return items;
}

async function patchArtifact(slug, patch) {
  const meta = SLUG_RE.test(slug) ? await readMeta(slug) : null;
  if (!meta) {
    throw new ApiError(404, `slug "${slug}" not found`);
  }

  let dir = artifactDir(slug);
  if (patch.slug !== undefined && patch.slug !== slug) {
    if (!SLUG_RE.test(patch.slug)) {
      throw new ApiError(400, 'slug must match [a-z0-9][a-z0-9-]{2,63}');
    }
    if (await readMeta(patch.slug)) {
      throw new ApiError(409, `slug "${patch.slug}" already exists`);
    }
    await fs.rename(dir, artifactDir(patch.slug));
    meta.slug = patch.slug;
    dir = artifactDir(patch.slug);
  }

  if (patch.disabled !== undefined) {
    if (typeof patch.disabled !== 'boolean') {
      throw new ApiError(400, 'disabled must be a boolean');
    }
    meta.disabled = patch.disabled || undefined;
  }

  if (patch.frame !== undefined) {
    if (patch.frame === null) {
      delete meta.frame; // reset to inherit the global default
    } else if (typeof patch.frame === 'boolean') {
      meta.frame = patch.frame;
    } else {
      throw new ApiError(400, 'frame must be a boolean or null');
    }
  }

  if (patch.expiresAt !== undefined) {
    meta.expiresAt = parseExpiresAt(patch.expiresAt);
  }

  if (patch.tags !== undefined) {
    const tags = parseTags(patch.tags);
    meta.tags = tags.length ? tags : undefined;
  }

  if (patch.project !== undefined) {
    const project = parseProject(patch.project);
    meta.project = project || undefined; // '' clears it
  }

  meta.updatedAt = new Date().toISOString();
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return { slug: meta.slug, url: `${BASE_URL}/a/${meta.slug}` };
}

async function deleteArtifact(slug) {
  if (!SLUG_RE.test(slug) || !(await readMeta(slug))) {
    throw new ApiError(404, `slug "${slug}" not found`);
  }
  await fs.rm(artifactDir(slug), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));

// Whole domain is non-crawlable.
app.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(token);
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

const ARTIFACT_CSP = [
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  'https://esm.sh https://cdn.tailwindcss.com https://cdnjs.cloudflare.com',
  'https://unpkg.com https://cdn.jsdelivr.net;',
  "connect-src 'self' https://esm.sh;",
  "img-src * data: blob:",
].join(' ');

// The frame wrapper is our own page: inline styles/script + a same-origin iframe.
const FRAME_CSP = [
  "default-src 'self';",
  "style-src 'self' 'unsafe-inline';",
  "script-src 'self' 'unsafe-inline';",
  "img-src 'self' data:;",
  "frame-src 'self';",
].join(' ');

app.get('/a/:slug', async (req, res) => {
  const { slug } = req.params;
  const meta = SLUG_RE.test(slug) ? await readMeta(slug) : null;
  if (!meta || meta.disabled) {
    return res.status(404).type('text/plain').send('artifact not found');
  }
  if (isExpired(meta)) {
    return res.status(410).type('text/plain').send('artifact expired');
  }

  // Framed view: serve the wrapper page (toolbar + iframe → ?raw=1). `?raw=1`
  // is the escape hatch the iframe uses to load the bare artifact.
  const wantsRaw = req.query.raw !== undefined;
  if (frameActive(meta) && !wantsRaw) {
    if (meta.type === 'zip' && !req.path.endsWith('/')) {
      return res.redirect(301, `/a/${slug}/`);
    }
    const rawUrl = meta.type === 'zip' ? `/a/${slug}/?raw=1` : `/a/${slug}?raw=1`;
    res.set({
      'Content-Security-Policy': FRAME_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-cache',
    });
    return res.type('html').send(buildFrameHtml(meta, rawUrl));
  }

  res.set({
    'Content-Security-Policy': ARTIFACT_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-cache',
  });
  if (meta.type === 'zip') {
    // Trailing slash so relative asset URLs resolve inside the site; keep ?raw=1
    // so a slash-less raw URL doesn't bounce back into the frame.
    if (!req.path.endsWith('/')) {
      return res.redirect(301, `/a/${slug}/${wantsRaw ? '?raw=1' : ''}`);
    }
    return res.sendFile(path.join(artifactDir(slug), 'site', 'index.html'));
  }
  res.sendFile(path.join(artifactDir(slug), 'index.html'));
});

app.get('/a/:slug/source', async (req, res, next) => {
  const { slug } = req.params;
  const meta = SLUG_RE.test(slug) ? await readMeta(slug) : null;
  if (!meta || meta.disabled) return res.status(404).type('text/plain').send('artifact not found');
  if (isExpired(meta)) return res.status(410).type('text/plain').send('artifact expired');
  if (meta.type === 'zip') return next(); // zip sites serve /source as a site path
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.type('text/plain');
  res.sendFile(path.join(artifactDir(slug), `source.${SOURCE_EXT[meta.type]}`));
});

app.get('/a/:slug/*', async (req, res) => {
  const { slug } = req.params;
  const meta = SLUG_RE.test(slug) ? await readMeta(slug) : null;
  if (!meta || meta.disabled) return res.status(404).type('text/plain').send('artifact not found');
  if (isExpired(meta)) return res.status(410).type('text/plain').send('artifact expired');
  if (meta.type !== 'zip') return res.status(404).type('text/plain').send('not found');

  const siteDir = path.join(artifactDir(slug), 'site');
  const target = path.normalize(path.join(siteDir, req.params[0]));
  if (target !== siteDir && !target.startsWith(siteDir + path.sep)) {
    return res.status(404).type('text/plain').send('not found');
  }
  res.set({
    'Content-Security-Policy': ARTIFACT_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-cache',
  });
  let file = target;
  try {
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html');
  } catch {}
  res.sendFile(file, (err) => {
    if (err && !res.headersSent) res.status(404).type('text/plain').send('not found');
  });
});

app.post('/api/artifacts', requireAuth, async (req, res, next) => {
  try {
    res.status(201).json(await saveArtifact(req.body));
  } catch (err) {
    next(err);
  }
});

const zipBody = express.raw({
  type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
  limit: '50mb',
});

app.post('/api/artifacts/zip', requireAuth, zipBody, async (req, res, next) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      throw new ApiError(400, 'raw zip body required (Content-Type: application/zip)');
    }
    const { slug, title, expiresAt, tags, project } = req.query;
    res.status(201).json(await saveZipArtifact(req.body, { slug, title, expiresAt, tags, project }));
  } catch (err) {
    next(err);
  }
});

app.put('/api/artifacts/:slug', requireAuth, async (req, res, next) => {
  try {
    res.json(await saveArtifact({ ...req.body, slug: req.params.slug }, { replace: true }));
  } catch (err) {
    next(err);
  }
});

app.patch('/api/artifacts/:slug', requireAuth, async (req, res, next) => {
  try {
    res.json(await patchArtifact(req.params.slug, req.body));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/artifacts/:slug', requireAuth, async (req, res, next) => {
  try {
    await deleteArtifact(req.params.slug);
    res.json({ deleted: req.params.slug });
  } catch (err) {
    next(err);
  }
});

app.get('/api/artifacts', requireAuth, async (req, res, next) => {
  try {
    const { tag, project } = req.query;
    const opts = {};
    if (typeof tag === 'string' && tag !== '') opts.tag = tag;
    if (typeof project === 'string' && project !== '') opts.project = project;
    res.json(await listArtifacts(opts));
  } catch (err) {
    next(err);
  }
});

app.get('/api/config', requireAuth, (req, res) => {
  res.json(config);
});

app.put('/api/config', requireAuth, async (req, res, next) => {
  try {
    res.json(await updateConfig(req.body));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// MCP (streamable HTTP, stateless)
// ---------------------------------------------------------------------------

function createMcpServer() {
  const server = new McpServer({ name: 'artifacts-host', version: '1.0.0' });

  server.registerTool(
    'publish_artifact',
    {
      title: 'Publish artifact',
      description:
        'Publish an HTML, JSX/TSX (single React component with default export), or Markdown artifact. Returns the public URL. Omit slug for a random unguessable one.',
      inputSchema: {
        content: z.string().describe('Full source of the artifact'),
        type: z.enum(['html', 'jsx', 'tsx', 'md']).default('html'),
        slug: z.string().optional().describe('Custom URL slug [a-z0-9-], 3-64 chars'),
        title: z.string().optional(),
        expiresAt: z
          .string()
          .optional()
          .describe('ISO 8601 datetime after which the URL stops serving (410)'),
        frame: z
          .boolean()
          .optional()
          .describe('Show the top viewer frame for this artifact, overriding the server default'),
        tags: z
          .array(z.string())
          .optional()
          .describe('Tags for organizing artifacts: [a-z0-9-], 1-32 chars each, max 10'),
        project: z
          .string()
          .optional()
          .describe('Project this artifact belongs to (single grouping label, max 64 chars)'),
      },
    },
    async (args) => {
      const { url } = await saveArtifact(args);
      return { content: [{ type: 'text', text: url }] };
    },
  );

  server.registerTool(
    'update_artifact',
    {
      title: 'Update artifact',
      description: 'Replace the content of an existing artifact by slug. Returns the URL.',
      inputSchema: {
        slug: z.string(),
        content: z.string(),
        type: z.enum(['html', 'jsx', 'tsx', 'md']).default('html'),
        title: z.string().optional(),
        frame: z
          .boolean()
          .optional()
          .describe('Show the top viewer frame for this artifact, overriding the server default'),
        tags: z
          .array(z.string())
          .optional()
          .describe('Replaces all tags when provided; omit to keep existing tags'),
        project: z
          .string()
          .optional()
          .describe('Project this artifact belongs to; omit to keep the existing project'),
      },
    },
    async (args) => {
      const { url } = await saveArtifact(args, { replace: true });
      return { content: [{ type: 'text', text: url }] };
    },
  );

  server.registerTool(
    'rename_artifact',
    {
      title: 'Rename artifact',
      description: 'Change the URL slug of an existing artifact. Returns the new URL.',
      inputSchema: {
        slug: z.string().describe('Current slug'),
        newSlug: z.string().describe('New URL slug [a-z0-9-], 3-64 chars'),
      },
    },
    async ({ slug, newSlug }) => {
      const { url } = await patchArtifact(slug, { slug: newSlug });
      return { content: [{ type: 'text', text: url }] };
    },
  );

  server.registerTool(
    'set_artifact_expiry',
    {
      title: 'Set artifact expiry',
      description:
        'Set or clear the expiry of an artifact. After expiry the URL returns 410 but the content is kept.',
      inputSchema: {
        slug: z.string(),
        expiresAt: z
          .string()
          .nullable()
          .describe('ISO 8601 datetime, or null to clear the expiry'),
      },
    },
    async ({ slug, expiresAt }) => {
      await patchArtifact(slug, { expiresAt });
      const text = expiresAt ? `${slug} expires ${expiresAt}` : `expiry cleared for ${slug}`;
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'set_artifact_tags',
    {
      title: 'Set artifact tags',
      description:
        'Replace the tags of an artifact. Tags are [a-z0-9-], 1-32 chars each, max 10. An empty array clears all tags.',
      inputSchema: {
        slug: z.string(),
        tags: z.array(z.string()).describe('Full tag list; empty array clears'),
      },
    },
    async ({ slug, tags }) => {
      await patchArtifact(slug, { tags });
      const text = tags.length ? `${slug} tagged: ${tags.join(', ')}` : `tags cleared for ${slug}`;
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'set_artifact_project',
    {
      title: 'Set artifact project',
      description:
        'Set or clear the project an artifact belongs to. Projects group artifacts in the web UI. An empty string clears it.',
      inputSchema: {
        slug: z.string(),
        project: z.string().describe('Project name (max 64 chars); empty string clears it'),
      },
    },
    async ({ slug, project }) => {
      await patchArtifact(slug, { project });
      const text = project.trim() ? `${slug} → project “${project.trim()}”` : `project cleared for ${slug}`;
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'disable_artifact',
    {
      title: 'Disable artifact',
      description:
        'Disable an artifact: its public URL returns 404 but the content is kept. Re-enable with enable_artifact.',
      inputSchema: { slug: z.string() },
    },
    async ({ slug }) => {
      await patchArtifact(slug, { disabled: true });
      return { content: [{ type: 'text', text: `disabled ${slug}` }] };
    },
  );

  server.registerTool(
    'enable_artifact',
    {
      title: 'Enable artifact',
      description: 'Re-enable a disabled artifact so its public URL serves again.',
      inputSchema: { slug: z.string() },
    },
    async ({ slug }) => {
      await patchArtifact(slug, { disabled: false });
      return { content: [{ type: 'text', text: `enabled ${slug}` }] };
    },
  );

  server.registerTool(
    'set_artifact_frame',
    {
      title: 'Set artifact frame',
      description:
        'Control the top viewer frame for an artifact: true = always framed, false = never framed, null = inherit the server default.',
      inputSchema: {
        slug: z.string(),
        frame: z
          .boolean()
          .nullable()
          .describe('true = framed, false = unframed, null = inherit the global default'),
      },
    },
    async ({ slug, frame }) => {
      await patchArtifact(slug, { frame });
      const text =
        frame === null ? `frame reset to default for ${slug}` : `frame ${frame ? 'on' : 'off'} for ${slug}`;
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'list_artifacts',
    {
      title: 'List artifacts',
      description:
        'List all published artifacts (slug, type, title, tags, project, timestamps). Pass tag and/or project to filter.',
      inputSchema: {
        tag: z.string().optional().describe('Only return artifacts with this tag'),
        project: z.string().optional().describe('Only return artifacts in this project'),
      },
    },
    async ({ tag, project }) => {
      const opts = {};
      if (tag) opts.tag = tag;
      if (project) opts.project = project;
      const items = await listArtifacts(opts);
      return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
    },
  );

  server.registerTool(
    'delete_artifact',
    {
      title: 'Delete artifact',
      description: 'Delete a published artifact by slug.',
      inputSchema: { slug: z.string() },
    },
    async ({ slug }) => {
      await deleteArtifact(slug);
      return { content: [{ type: 'text', text: `deleted ${slug}` }] };
    },
  );

  return server;
}

app.post('/mcp', requireAuth, async (req, res) => {
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'internal server error' },
        id: null,
      });
    }
  }
});

app.all('/mcp', (req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'method not allowed' },
    id: null,
  });
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

app.get('/healthz', (req, res) => {
  res.type('text/plain').send('ok');
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'body too large (10mb json / 50mb zip limit)' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`artifacts-host listening on :${PORT} (base url ${BASE_URL})`);
});
