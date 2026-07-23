# Preview deploys from CI (GitHub Actions)

Use an artifacts instance as a **dev / preview server**: every push (or pull request) builds a
static site and publishes it to a URL on your own host, so reviewers open a real, running page
instead of reading a diff. ([← back to README](../README.md))

This guide uses GitHub Actions, but the moving parts — a scoped API key, the `deploy` command, a
build base path — are the same on any CI.

## How it maps

1. CI builds your static output (`dist/`, `build/`, `out/`, `public/`…).
2. The `artifacts` CLI zips that directory and `POST`s it to `/api/artifacts/zip`.
3. The host serves it as a zip site at `BASE_URL/a/<slug>/`.

A zip site is **immutable** — the host refuses to overwrite an existing slug (`409 slug
"…" already exists`). That one fact drives the two choices below: which key scope you need, and
whether you redeploy a stable slug or mint a new one per change.

## 1. Give CI its own key — never the bootstrap key

`ARTIFACTS_API_KEY` (the value you set at boot) is the **all-scope bootstrap admin** key. Do not
put it in CI. Instead an admin mints a scoped [managed key](auth.md) once and you store that as a
CI secret. A leaked CI key is then revocable on its own and can be expiry-bound.

Which scope depends on how you redeploy:

| Redeploy style | What CI runs | Scope needed |
|---|---|---|
| **Stable slug, static site** (one preview URL, overwrite each push) | `delete` then `deploy` — a zip site can't be replaced in place | **`full`** (delete implies publish) |
| **New slug per change** (a fresh URL per commit / PR) | `deploy` only, unique slug | `publish` |
| **Single file** (one HTML/JSX/TSX/MD page, not a zip site) | `update` replaces it in place | `publish` |

Most preview setups want one stable URL per branch, so they need a `full` key. That is fine —
scope it, expire it, name it, and revoke it independently of everything else:

```bash
# Run once, by an admin, with the bootstrap key in the environment:
artifacts keys create ci-preview --scopes full --expires 2027-01-01
# prints the token ONCE — copy it straight into the CI secret, it is not recoverable
```

Store the printed token as a repository (or org) secret, e.g. `ARTIFACTS_KEY`:

```bash
printf '%s' "<the-token>" | gh secret set ARTIFACTS_KEY --repo you/your-site
```

The host origin (`ARTIFACTS_URL` / `BASE_URL`) is not a secret — set it as a plain workflow `env`.

## 2. Decide the preview's visibility

New artifacts take `DEFAULT_VISIBILITY`, which **ships `private`**. That changes what URL CI hands
back, so choose deliberately with `--visibility`:

- **`public`** — a bare, unguessable URL (`/a/<slug>/`). Simplest for an internal preview server
  where anyone with the link may look. The URL is stable across redeploys of the same slug.
