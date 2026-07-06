import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const JSX_SHELL = await fs.readFile(path.join(__dirname, 'shells', 'jsx.html'), 'utf8');
const MD_SHELL = await fs.readFile(path.join(__dirname, 'shells', 'md.html'), 'utf8');

const TYPES = ['html', 'jsx', 'tsx', 'md'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
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

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

async function saveArtifact({ content, type = 'html', slug, title, expiresAt }, { replace = false } = {}) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new ApiError(400, 'content (non-empty string) is required');
  }
  const expiry = expiresAt !== undefined ? parseExpiresAt(expiresAt) : undefined;
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
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return { slug: finalSlug, url: `${BASE_URL}/a/${finalSlug}` };
}

async function listArtifacts() {
  const entries = await fs.readdir(ARTIFACTS_DIR, { withFileTypes: true });
  const metas = await Promise.all(
    entries.filter((e) => e.isDirectory()).map((e) => readMeta(e.name)),
  );
  return metas.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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

  if (patch.expiresAt !== undefined) {
    meta.expiresAt = parseExpiresAt(patch.expiresAt);
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

app.get('/a/:slug', async (req, res) => {
  const { slug } = req.params;
  const meta = SLUG_RE.test(slug) ? await readMeta(slug) : null;
  if (!meta || meta.disabled) {
    return res.status(404).type('text/plain').send('artifact not found');
  }
  if (isExpired(meta)) {
    return res.status(410).type('text/plain').send('artifact expired');
  }
  res.set({
    'Content-Security-Policy': ARTIFACT_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-cache',
  });
  res.sendFile(path.join(artifactDir(slug), 'index.html'));
});

app.get('/a/:slug/source', async (req, res) => {
  const { slug } = req.params;
  const meta = SLUG_RE.test(slug) ? await readMeta(slug) : null;
  if (!meta || meta.disabled) return res.status(404).type('text/plain').send('artifact not found');
  if (isExpired(meta)) return res.status(410).type('text/plain').send('artifact expired');
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.type('text/plain');
  res.sendFile(path.join(artifactDir(slug), `source.${SOURCE_EXT[meta.type]}`));
});

app.post('/api/artifacts', requireAuth, async (req, res, next) => {
  try {
    res.status(201).json(await saveArtifact(req.body));
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
    res.json(await listArtifacts());
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
    'list_artifacts',
    {
      title: 'List artifacts',
      description: 'List all published artifacts (slug, type, title, timestamps).',
      inputSchema: {},
    },
    async () => {
      const items = await listArtifacts();
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
    return res.status(413).json({ error: 'body too large (10mb limit)' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`artifacts-host listening on :${PORT} (base url ${BASE_URL})`);
});
