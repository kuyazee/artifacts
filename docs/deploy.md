# Deploying

How to run artifacts on your own infrastructure. ([← back to README](../README.md))

## docker compose (recommended)

```bash
git clone https://github.com/kuyazee/artifacts && cd artifacts
cp .env.example .env   # set ARTIFACTS_API_KEY and BASE_URL
docker compose up -d
```

Compose reads `.env` from the project directory. You can also pass the variables inline instead:

```bash
ARTIFACTS_API_KEY=$(openssl rand -hex 32) BASE_URL=https://artifacts.example.com docker compose up -d
```

## docker

```bash
docker run -d -p 3000:3000 -v artifacts-data:/data \
  -e ARTIFACTS_API_KEY=$(openssl rand -hex 32) \
  -e BASE_URL=https://artifacts.example.com \
  ghcr.io/kuyazee/artifacts:latest
```

## bare node

```bash
npm ci
ARTIFACTS_API_KEY=$(openssl rand -hex 32) BASE_URL=https://artifacts.example.com node server.js
```

Or keep the configuration in a file: `cp .env.example .env`, edit it, then `npm run dev` (uses Node's built-in `--env-file`).

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `ARTIFACTS_API_KEY` | yes | — | Bearer token for all writes and the MCP endpoint |
| `BASE_URL` | recommended | `http://localhost:3000` | Public origin used in returned URLs |
| `STORAGE_BACKEND` | no | `local` | Storage backend: `local`, `s3`, `git`, `postgres`, or `sqlite` |
| `DATA_DIR` | no | `/data` | `local` backend only — directory of plain files |
| `PORT` | no | `3000` | Listen port |

## Storage backends

By default artifacts are plain files under `DATA_DIR` — back up that directory and you have
backed up everything. This works great when the disk is durable (a mounted Docker volume, a
persistent PaaS disk).

On hosts where a restart reprovisions a **fresh container or VM with no attached volume**
(Fly Machines without a volume, Cloud Run, Heroku dynos, some free PaaS tiers), local disk is
wiped and artifacts are lost. Set `STORAGE_BACKEND=s3` to store them in a durable, external
S3-compatible bucket instead; the app then holds no local state and artifacts survive any
restart.

### S3 (and S3-compatible: R2, B2, MinIO, Spaces, Wasabi, GCS interop)

```bash
STORAGE_BACKEND=s3 \
S3_ENDPOINT=https://s3.us-east-1.amazonaws.com \
S3_REGION=us-east-1 \
S3_BUCKET=my-artifacts \
S3_ACCESS_KEY_ID=... \
S3_SECRET_ACCESS_KEY=... \
ARTIFACTS_API_KEY=$(openssl rand -hex 32) \
node server.js
```

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `S3_ENDPOINT` | yes | — | S3 API endpoint (e.g. `https://<accountid>.r2.cloudflarestorage.com` for R2) |
| `S3_BUCKET` | yes | — | Bucket name |
| `S3_ACCESS_KEY_ID` | yes | — | Access key |
| `S3_SECRET_ACCESS_KEY` | yes | — | Secret key |
| `S3_REGION` | no | `us-east-1` | Region (use `auto` for R2) |
| `S3_PREFIX` | no | — | Key prefix within the bucket, e.g. `artifacts/` |

The `aws4fetch` dependency is optional and only loaded when `STORAGE_BACKEND=s3`; a plain
`local` install never pulls it. The server runs a quick write/delete probe against the bucket
at startup and **refuses to boot** if it is unreachable or misconfigured, rather than coming
up empty.

> **Security — the bucket MUST be private.** Artifacts are always served *through* this app,
> so their hardening headers, `noindex`, and expiry/disable checks apply. A public bucket (or a
> browser-facing CDN/presigned URL) would bypass all of that and expose every artifact — see
> [SECURITY.md](../SECURITY.md). Never make the bucket or its objects public.

### git (commit every change to a git remote)

Stores each artifact as files in a git repository and pushes every change to a remote
(GitHub, GitLab, Gitea, self-hosted). On boot the server clones/pulls the remote into a local
working copy, so a fresh container rehydrates from the remote. A nice side effect: full version
history of every artifact.

```bash
STORAGE_BACKEND=git \
GIT_REMOTE_URL=https://github.com/you/artifacts-store.git \
GIT_TOKEN=ghp_xxx \
GIT_BRANCH=main \
ARTIFACTS_API_KEY=$(openssl rand -hex 32) \
node server.js
```

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `GIT_REMOTE_URL` | yes | — | `https://…` repo URL. **Must not contain credentials** (rejected at boot) |
| `GIT_TOKEN` | for private repos | — | Access token, sent only via the auth callback — never in the URL or logs |
| `GIT_USERNAME` / `GIT_PASSWORD` | alt. to token | — | Basic-auth alternative to `GIT_TOKEN` |
| `GIT_BRANCH` | no | `main` | Branch to read and write |
| `GIT_WORK_DIR` | no | `DATA_DIR` or `/data/git` | Local working-copy directory |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | no | `artifacts-host` / `artifacts@localhost` | Commit identity |

`isomorphic-git` is an optional dependency loaded only when `STORAGE_BACKEND=git` — it is pure
JavaScript (no `git` binary, no shell), so a slug or filename can never be run as a command.

> **Security & operational notes.**
> - **The remote MUST be private.** A public repo makes every artifact browsable and indexable
>   on the host, defeating unguessable slugs, `noindex`, and expiry/disable — see
>   [SECURITY.md](../SECURITY.md).
> - **Single writer.** Run exactly one instance against a given branch. The git backend pushes
>   on every change; two concurrent writers would produce non-fast-forward rejections. A failed
>   push surfaces as a 5xx (the publish is not reported as durable).
> - Credentials come only from `GIT_TOKEN` / `GIT_USERNAME` / `GIT_PASSWORD` and are scrubbed
>   from error logs; a `GIT_REMOTE_URL` containing `user:pass@` is rejected at startup.
> - Binary assets in zip sites accumulate in git history; use a dedicated repo you can prune.

### Postgres

Stores each object as a row (blobs in a `bytea` column). Handy where you already run
Postgres — Railway, Render, Fly, Supabase, Neon all offer it in a click — and, being an
external server, it survives a fresh container with no local disk.

```bash
STORAGE_BACKEND=postgres \
DATABASE_URL=postgres://user:pass@host:5432/artifacts \
ARTIFACTS_API_KEY=$(openssl rand -hex 32) \
node server.js
```

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Postgres connection string |
| `PGSSLMODE` | no | (TLS on) | Set `disable` for a local/non-TLS server |
| `PG_POOL_MAX` | no | `8` | Max pooled connections |

The `pg` dependency is optional and loaded only when `STORAGE_BACKEND=postgres`. The table is
created automatically on first boot; a failed connection refuses to start.

### SQLite

Stores everything in a single SQLite file with transactional writes — a nice portable option.

```bash
STORAGE_BACKEND=sqlite SQLITE_PATH=/data/artifacts.db \
ARTIFACTS_API_KEY=$(openssl rand -hex 32) node server.js
```

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `SQLITE_PATH` | no | `${DATA_DIR}/artifacts.db` | Database file |

Uses Node's built-in `node:sqlite` — **no extra dependency**. Note that, like `local`, an
SQLite file is only as durable as the disk it sits on: it does **not** by itself survive a host
that wipes local storage on restart (use s3 / git / postgres for that, or replicate the file
with e.g. [Litestream](https://litestream.io)).

### Migrating local → S3

Because S3 object keys mirror the on-disk layout, no special tooling is needed — copy the
existing files up, then switch the backend:

```bash
aws s3 sync ./data/artifacts s3://my-artifacts        # or: rclone sync, for R2/B2/etc.
# then set STORAGE_BACKEND=s3 and the S3_* vars and restart
```

## Any Dockerfile PaaS

Works on Coolify, CapRover, Dokploy, Railway, and similar: expose port `3000`, mount a volume at `/data`, set the two env vars. A health endpoint exists at `GET /healthz`.

Note for Coolify specifically: the `node:22-slim` image has no `curl`/`wget`, so leave Coolify's container healthcheck **disabled** — enabling it marks the container unhealthy and blocks routing. Use `/healthz` from an external monitor instead.

## Deployment rule (security)

Uploaded HTML executes on this origin — that's the product. Host the service on a **dedicated subdomain that serves nothing else and never sets cookies**. See [SECURITY.md](../SECURITY.md) for the full security model.
