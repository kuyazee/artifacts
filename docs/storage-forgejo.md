# Forgejo as storage

Keep every artifact in a **private Forgejo repo** (Forgejo is a self-hosted Git host; this applies
unchanged to Gitea). Same `git` backend as [GitHub storage](storage-github.md) — commit-and-push
on every change, rehydrate from the repo on boot — but the remote is your own server, so the data
never leaves infrastructure you control. ([← back to README](../README.md))

Good when you already run Forgejo, or want the app and its storage on the same private network.
The `git` backend allows an `http://` remote, so an internal Forgejo needs no public exposure.

## How it behaves

Identical to the GitHub backend: boot clones/fetches the repo into a local working copy, each
write is committed under `artifacts/` and **pushed on return** (a failed push is a `5xx`, never a
false success), and `isomorphic-git` (pure JS, ships in the image) does the work. Full artifact
history lives in the repo.

## 1. Create a private store repo

On your Forgejo instance, create an **empty private** repository, e.g. `you/artifacts-store`.
Empty is fine — the first publish creates the branch.

> The repo **must stay private**. A public store makes every artifact browsable and indexable on
> Forgejo, defeating unguessable slugs, `noindex`, and expiry/disable. See [SECURITY.md](../SECURITY.md).

## 2. Make an access token

Forgejo → Settings → **Applications** → Manage Access Tokens → Generate:
- Give it repository **read + write** (`write:repository` scope).
- Copy the token now — Forgejo shows it once.

## 3. Configure the backend

Forgejo authenticates git-over-HTTP with your **username + the token as the password**. That is
the reliable pairing, so use `GIT_USERNAME` + `GIT_PASSWORD` (not `GIT_TOKEN`, whose
`x-access-token` username is a GitHub convention). **Never put credentials in `GIT_REMOTE_URL`** —
it is rejected at boot.

```bash
STORAGE_BACKEND=git
GIT_REMOTE_URL=https://forgejo.example.com/you/artifacts-store.git
GIT_USERNAME=you
GIT_PASSWORD=<the access token>
GIT_BRANCH=main            # optional, defaults to main
# GIT_AUTHOR_NAME=artifacts-host      # optional commit identity
# GIT_AUTHOR_EMAIL=artifacts@localhost
# GIT_WORK_DIR=/data/git              # optional local working copy path
```

**Keep it on the private network.** If Forgejo and the app run on the same host/orchestrator
(Docker, Coolify), point `GIT_REMOTE_URL` at Forgejo's **internal** address over `http` so git
traffic never hits the public internet:

```bash
GIT_REMOTE_URL=http://<forgejo-service>:3000/you/artifacts-store.git
```

Bare-node example:

```bash
STORAGE_BACKEND=git \
GIT_REMOTE_URL=https://forgejo.example.com/you/artifacts-store.git \
GIT_USERNAME=you GIT_PASSWORD=<token> \
ARTIFACTS_API_KEY=$(openssl rand -hex 32) \
BASE_URL=https://artifacts.example.com \
node server.js
```

Full var table: [deploying → git](deploy.md#git-commit-every-change-to-a-git-remote).

## 4. Bring up and verify

On boot the app reaches the remote and rehydrates; bad creds or an unreachable remote **fail at
startup** (`git authentication failed …` / `cannot reach git remote …`), not on first publish —
watch the boot log. Then:

```bash
curl -s -X POST https://artifacts.example.com/api/artifacts \
  -H "Authorization: Bearer $ARTIFACTS_API_KEY" -H "Content-Type: application/json" \
  -d '{"content":"<h1>forgejo ok</h1>","type":"html","slug":"forgejo-ok","visibility":"public"}'
```

A commit appears in `you/artifacts-store` under `artifacts/forgejo-ok/`. Restart the app with a
wiped working copy and the artifact is still served — it re-cloned from Forgejo.

## Rules and limits

| Topic | Detail |
|---|---|
| **Single writer** | One app instance per branch. A second writer surfaces as a non-fast-forward push and a `5xx`. |
| **Private repo** | Always. Serving is through the app, never Forgejo's file views. |
| **History grows** | Every change is a commit; zip-site binaries pile up in history. Use a **dedicated** repo you can prune or recreate. Watch Forgejo's per-repo size limit if one is set (`REPO_INDEXER` / admin quota). |
| **Push size** | If your Forgejo enforces a max file or push size, a large bundled asset will fail the push (→ `5xx`). |
| **Write volume** | Each publish is a push. Fine for interactive/preview use; use S3/Postgres for heavy write throughput. |
| **Auth** | `GIT_USERNAME` + `GIT_PASSWORD`(=token) is the safe pairing. Credentials never go in the URL (rejected at boot) and are scrubbed from logs. |
| **http remote** | Allowed, and the right call for an internal Forgejo. Only use a public `http` remote on a trusted network — prefer `https` off-network. |

## Security follow-ups

- **Rotate the Forgejo token** if it transited a chat/paste; regenerate it and update
  `GIT_PASSWORD`. Scope the token to repository read/write only.
- **Keep the store repo private** and the Forgejo endpoint internal where possible.
- Hand CLI/MCP clients scoped [managed keys](auth.md), not the bootstrap `ARTIFACTS_API_KEY`, and
  serve artifacts from a [dedicated origin](deploy.md#deployment-rule-security).
