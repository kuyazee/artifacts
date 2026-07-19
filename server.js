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

import { createStorage, UnsafeKeyError } from './storage/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const API_KEY = process.env.ARTIFACTS_API_KEY;

if (!API_KEY) {
  console.error('ARTIFACTS_API_KEY env var is required');
  process.exit(1);
}

// The pluggable storage backend (default `local`). Instantiated once at boot; every
// artifact read/write flows through it. Fail-fast here, like the API-key check above.
const storage = await createStorage();

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 10);

// ---------------------------------------------------------------------------
// Server config — global frame settings, stored through the storage backend
// ---------------------------------------------------------------------------

// A reserved root-level key (single segment, so it never collides with a slug — slugs
// forbid `.` — and is excluded from listMetas, which only matches `<slug>/meta.json`).
// Routing config through storage keeps the global frame setting as durable as artifacts:
// it survives a fresh-container restart on the s3/git/postgres backends too.
const CONFIG_KEY = 'config.json';

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

// Read persisted config, or fall back to the env/defaults in memory. Defaults are NOT
// written back on boot — that would commit+push on the git backend every startup; the
// file is created only when an operator changes a setting via updateConfig.
async function loadConfig() {
  const buf = await storage.getBuffer(CONFIG_KEY);
  if (!buf) return DEFAULT_CONFIG;
  try {
    return normalizeConfig(JSON.parse(buf.toString('utf8')));
  } catch {
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
  await storage.put(CONFIG_KEY, JSON.stringify(config, null, 2), { contentType: 'application/json' });
  await storage.flush?.();
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

  // Function replacements avoid `$`-substitution ($&, $`, $$, …) in the injected values —
  // a title or source containing those must be spliced verbatim, not interpreted.
  return JSX_SHELL
    .replace('{{TITLE}}', () => escapeHtml(title))
    .replace('{{IMPORT_MAP}}', () => JSON.stringify({ imports }, null, 2))
    .replace('{{SOURCE}}', () => rewritten);
}

function buildMdHtml(source, title) {
  return MD_SHELL
    .replace('{{TITLE}}', () => escapeHtml(title))
    .replace('{{CONTENT}}', () => marked.parse(source));
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

async function readMeta(slug) {
  const buf = await storage.getBuffer(`${slug}/meta.json`);
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString('utf8'));
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
  // Flutter web build outputs: binary asset manifest, compiled shaders,
  // CanvasKit symbol maps.
  'bin', 'frag', 'symbols',
]);

// Files permitted by exact basename — covers extensionless/dotfile build
// artifacts (Flutter's `NOTICES` license bundle and `.last_build_id` marker).
const ZIP_ALLOWED_NAMES = new Set(['NOTICES', '.last_build_id']);
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
    .filter((p) => {
      const ext = path.posix.extname(p).slice(1).toLowerCase();
      return !ZIP_ALLOWED_EXT.has(ext) && !ZIP_ALLOWED_NAMES.has(path.posix.basename(p));
    });
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

  for (const { relPath, entry } of files) {
    await storage.put(`${finalSlug}/site/${relPath}`, entry.getData());
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
  // meta.json LAST: a crash mid-upload leaves the namespace invisible (404), not half-served.
  await storage.put(`${finalSlug}/meta.json`, JSON.stringify(meta, null, 2), {
    contentType: 'application/json',
  });
  await storage.flush?.();
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

  await storage.put(`${finalSlug}/index.html`, html, { contentType: 'text/html; charset=utf-8' });
  await storage.put(`${finalSlug}/source.${SOURCE_EXT[type]}`, content, {
    contentType: 'text/plain; charset=utf-8',
  });
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
  // meta.json LAST as the commit marker (see storage/index.js write-ordering contract).
  await storage.put(`${finalSlug}/meta.json`, JSON.stringify(meta, null, 2), {
    contentType: 'application/json',
  });
  await storage.flush?.(); // durably commit the completed write (git); no-op elsewhere
  return { slug: finalSlug, url: `${BASE_URL}/a/${finalSlug}` };
}

