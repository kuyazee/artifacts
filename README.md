# artifacts-host

Self-hosted publishable artifacts, Claude-artifacts style. POST an HTML, JSX/TSX (single React component), or Markdown file — get back a public, non-crawlable URL:

```
https://artifacts.example.com/a/{slug}
```

- Slugs are random unguessable IDs (`nanoid(10)`) or custom (`[a-z0-9-]`, 3–64 chars).
- Every response carries `X-Robots-Tag: noindex, nofollow`; `robots.txt` disallows everything.
- JSX/TSX is wrapped at upload time in a Babel-standalone + esm.sh import-map shell — arbitrary npm imports work (`recharts`, `lucide-react`, …), no build step. Tailwind available via CDN.
- Markdown is rendered server-side into a styled page.
- Writes require a bearer token (`ARTIFACTS_API_KEY`). Reads are public — the unguessable URL is the access control.
- Storage is plain files under `/data/artifacts/<slug>/` — no database.
- Built-in MCP server (streamable HTTP) at `/mcp` for coding agents.
- Minimal paste-to-publish web UI at `/`.

## Run

```bash
ARTIFACTS_API_KEY=$(openssl rand -hex 32) \
BASE_URL=https://artifacts.example.com \
DATA_DIR=/data \
node server.js
```

Or Docker:

```bash
docker build -t artifacts-host .
docker run -p 3000:3000 -v artifacts-data:/data \
  -e ARTIFACTS_API_KEY=... -e BASE_URL=https://artifacts.example.com artifacts-host
```

### Coolify

1. Add resource → this repo → Dockerfile build pack.
2. Ports Exposes: `3000`. Health check path: `/healthz`.
3. Env vars: `ARTIFACTS_API_KEY` (secret), `BASE_URL=https://artifacts.example.com`.
4. Persistent storage: volume mounted at `/data`.
5. Set the domain/FQDN and deploy.

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

All `/api/*` and `/mcp` calls need `Authorization: Bearer $ARTIFACTS_API_KEY`. Body limit 10 MB. `POST` with an existing slug → `409` (use `PUT` to update).

Disabled artifacts return `404`; expired ones (`expiresAt` in the past) return `410`. Both keep their content — re-enable or clear/extend the expiry to serve again.

```bash
curl -s -X POST https://artifacts.example.com/api/artifacts \
  -H "Authorization: Bearer $ARTIFACTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "<h1>hello</h1>", "type": "html", "slug": "hello"}'
# {"slug":"hello","url":"https://artifacts.example.com/a/hello"}
```

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

### Any other agent (Hermes, scripts, …)

No MCP needed — one curl call (see REST API above). Suggested snippet for a global CLAUDE.md / AGENTS.md:

> To publish an HTML/JSX/Markdown page publicly, use the `artifacts` MCP `publish_artifact` tool, or `POST https://artifacts.example.com/api/artifacts` with `Authorization: Bearer $ARTIFACTS_API_KEY` and JSON `{content, type, slug?}`. The returned URL is public but unguessable and non-indexed.

## Security model

Single-user service. Uploaded HTML executes on this origin, so:

- Host it on a dedicated subdomain that serves nothing else and never sets cookies.
- Write API is bearer-header-only (no cookies) — hosted JS cannot CSRF it.
- Artifact responses carry `X-Robots-Tag: noindex`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a CSP that limits external requests to esm.sh and major CDNs.
