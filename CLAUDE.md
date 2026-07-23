# artifacts

Self-hosted, Claude-style artifact publishing. POST HTML / a React component / Markdown / a zipped
static site, get back an unguessable URL on your own domain. One container, single admin account, no
database by default (plain files under `/data`); optional S3 / git / Postgres / SQLite backends. No
build step, Node >= 22. The whole test suite is `bash .github/workflows/smoke.sh <url> <key>`.

Read the [README](README.md) and `docs/` before working on a feature.

## Writing docs (README, docs/, PR bodies, comments)

Follow the org-wide prose rules in the parent `anvilnine/CLAUDE.md`.

Repo-specific check: before committing a README change, run `grep -n "—\|–" README.md` and confirm
it returns nothing.