- **`private`** (default) — the `deploy` command prints a **capability link** with a `?k=<token>`
  grant. Only that link opens the page (it sets a short-lived, slug-scoped unlock cookie). Surface
  the printed URL in the job summary or a PR comment. A fresh deploy of a slug mints a fresh token,
  and [`rotate`](auth.md#artifact-visibility-a-third-per-artifact-credential) revokes old links.
- **`password`** — pass `--visibility password --password <pw>`; viewers enter the shared password.

Capture the CLI's stdout — it is the exact URL to share, tokened or bare:

```bash
URL=$(npx --yes github:kuyazee/artifacts deploy dist --slug my-site --visibility private)
echo "Preview: $URL" >> "$GITHUB_STEP_SUMMARY"
```

## 3. Build for the subpath

The site is served under `/a/<slug>/`, not the domain root, so a build that assumes root-relative
asset paths will 404 its own CSS/JS. Set the framework's base path at build time to `/a/<slug>`:

| Tool | Where |
|---|---|
| Astro | `base: process.env.ARTIFACT_BASE \|\| '/'` in `astro.config.mjs` |
| Vite | `base: process.env.ARTIFACT_BASE \|\| '/'` in `vite.config.*` |
| Next (static export) | `basePath` + `assetPrefix` in `next.config.js` |
| Plain HTML | use relative asset paths (`./style.css`), no base needed |

Keep the base value and the `--slug` in sync.

## Pattern A — stable preview, redeploy on push to main

One URL per repo, overwritten each push. Needs a `full` key (for the delete).

```yaml
name: Preview deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

# One deploy at a time; a newer push cancels an in-flight run.
concurrency:
  group: artifacts-preview
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      ARTIFACTS_URL: https://artifacts.example.com
      ARTIFACTS_API_KEY: ${{ secrets.ARTIFACTS_KEY }}
      ARTIFACT_BASE: /a/my-site
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run build
      # A zip site can't be overwritten, so drop the old one first.
      # `|| true` tolerates the first run where the slug does not exist.
      - name: Remove previous deploy
        run: npx --yes github:kuyazee/artifacts delete my-site || true
      - name: Deploy
        run: |
          URL=$(npx --yes github:kuyazee/artifacts deploy dist \
            --slug my-site --title "My Site" --visibility public)
          echo "Deployed: $URL" >> "$GITHUB_STEP_SUMMARY"
```

## Pattern B — a preview per pull request

A per-PR URL that updates as the PR gets pushed, commented on the PR, and torn down on close. The
slug reuses the PR number, so each new push is a delete + deploy — this also needs a `full` key.

```yaml
name: PR preview

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

permissions:
  pull-requests: write

env:
  ARTIFACTS_URL: https://artifacts.example.com
  ARTIFACTS_API_KEY: ${{ secrets.ARTIFACTS_KEY }}

jobs:
  deploy:
    if: github.event.action != 'closed'
    runs-on: ubuntu-latest
    env:
      SLUG: pr-${{ github.event.number }}
      ARTIFACT_BASE: /a/pr-${{ github.event.number }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run build
      - name: Deploy preview
        run: |
          npx --yes github:kuyazee/artifacts delete "$SLUG" || true
          URL=$(npx --yes github:kuyazee/artifacts deploy dist \
            --slug "$SLUG" --title "PR #${{ github.event.number }}" --visibility public)
          echo "PREVIEW_URL=$URL" >> "$GITHUB_ENV"
      - name: Comment the link
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: `Preview: ${process.env.PREVIEW_URL}`,
            })

  cleanup:
    if: github.event.action == 'closed'
    runs-on: ubuntu-latest
    steps:
      - name: Delete preview
        run: npx --yes github:kuyazee/artifacts delete "pr-${{ github.event.number }}" || true
        env:
          SLUG: pr-${{ github.event.number }}
```

Give ephemeral previews an `--expires` (e.g. `--expires 2026-12-31`) as a backstop so a missed
cleanup still lapses on its own.

## Runners: hosted or self-hosted

- **GitHub-hosted** (`ubuntu-latest`) reaches any host on a public `https://` origin. Nothing else
  to configure.
- **Self-hosted** runners work too, and are the answer when the artifacts host is only reachable on
  a private network — the runner just needs a network path to `ARTIFACTS_URL`. Attach a self-hosted
  runner to **private repos only**; a workflow runs arbitrary code as the runner's user.

## Verify a deploy

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://artifacts.example.com/a/my-site/   # expect 200
```

For a `private` preview, hit the full `?k=…` URL the deploy printed — the bare path returns `404`
by design (a private artifact is indistinguishable from one that does not exist).

## Security checklist

- **Bootstrap key never touches CI.** CI carries a scoped, revocable managed key; rotate or revoke
  it without disturbing the admin login or other clients.
- **Expiry-bind the CI key** (`--expires`) so a leak has a deadline.
- **`full` is the floor for stable-slug static previews** because zip sites are delete-to-replace.
  If that scope is more than you want a runner to hold, switch to unique-slug-per-commit on a
  `publish` key and clean up out of band.
- **Serve artifacts from a dedicated origin** that hosts nothing else — uploaded pages execute on
  that origin. See the [deployment rule](deploy.md#deployment-rule-security) and [SECURITY.md](../SECURITY.md).
- **Don't publish secrets in a build.** Preview URLs are unguessable and `noindex`, but a `public`
  artifact opens to anyone with the link.
