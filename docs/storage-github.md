# GitHub as storage

Keep every artifact in a **private GitHub repo**. The `git` backend commits each change and pushes
it, and rehydrates from the repo on boot — so a fresh container with no disk comes back with all
its data, and you get full version history of every artifact for free. ([← back to README](../README.md))

Good when you already live on GitHub and want durable storage with an audit trail and zero extra
infrastructure. Not for high write volume — every publish is a commit + push. For an object-store
alternative, see [S3/MinIO](deploy.md#storage-backends).

## How it behaves

- On boot the app clones (or fetches) the repo into a local working copy and serves reads from it.
- Every write is staged under `artifacts/`, committed (`update artifacts`), and **pushed on
  return** — the API only reports success once the push lands. A failed push is a `5xx`, never a
  false `201`.
- `isomorphic-git` (pure JS, no `git` binary, no shell) does the work; it ships in the image, so
  there is nothing to install.

## 1. Create a private store repo

Make an **empty private** repo, e.g. `you/artifacts-store`. Empty is fine — the first publish
creates the branch.

```bash
gh repo create you/artifacts-store --private
```

> The repo **must stay private**. A public store makes every artifact browsable and indexable on
> GitHub, defeating unguessable slugs, `noindex`, and expiry/disable. See [SECURITY.md](../SECURITY.md).

## 2. Make a token that can write only that repo

A **fine-grained PAT** scoped to the one repo, with **Contents: Read and write**:

GitHub → Settings → Developer settings → Fine-grained tokens → Generate:
- Repository access → Only select repositories → `you/artifacts-store`
- Permissions → Repository → **Contents: Read and write**

(A classic PAT with the `repo` scope also works but grants far more — prefer fine-grained.)

## 3. Configure the backend

The token goes in `GIT_TOKEN`; the app sends it as the git password with username
`x-access-token`. **Never put credentials in `GIT_REMOTE_URL`** — that is rejected at boot.

```bash
STORAGE_BACKEND=git
GIT_REMOTE_URL=https://github.com/you/artifacts-store.git
GIT_TOKEN=github_pat_xxx
GIT_BRANCH=main            # optional, defaults to main
# GIT_AUTHOR_NAME=artifacts-host      # optional commit identity
# GIT_AUTHOR_EMAIL=artifacts@localhost
# GIT_WORK_DIR=/data/git              # optional local working copy path
```

Set these wherever you run the app — Docker `-e`, compose `environment:`, or a Coolify env panel
(see [deploying](deploy.md#git-commit-every-change-to-a-git-remote) for the full var table).

Bare-node example:

```bash
STORAGE_BACKEND=git \
GIT_REMOTE_URL=https://github.com/you/artifacts-store.git \
GIT_TOKEN=github_pat_xxx \
ARTIFACTS_API_KEY=$(openssl rand -hex 32) \
BASE_URL=https://artifacts.example.com \
node server.js
```

## 4. Bring up and verify

On boot the app reaches the remote and rehydrates. A bad token or unreachable remote **fails at
startup** (`git authentication failed …` / `cannot reach git remote …`) rather than on first
publish, so watch the boot log. Then:

```bash
curl -s -X POST https://artifacts.example.com/api/artifacts \
  -H "Authorization: Bearer $ARTIFACTS_API_KEY" -H "Content-Type: application/json" \
  -d '{"content":"<h1>git ok</h1>","type":"html","slug":"git-ok","visibility":"public"}'
```

A commit should appear in `you/artifacts-store` under `artifacts/git-ok/`. Restart the app with a
wiped working copy and the artifact is still there — it re-cloned from GitHub.

## Rules and limits

| Topic | Detail |
|---|---|
| **Single writer** | Run exactly **one** app instance against a branch. Two writers race the branch — a second writer shows up as a non-fast-forward push and a `5xx`. |
| **Private repo** | Always. Serving happens through the app, never GitHub's file views. |
| **History grows** | Every change is a commit; zip-site binaries accumulate in history. Use a **dedicated** repo you can prune or recreate, not a repo you also use for other things. |
| **File size** | GitHub rejects any single file over 100 MB. Zip-site assets are usually far smaller, but a huge bundled asset would fail the push (→ `5xx`). |
| **Write volume** | Each publish/patch is a network push. Fine for interactive/preview use, wrong for a firehose — pick S3/Postgres for that. |
| **Credentials** | Only `GIT_TOKEN` (or `GIT_USERNAME`/`GIT_PASSWORD`). Never in the URL (rejected at boot); scrubbed from error logs. |

## Security follow-ups

- **Rotate `GIT_TOKEN`** if it transited a chat/paste; regenerate the fine-grained PAT and update
  the env. Scope it to the one repo, nothing else.
- **Keep the store repo private**, and give CLI/MCP clients scoped [managed keys](auth.md) rather
  than the bootstrap `ARTIFACTS_API_KEY`.
- Serve artifacts from a **dedicated origin** — see the [deployment rule](deploy.md#deployment-rule-security).
