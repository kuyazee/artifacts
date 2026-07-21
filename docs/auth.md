# Auth & API keys

Two credential types, split by who is calling. ([← back to README](../README.md))

- **Admin session** — a human logs into the dashboard with a username + password. Backed by a signed, HttpOnly session cookie. One admin account per instance.
- **Managed API keys** — scoped bearer tokens for machines (CLI, MCP, scripts). Named, revocable, optionally expiring, with last-used tracking.

The original `ARTIFACTS_API_KEY` still works: it is the all-scope **bootstrap admin bearer** — a break-glass token that authenticates writes, the MCP endpoint, and key management. It is required at boot. Prefer minting scoped managed keys for daily use.

Everything is stored under a reserved `auth.json` object through the same storage backend as your artifacts, so it survives a container restart on every backend (local/s3/git/postgres/sqlite) with no database migration. Passwords are scrypt-hashed; API keys are stored as sha256 hashes with only an `ah_xxxxxxxx…` prefix kept for display — the full token is shown once at creation and is not recoverable.

## First-run setup

On first boot no admin exists. Either:

- Open the dashboard — it shows a one-time **Create admin account** screen (username + password). Whoever creates it is the admin; no second account can be created afterward.
- Or seed it from env before boot:

```bash
ARTIFACTS_ADMIN_USERNAME=admin
ARTIFACTS_ADMIN_PASSWORD=<a strong password>
```

## Scopes

| Scope | Grants |
|---|---|
| `read` | list artifacts, read config, MCP `list_artifacts` |
| `publish` | create / replace / patch artifacts, all MCP mutation tools (implies `read`) |
| `full` | delete, write config, MCP `delete_artifact` (implies `publish`) |

A key carries one or more scopes; its effective level is the highest. Minting, listing, and revoking keys is **not** a scope — it requires the admin session or the bootstrap key. A managed key, even a `full` one, cannot manage keys.

## Managing keys

**Dashboard:** the key icon in the top bar → name it, tick scopes, optional expiry, Create. The full token is shown once (and copied to your clipboard). Revoke or disable from the same list.

**CLI** (needs the bootstrap admin key):

```bash
artifacts keys create laptop-cli --scopes publish
artifacts keys create ci --scopes read,publish --expires 2027-01-01
artifacts keys list
artifacts keys revoke <id>
```

**REST** (admin session cookie or bootstrap bearer):

| Method | Path | Body / result |
|---|---|---|
| `GET` | `/api/keys` | list (no secrets) |
| `POST` | `/api/keys` | `{ name, scopes?, expiresAt? }` → key shown once in `key` |
| `PATCH` | `/api/keys/:id` | `{ disabled: true\|false }` |
| `DELETE` | `/api/keys/:id` | revoke |

## Auth endpoints (dashboard)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/auth/session` | `{ authenticated, needsSetup }` |
| `POST` | `/api/auth/setup` | create the admin account (only while none exists) |
| `POST` | `/api/auth/login` | `{ username, password }` → sets session cookie |
| `POST` | `/api/auth/logout` | clears the cookie |
| `POST` | `/api/auth/password` | `{ currentPassword, newPassword }` (logged in) |

`POST /api/auth/login` is rate-limited to 10 failures per 15 minutes per client IP (a `429` with `Retry-After` after that); a successful login never consumes budget. Client-IP resolution honors `TRUST_PROXY` — see [rate limiting and the edge](deploy.md#rate-limiting-and-the-edge).

## Using a key

Same as before — send it as a bearer token:

```bash
curl -H "Authorization: Bearer $KEY" https://artifacts.example.com/api/artifacts
```

Give CLI and MCP their own least-privilege keys (e.g. `publish`) so a leaked token can't delete or reconfigure, and revoke them individually without disturbing anything else.

The `/api/artifacts*` and `/api/config` routes accept the **admin session cookie as well as** a bearer key — that is how the dashboard calls them without carrying a token in the browser. `/mcp` stays bearer-only.

## Artifact visibility (a third, per-artifact credential)

Separate from admin/keys, each artifact can be `public`, `private` (the **default**), or `password` — see [Visibility](api.md#visibility). Viewing a gated artifact uses neither the admin session nor an API key.

- **`private`** is viewed through a **capability link**: the artifact's write returns a `?k=<token>` URL. Opening it sets a signed, HttpOnly unlock cookie scoped to `Path=/a/<slug>` and `302`s to a clean URL. No password is involved, so there is no admin-credential prompt on the artifact origin to phish. The token is an HMAC grant (`typ:'cap'`, bound to the slug and a per-artifact epoch) — no per-artifact secret is stored.
- **`password`** validates the artifact's own shared password at `POST /a/:slug/unlock`, which sets the same kind of unlock cookie. Rate-limited to 10 failures per hour per client IP + slug.

Both the capability token and the unlock cookie bind the artifact's epoch, so `PATCH {"rotateToken": true}` (bump the epoch) revokes every issued link **and** every live cookie for that slug on the next request. Absent a rotate, tokens lapse at `CAP_TOKEN_TTL_DAYS` (default 30) and cookies at their 7-day TTL.
