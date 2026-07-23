<h1 align="center">artifacts</h1>

<p align="center">
  <strong>Self-hosted, Claude-style artifact publishing</strong>
</p>

<p align="center">
  POST HTML, a React component, Markdown, or a zipped static site. Get back an unguessable URL on your own domain.
</p>

<p align="center">
  <a href="https://github.com/kuyazee/artifacts/actions/workflows/ci.yml"><img src="https://github.com/kuyazee/artifacts/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg" alt="Node >= 22"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/deploy.md">Deploy</a> ·
  <a href="docs/api.md">API</a> ·
  <a href="docs/cli.md">CLI</a> ·
  <a href="docs/mcp.md">MCP</a> ·
  <a href="SECURITY.md">Security</a>
</p>

<p align="center">
  <img src="docs/screenshot-framed.png" alt="Dashboard: publish, group by project, and manage artifacts" width="880"><br>
  <em>Dashboard: publish, group by project, and manage</em>
</p>

<p align="center">
  <img src="docs/screenshot-view-framed.png" alt="A published artifact served with the viewer topbar" width="880"><br>
  <em>A published artifact served with the viewer topbar</em>
</p>

## About

AI assistants produce a lot of shareable output: dashboards, prototypes, reports, small apps. Claude's hosted artifacts work well, but the URLs live on someone else's infrastructure. This is the self-hosted version, about 1,100 lines. You POST content, it serves the rendered result at an unguessable URL on a domain you control.

It runs as one container with a single admin account and, by default, no database. Each artifact is a directory of plain files under `/data`, so backing up that directory backs up everything. On hosts that wipe local disk on restart, point it at durable external storage instead (an S3-compatible bucket, a git remote, or Postgres) by setting `STORAGE_BACKEND`. See [deploying](docs/deploy.md#storage-backends).

## Features

- **Four content types.** HTML, JSX/TSX (a single React component, no build step), Markdown, and zipped static sites.
- **Agent-native, human-friendly.** A built-in MCP server lets Claude Code, Codex, or any MCP client publish with one tool call. Humans get a drag-and-drop web UI at `/` (behind an admin login) and a [CLI](docs/cli.md).
- **Two-tier auth.** An admin logs into the dashboard with a password; CLI and MCP carry scoped, revocable [API keys](docs/auth.md) (`read` / `publish` / `full`) with optional expiry, so you never share one master secret.
- **Private by default, with per-artifact visibility.** A new artifact is `private`, shared through a signed capability link (`?k=…`) you can rotate to revoke. Switch any artifact to `public` (anyone with the bare link) or password-protected. Nothing is discoverable by default: unguessable slugs, `noindex` everywhere. See [visibility](docs/api.md#visibility).
- **Optional viewer frame.** A slim top toolbar (title, copy link, hide) like Claude, Gemini, and ChatGPT artifacts. Toggle it globally in Settings or per artifact; `?raw=1` always serves the bare content.
- **Markdown render settings.** Pick the reading font, content width, base font size, and starting theme for every Markdown artifact in Settings. Markdown renders from its source on each view, so a change shows on existing artifacts too. Framed Markdown gets a navbar button that cycles Auto, Light, and Dark for that reader. See [docs/formats.md](docs/formats.md#markdown-render-settings).
- **Organize by project.** Group artifacts built for the same project into collapsible sections, with a search box across project, title, slug, and tags. Tags stay for cross-cutting labels.
- **Lifecycle controls.** Custom slugs, rename, tags, disable without deleting, auto-expire, delete.
- **Abuse-resistant.** Login and unlock endpoints are rate-limited per client IP (failures only), and password hashing runs off the event loop, so a burst of guesses slows those two routes instead of stalling the server. Set `TRUST_PROXY` for the real client IP behind Cloudflare or a reverse proxy. See [deploying](docs/deploy.md#rate-limiting-and-the-edge).

## Quick start

Clone, configure, start:

```bash
git clone https://github.com/kuyazee/artifacts && cd artifacts
cp .env.example .env   # set ARTIFACTS_API_KEY (openssl rand -hex 32) and BASE_URL
docker compose up -d
```

Publish something:

```bash
curl -s -X POST https://artifacts.example.com/api/artifacts \
  -H "Authorization: Bearer $ARTIFACTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "<h1>hello</h1>", "type": "html", "slug": "hello", "tags": ["demo"]}'
# {"slug":"hello","url":"https://artifacts.example.com/a/hello"}
```

Let Claude Code publish for you:

```bash
claude mcp add --transport http artifacts https://artifacts.example.com/mcp \
  --header "Authorization: Bearer ${ARTIFACTS_API_KEY}" --scope user
```

## Documentation

| I want to… | Read |
|---|---|
| Deploy it (Docker, compose, Coolify, bare node, env vars) | [docs/deploy.md](docs/deploy.md) |
| Use the REST API (incl. zip sites and tags) | [docs/api.md](docs/api.md) |
| Publish from the terminal | [docs/cli.md](docs/cli.md) |
| Hook up Claude Code / Codex / any agent | [docs/mcp.md](docs/mcp.md) |
| Set up login + scoped API keys | [docs/auth.md](docs/auth.md) |
| Understand JSX/TSX rendering + zip validation | [docs/formats.md](docs/formats.md) |

## Development

No build step. Node ≥ 22.

```bash
npm install
cp .env.example .env   # any ARTIFACTS_API_KEY works locally, e.g. "test"
npm run dev
# UI at http://localhost:3000
```

The whole test suite is one shell script:

```bash
bash .github/workflows/smoke.sh http://localhost:3000 <your-key>
```

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Uploaded HTML runs in the browser. That is the whole point, so the model is built to contain it:

- **Serve artifacts from their own origin.** Point artifact URLs at a domain that hosts nothing else, so a published page can never touch the dashboard's session cookie.
- **Writes need a scoped API key.** Publishing carries a bearer key; the admin dashboard uses a separate HttpOnly, SameSite=Strict session cookie.
- **Reads rely on unguessable slugs.** Public artifacts are reachable by anyone with the link and carry `noindex`, but there is no listing to browse. Don't publish secrets.
- **Credential routes are throttled.** Login and unlock rate-limit per client IP and hash passwords off the event loop. Put a CDN or edge limiter in front for volumetric attacks.

Full threat model in [SECURITY.md](SECURITY.md).

## Acknowledgements

This project stands on other people's open source. All of the following are MIT licensed.

**Runtime**
- [express](https://github.com/expressjs/express) for the HTTP server
- [marked](https://github.com/markedjs/marked) for Markdown rendering
- [nanoid](https://github.com/ai/nanoid) for unguessable slug generation
- [adm-zip](https://github.com/cthackers/adm-zip) for zip site extraction
- [zod](https://github.com/colinhacks/zod) for request validation
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) for the built-in MCP server

**Optional storage backends** (loaded only when selected)
- [aws4fetch](https://github.com/mhart/aws4fetch) for S3-compatible signing
- [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) for the git backend
- [pg](https://github.com/brianc/node-postgres) for the Postgres backend

The SQLite backend uses Node's built-in `node:sqlite` (no dependency).

**Web UI**
- [Tabler Icons](https://tabler.io/icons) for the app-bar icons (search, new, settings, lock), inlined as SVG

## License

[MIT](LICENSE) © 2026 Zonily Jame

<p align="center">
  <sub>One container. Plain files by default; pluggable S3 / git / Postgres / SQLite storage.</sub>
</p>