async function listArtifacts({ tag, project } = {}) {
  const metas = await storage.listMetas();
  let items = metas
    .map(({ buffer }) => {
      try {
        return JSON.parse(buffer.toString('utf8'));
      } catch {
        return null; // skip a corrupt meta rather than failing the whole list
      }
    })
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

  let activeSlug = slug;
  if (patch.slug !== undefined && patch.slug !== slug) {
    if (!SLUG_RE.test(patch.slug)) {
      throw new ApiError(400, 'slug must match [a-z0-9][a-z0-9-]{2,63}');
    }
    if (await readMeta(patch.slug)) {
      throw new ApiError(409, `slug "${patch.slug}" already exists`);
    }
    await storage.move(slug, patch.slug);
    meta.slug = patch.slug;
    activeSlug = patch.slug;
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
  await storage.put(`${activeSlug}/meta.json`, JSON.stringify(meta, null, 2), {
    contentType: 'application/json',
  });
  await storage.flush?.();
  return { slug: meta.slug, url: `${BASE_URL}/a/${meta.slug}` };
}

async function deleteArtifact(slug) {
  if (!SLUG_RE.test(slug) || !(await readMeta(slug))) {
    throw new ApiError(404, `slug "${slug}" not found`);
  }
  await storage.deleteSlug(slug);
  await storage.flush?.();
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

// Artifact hardening headers, set before any object body is streamed.
const ARTIFACT_HEADERS = {
  'Content-Security-Policy': ARTIFACT_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-cache',
};

// Strict extension -> MIME map covering every extension the zip validator allows
// (ZIP_ALLOWED_EXT) plus inline outputs. The app owns Content-Type — it is never sniffed
// nor taken from a backend's stored metadata. An unknown extension serves as
// application/octet-stream, never text/html, so an unexpected file can't be made to execute.
const EXT_MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8', csv: 'text/csv; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm',
  pdf: 'application/pdf', wasm: 'application/wasm',
  webmanifest: 'application/manifest+json',
};

function mimeForKey(key) {
  const ext = path.posix.extname(key).slice(1).toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

// Parse a single HTTP byte-range against a known size. Returns { start, end }, or null when
// there is no Range header, or 'invalid' (=> 416). Range: is attacker-controlled on the
// unauthenticated read path, so bounds are validated and multi-range is refused.
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'invalid';
  const [, rawStart, rawEnd] = m;
  let start;
  let end;
  if (rawStart === '') {
    if (rawEnd === '') return 'invalid';
    const suffix = Number(rawEnd);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) return 'invalid';
  if (start < 0 || start > end || start >= size) return 'invalid';
  if (end >= size) end = size - 1;
  return { start, end };
}

// Pipe a storage stream with a hardened error contract: once the first byte is sent the
// status/headers are flushed and immutable, so an upstream error must ABORT the socket
// (res.destroy) — never res.end(), which would pass a truncated artifact off as complete.
function pipeStream(res, stream) {
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).type('text/plain').send('internal error');
    else res.destroy();
  });
  stream.pipe(res);
}

// Serve one storage object as an artifact response. The route has already validated meta
// and set ARTIFACT_HEADERS. serveObject owns Content-Type (the app's strict map, or an
// absolute forceType override used by /source) and Range. It never throws — an unsafe key
// (only reachable via user-controlled zip sub-paths) or a missing object becomes a 404.
async function serveObject(req, res, key, { forceType } = {}) {
  const contentType = forceType || mimeForKey(key);
  try {
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const info = await storage.head(key);
      if (!info) return res.status(404).type('text/plain').send('not found');
      const range = parseRange(rangeHeader, info.size);
      if (range === 'invalid') {
        return res.status(416).set('Content-Range', `bytes */${info.size}`).end();
      }
      if (range) {
        const got = await storage.get(key, { range });
        if (!got) return res.status(404).type('text/plain').send('not found');
        res.status(206).set({
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
          'Content-Length': String(range.end - range.start + 1),
        });
        return pipeStream(res, got.stream);
      }
    }
    const got = await storage.get(key);
    if (!got) return res.status(404).type('text/plain').send('not found');
    res.status(200).set({ 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
    if (got.size != null) res.set('Content-Length', String(got.size));
    pipeStream(res, got.stream);
  } catch (err) {
    if (err instanceof UnsafeKeyError) {
      if (!res.headersSent) res.status(404).type('text/plain').send('not found');
      return;
    }
    if (!res.headersSent) res.status(500).type('text/plain').send('internal error');
    else res.destroy();
  }
}

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

  res.set(ARTIFACT_HEADERS);
  if (meta.type === 'zip') {
    // Trailing slash so relative asset URLs resolve inside the site; keep ?raw=1
    // so a slash-less raw URL doesn't bounce back into the frame.
    if (!req.path.endsWith('/')) {
      return res.redirect(301, `/a/${slug}/${wantsRaw ? '?raw=1' : ''}`);
    }
    return serveObject(req, res, `${slug}/site/index.html`);
  }
  serveObject(req, res, `${slug}/index.html`);
});

app.get('/a/:slug/source', async (req, res, next) => {
  const { slug } = req.params;
  const meta = SLUG_RE.test(slug) ? await readMeta(slug) : null;
  if (!meta || meta.disabled) return res.status(404).type('text/plain').send('artifact not found');
  if (isExpired(meta)) return res.status(410).type('text/plain').send('artifact expired');
  if (meta.type === 'zip') return next(); // zip sites serve /source as a site path
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  // forceType keeps source inert: an HTML/JSX source is served as text/plain, never executed.
  serveObject(req, res, `${slug}/source.${SOURCE_EXT[meta.type]}`, {
    forceType: 'text/plain; charset=utf-8',
  });
});

app.get('/a/:slug/*', async (req, res) => {
  const { slug } = req.params;
  const meta = SLUG_RE.test(slug) ? await readMeta(slug) : null;
  if (!meta || meta.disabled) return res.status(404).type('text/plain').send('artifact not found');
  if (isExpired(meta)) return res.status(410).type('text/plain').send('artifact expired');
  if (meta.type !== 'zip') return res.status(404).type('text/plain').send('not found');
  res.set(ARTIFACT_HEADERS);

  const rel = req.params[0];
  // Directory -> index.html: object stores have no directories, so try the path, then fall
  // back to <path>/index.html. The storage key guard (assertSafeKey) rejects any traversal.
  let key = `${slug}/site/${rel}`;
  if (rel === '' || rel.endsWith('/')) {
    key = `${slug}/site/${rel}index.html`;
  } else if (!(await storage.head(key).catch(() => null))) {
    const alt = `${slug}/site/${rel}/index.html`;
    if (await storage.head(alt).catch(() => null)) key = alt;
  }
  serveObject(req, res, key);
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
