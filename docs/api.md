# REST API

Full HTTP reference, including zip-site deploys. ([← back to README](../README.md))

The `/api/artifacts*` and `/api/config` routes accept **either** an `Authorization: Bearer <key>` (a scoped [managed key](auth.md) or the bootstrap `ARTIFACTS_API_KEY`) **or** a valid admin session cookie (how the dashboard calls them). `/mcp` is bearer-only. Each write route enforces a minimum scope (below). Reads under `/a/` are public unless the artifact's [visibility](#visibility) is set.

```
POST   /api/artifacts        {content, type: html|jsx|tsx|md, slug?, title?, tags?, project?, expiresAt?, frame?, visibility?, password?} → 201 {slug, url}   [publish]
POST   /api/artifacts/zip    raw zip body (?slug=&title=&tags=&project=&expiresAt=) → 201 {slug, url, files}   [publish]
PUT    /api/artifacts/:slug  {content, type, title?, tags?, project?, expiresAt?, frame?, visibility?, password?} → {slug, url}   [publish]
PATCH  /api/artifacts/:slug  {slug?, disabled?, expiresAt?, tags?, project?, frame?, visibility?, password?} → {slug, url}   [publish]
DELETE /api/artifacts/:slug                                                  → {deleted}   [full]
GET    /api/artifacts        list (?tag= and/or ?project= to filter)         → [...]   [read]
GET    /api/config           {frame: {enabled, default}}                     → global frame config   [read]
PUT    /api/config           {frame: {enabled?, default?}}                   → updated config   [full]
GET    /a/:slug              rendered artifact, framed when active (public unless private/password)
GET    /a/:slug?raw=1        bare artifact without the frame
GET    /a/:slug/source       original uploaded source, text/plain
POST   /a/:slug/unlock       {password} → sets a per-slug unlock cookie (private/password artifacts)
```

The `[read|publish|full]` tag on each route is the minimum key scope required (`full` implies `publish` implies `read`). Admin session + managed-key endpoints (`/api/auth/*`, `/api/keys*`) are documented in [Auth & API keys](auth.md).

Semantics:

- Body limits: 10 MB JSON, 50 MB zip.
- `POST` with an existing slug → `409` (use `PUT` to update).
- Disabled artifacts return `404`; expired ones (`expiresAt` in the past) return `410`. Both keep their content — re-enable or clear/extend the expiry to serve again.
- Tags: an array of strings, or one comma-separated string (the only form the zip endpoint's `?tags=` accepts). Each tag must match `[a-z0-9][a-z0-9-]{0,31}`; max 10 per artifact. Input is lowercased and deduplicated. `PATCH` replaces the whole list; an empty list clears it. `PUT` without `tags` keeps the existing ones. Artifacts published before tags existed list as `"tags": []`. In the web UI, tags render as chips — click one to filter the list.
- Project: a single grouping label (one per artifact), distinct from tags. Unicode letters/digits, spaces, and `-` `_` `.`, starting with a letter or digit, max 64 chars; internal whitespace is collapsed and case is preserved. Matching (`?project=` and UI grouping) is **exact and case-sensitive** — `Acme` and `acme` are different projects. `PATCH` sets it; an empty string clears it. `PUT` without `project` keeps the existing one. `GET /api/artifacts?project=<name>` returns only that project's artifacts (an empty `?project=` is ignored, not a filter for "no project"). The web UI groups the list into collapsible sections per project (with a search box across project / title / slug / tags).

## Viewer frame

`GET /a/:slug` can wrap the artifact in a slim top frame (title + copy-link + hide toggle) that loads the artifact in an iframe. `?raw=1` always returns the bare artifact — it's the URL the frame's iframe points at, and the escape hatch for embedding.

Whether an artifact is framed resolves as `config.frame.enabled && (meta.frame ?? config.frame.default)`:

- **`GET/PUT /api/config`** manage the global `{frame: {enabled, default}}` (both booleans). `enabled` is the master switch; `default` applies to items with no per-item value. `PUT` accepts a partial `frame` object and merges it. First boot seeds the config from the optional `FRAME_ENABLED` / `FRAME_DEFAULT` env vars (both default `true`), persisting it to `DATA_DIR/config.json`.
- **Per item**, the `frame` field on `POST` / `PUT` / `PATCH` is `true` (always framed), `false` (never framed), or — via `PATCH {"frame": null}` — cleared so the item inherits the global default.

When the frame is globally disabled or off for an item, `/a/:slug` serves the artifact exactly as `?raw=1` does.

## Visibility

Each artifact has one of three access levels, set with the `visibility` field on `POST` / `PUT` / `PATCH` (and the `set_artifact_visibility` MCP tool / `artifacts visibility` CLI command):

- **`public`** (default, the field omitted) — anyone with the unguessable link views it. Today's behavior.
- **`private`** — only the operator views it. Every serve path (`/a/:slug`, `?raw=1`, `/source`, zip assets) is gated: sub-resources return `404`; the top-level URL returns an unlock prompt that accepts the **admin password**.
- **`password`** — the link plus a shared password. `visibility: "password"` requires a `password` field; the top-level URL returns a prompt that accepts that per-artifact password.

The gate is enforced on all serve paths, so `?raw=1`, `/source`, and zip sub-assets never leak a locked artifact's body. A correct password at `POST /a/:slug/unlock` sets an HttpOnly, `Path=/a/<slug>`, 7-day signed cookie, so shared links aren't re-prompted every load; the cookie is scoped to that one slug.

Setting `visibility` to `public` or `private` clears any stored password. Sending `password` alone (while already in password mode) rotates it. The password is stored only as a scrypt hash — `GET /api/artifacts` returns `visibility` and a `hasPassword` boolean, never the hash. Rate-limiting the unlock endpoint is not yet implemented (single-operator scope).

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

Rename, disable/enable, expiry, and delete all work the same as single-file artifacts. `PUT` (inline content) is refused on zip sites — delete and re-upload instead. The web UI accepts dropped `.zip` files. No MCP tool for zips (binary payload) — agents should use the curl call above or the [CLI](cli.md).
