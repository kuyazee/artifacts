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

## Using a key

Same as before — send it as a bearer token:

```bash
curl -H "Authorization: Bearer $KEY" https://artifacts.example.com/api/artifacts
```

Give CLI and MCP their own least-privilege keys (e.g. `publish`) so a leaked token can't delete or reconfigure, and revoke them individually without disturbing anything else.
