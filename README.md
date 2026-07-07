# artifacts-host

**Self-hosted, Claude-style artifact publishing.** POST an HTML page, a React component, a Markdown doc, or a whole zipped static site — get back a public, unguessable, non-crawlable URL on your own domain. Built for coding agents (MCP server included) and humans (drag-and-drop web UI included).

[![CI](https://github.com/kuyazee/artifacts/actions/workflows/ci.yml/badge.svg)](https://github.com/kuyazee/artifacts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node ≥22](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)

![Web UI](docs/screenshot.png)

## Why

AI assistants generate a lot of shareable output — dashboards, prototypes, reports, little apps. Claude's hosted artifacts are great, but the URLs live on someone else's infrastructure. This is the ~600-line self-hosted version:

- **One tiny Node service.** Express + a handful of deps. No database, no accounts, no build step — artifacts are plain files under `/data`.
- **Agent-native.** Built-in MCP server (streamable HTTP), so Claude Code, Codex, or any MCP client can publish with one tool call. Everything is also a single `curl`.
- **Private by default.** Random unguessable slugs, `noindex` everywhere, bearer-token writes, optional expiry.

## Features

- **Four content types:** HTML, JSX/TSX (single React component, rendered client-side via esm.sh — arbitrary npm imports, no build), Markdown (rendered server-side), and **zip sites** (multi-file static projects with images/CSS/JS).
- **MCP server** at `/mcp` — publish, update, rename, disable/enable, set expiry, list, delete.
- **Web UI** at `/` — drag-and-drop or paste to publish, manage everything, locked behind your API key.
- **Lifecycle controls:** rename slugs, disable without deleting (404), auto-expire (`expiresAt` → 410), delete.
- **Non-crawlable:** `X-Robots-Tag: noindex, nofollow` on every response, deny-all `robots.txt`.
- **Zip uploads are validated** before anything is stored: `index.html` required, static-only extension whitelist, traversal/symlink rejection, size and file-count limits.

## Quickstart

### docker compose (recommended)

```bash
git clone https://github.com/kuyazee/artifacts && cd artifacts
ARTIFACTS_API_KEY=$(openssl rand -hex 32) BASE_URL=https://artifacts.example.com docker compose up -d
```

### docker

```bash
docker run -d -p 3000:3000 -v artifacts-data:/data \
  -e ARTIFACTS_API_KEY=$(openssl rand -hex 32) \
  -e BASE_URL=https://artifacts.example.com \
  ghcr.io/kuyazee/artifacts:latest
```

### bare node

```bash
npm ci
ARTIFACTS_API_KEY=$(openssl rand -hex 32) BASE_URL=https://artifacts.example.com node server.js
```

Then publish something:

```bash
curl -s -X POST https://artifacts.example.com/api/artifacts \
  -H "Authorization: Bearer $ARTIFACTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "<h1>hello</h1>", "type": "html", "slug": "hello"}'
# {"slug":"hello","url":"https://artifacts.example.com/a/hello"}
```

Works on any Dockerfile-based PaaS (Coolify, CapRover, Dokploy, Railway…): expose port `3000`, mount a volume at `/data`, set the two env vars, health check `GET /healthz`.

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `ARTIFACTS_API_KEY` | yes | — | Bearer token for all writes and the MCP endpoint |
| `BASE_URL` | recommended | `http://localhost:3000` | Public origin used in returned URLs |
| `DATA_DIR` | no | `/data` | Where artifacts are stored (plain files) |
| `PORT` | no | `3000` | Listen port |

## REST API

```
POST   /api/artifacts        {content, type: html|jsx|tsx|md, slug?, title?, expiresAt?} → 201 {slug, url}
POST   /api/artifacts/zip    raw zip body (?slug=&title=&expiresAt=)         → 201 {slug, url, files}
PUT    /api/artifacts/:slug  {content, type, title?, expiresAt?}             → {slug, url}
PATCH  /api/artifacts/:slug  {slug?, disabled?, expiresAt?}                  → {slug, url}   (rename / disable / expiry)
DELETE /api/artifacts/:slug                                                  → {deleted}
GET    /api/artifacts        list                                            → [{slug, type, title, createdAt, updatedAt}]
GET    /a/:slug              rendered artifact (public)
GET    /a/:slug/source       original uploaded source, text/plain (public)
```

All `/api/*` and `/mcp` calls need `Authorization: Bearer $ARTIFACTS_API_KEY`. Body limits: 10 MB JSON, 50 MB zip. `POST` with an existing slug → `409` (use `PUT` to update).

Disabled artifacts return `404`; expired ones (`expiresAt` in the past) return `410`. Both keep their content — re-enable or clear/extend the expiry to serve again.

Publish a file:

```bash
jq -n --rawfile c page.html '{content: $c, type: "html"}' | \
  curl -s -X POST https://artifacts.example.com/api/artifacts \
    -H "Authorization: Bearer $ARTIFACTS_API_KEY" \
    -H "Content-Type: application/json" -d @-
```

## Zip sites (multi-file static projects)

`POST /api/artifacts/zip` with the raw zip as the body deploys a whole static site (HTML + CSS + JS + images) under `/a/{slug}/`:

```bash
curl -s -X POST "https://artifacts.example.com/api/artifacts/zip?slug=my-site" \
  -H "Authorization: Bearer $ARTIFACTS_API_KEY" \
  -H "Content-Type: application/zip" \
  --data-binary @site.zip
# {"slug":"my-site","url":"https://artifacts.example.com/a/my-site/","files":12}
```

The archive is validated before anything is stored:

- must contain `index.html` at the root (a single shared top-level folder is stripped automatically, so `zip -r site.zip my-project/` works as-is)
- only static-hostable extensions are allowed (html, css, js/mjs, json, images, fonts, audio/video, pdf, wasm, source maps); anything else is rejected with the offending paths listed
- path traversal (`../`), absolute paths, and symlinks are rejected
- limits: 50 MB zip, 100 MB uncompressed, 2000 files; `__MACOSX/`, `.DS_Store`, `Thumbs.db` are ignored

Rename, disable/enable, expiry, and delete all work the same as single-file artifacts. `PUT` (inline content) is refused on zip sites — delete and re-upload instead. The web UI accepts dropped `.zip` files. No MCP tool (binary payload) — agents should use the curl call above.

## JSX/TSX artifacts

Upload a single React component with a **default export**. Imports of `react`, `react-dom`, `recharts`, `lucide-react` are pinned; any other package import resolves via `https://esm.sh/<pkg>?external=react,react-dom` automatically. Tailwind classes work out of the box.

```jsx
import { useState } from 'react';
import { Rocket } from 'lucide-react';

export default function Demo() {
  const [n, setN] = useState(0);
  return (
    <button className="m-8 px-4 py-2 rounded bg-blue-600 text-white" onClick={() => setN(n + 1)}>
      <Rocket className="inline w-4 h-4 mr-2" />clicked {n}
    </button>
  );
}
```

Note: rendering uses esm.sh + Tailwind CDN, so artifacts need internet to render and take ~1–3 s on first load.

## MCP (for coding agents)

Streamable HTTP endpoint at `/mcp`, bearer-authenticated. Tools:

| Tool | Args | Returns |
|---|---|---|
| `publish_artifact` | `content`, `type`, `slug?`, `title?`, `expiresAt?` | public URL |
| `update_artifact` | `slug`, `content`, `type`, `title?` | public URL |
| `rename_artifact` | `slug`, `newSlug` | new public URL |
| `disable_artifact` | `slug` | confirmation (URL serves 404, content kept) |
| `enable_artifact` | `slug` | confirmation |
| `set_artifact_expiry` | `slug`, `expiresAt` (ISO 8601 or `null` to clear) | confirmation |
| `list_artifacts` | — | JSON list |
| `delete_artifact` | `slug` | confirmation |

### Claude Code

```bash
claude mcp add --transport http artifacts https://artifacts.example.com/mcp \
  --header "Authorization: Bearer ${ARTIFACTS_API_KEY}" --scope user
```

### Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.artifacts]
url = "https://artifacts.example.com/mcp"
bearer_token_env_var = "ARTIFACTS_API_KEY"
```

### Any other agent (scripts, …)

No MCP needed — one curl call (see REST API above). Suggested snippet for a global CLAUDE.md / AGENTS.md:

> To publish an HTML/JSX/Markdown page publicly, use the `artifacts` MCP `publish_artifact` tool, or `POST https://artifacts.example.com/api/artifacts` with `Authorization: Bearer $ARTIFACTS_API_KEY` and JSON `{content, type, slug?}`. The returned URL is public but unguessable and non-indexed.

## Security model

Single-user service. Uploaded HTML executes on this origin, so:

- Host it on a dedicated subdomain that serves nothing else and never sets cookies.
- Write API is bearer-header-only (no cookies) — hosted JS cannot CSRF it.
- Artifact responses carry `X-Robots-Tag: noindex`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a CSP that limits external requests to esm.sh and major CDNs.
- Reads are public by design; the unguessable slug is the access control. Don't publish secrets.

See [SECURITY.md](SECURITY.md) for what counts as a vulnerability and how to report one.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The whole test suite is one shell script (`.github/workflows/smoke.sh`) you can run against a local dev server.

## License

[MIT](LICENSE) © 2026 Zonily Jame
