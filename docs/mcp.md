# MCP (for coding agents)

Let Claude Code, Codex, or any MCP client publish artifacts with one tool call. ([← back to README](../README.md))

The server exposes a streamable HTTP endpoint at `/mcp`, bearer-authenticated. Registry listing: [`io.github.kuyazee/artifacts`](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.kuyazee/artifacts).

Authenticate with a scoped [managed API key](auth.md) (or the bootstrap `ARTIFACTS_API_KEY`). The key's scope gates the tools: `read` allows `list_artifacts`; `publish` allows the mutation tools; `delete_artifact` needs `full`. A tool called beyond the key's scope returns an error. Mint a `publish` key for a client that should publish but never delete.

## Tools

| Tool | Args | Returns |
|---|---|---|
| `publish_artifact` | `content`, `type`, `slug?`, `title?`, `tags?`, `expiresAt?`, `visibility?`, `password?` | share URL (tokened for private/password) |
| `update_artifact` | `slug`, `content`, `type`, `title?`, `tags?`, `visibility?`, `password?` | share URL |
| `rename_artifact` | `slug`, `newSlug` | new share URL |
| `disable_artifact` | `slug` | confirmation (URL serves 404, content kept) |
| `enable_artifact` | `slug` | confirmation |
| `set_artifact_expiry` | `slug`, `expiresAt` (ISO 8601 or `null` to clear) | confirmation |
| `set_artifact_tags` | `slug`, `tags` (full list; empty array clears) | confirmation |
| `set_artifact_visibility` | `slug`, `visibility` (`public`/`private`/`password`), `password?` | confirmation |
| `list_artifacts` | `tag?` (filter) | JSON list |
| `delete_artifact` | `slug` | confirmation |

No MCP tool for zip sites (binary payload) — use the [CLI](cli.md) or the [zip endpoint](api.md#zip-sites-multi-file-static-projects).

**New artifacts default to `private`** (set `DEFAULT_VISIBILITY=public` on the server to change this). For a `private` or `password` artifact the returned URL is a capability link (`?k=<token>`) that is immediately viewable — hand that whole URL out. Pass `visibility: "public"` to publish a bare link instead. See [visibility](api.md#visibility).

## Claude Code

```bash
claude mcp add --transport http artifacts https://artifacts.example.com/mcp \
  --header "Authorization: Bearer ${ARTIFACTS_API_KEY}" --scope user
```

## Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.artifacts]
url = "https://artifacts.example.com/mcp"
bearer_token_env_var = "ARTIFACTS_API_KEY"
```

## Any other agent (scripts, …)

No MCP needed — one curl call (see the [REST API](api.md)). Suggested snippet for a global CLAUDE.md / AGENTS.md:

> To publish an HTML/JSX/Markdown page, use the `artifacts` MCP `publish_artifact` tool, or `POST https://artifacts.example.com/api/artifacts` with `Authorization: Bearer $ARTIFACTS_API_KEY` and JSON `{content, type, slug?}`. Artifacts default to **private** — the returned `url` is a capability link (`?k=…`) that is immediately viewable; hand out the whole URL. Add `"visibility":"public"` for a bare, shareable link. All artifacts are non-indexed.
