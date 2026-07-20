# CLI

Everything the API does, from your terminal. ([← back to README](../README.md))

Ships with the repo (`cli.js`, no extra dependencies). Run it via `node cli.js`, or without cloning:

```bash
npx github:kuyazee/artifacts <command>
```

## Configuration

```bash
export ARTIFACTS_URL=https://artifacts.example.com
export ARTIFACTS_API_KEY=...
```

`--url` and `--key` flags override the env vars per invocation. `--key` accepts a scoped [managed key](auth.md) or the bootstrap `ARTIFACTS_API_KEY`; the `keys` subcommands below require the bootstrap admin key.

## Commands

```
artifacts publish <file> [--slug s] [--title t] [--tags a,b] [--project p] [--expires ISO] [--type html|jsx|tsx|md] [--frame on|off]
artifacts deploy <dir|zip> [--slug s] [--title t] [--tags a,b] [--project p] [--expires ISO]
artifacts update <slug> <file> [--title t] [--tags a,b] [--project p]
artifacts list [--tag t] [--project p]
artifacts rename <slug> <new-slug>
artifacts disable <slug> | enable <slug>
artifacts frame <slug> <on|off|default>
artifacts expire <slug> <ISO-date|never>
artifacts tag <slug> <a,b,c|none>
artifacts project <slug> <name|none>
artifacts delete <slug>
artifacts source <slug> [-o file]
artifacts config [--frame-enabled true|false] [--frame-default true|false]
artifacts keys list
artifacts keys create <name> [--scopes read,publish,full] [--expires ISO]
artifacts keys revoke <id>
```

Type is inferred from the file extension (`.html`, `.jsx`, `.tsx`, `.md`); pass `--type` to override. `deploy` zips a directory for you and posts it to the zip endpoint. `tag` replaces an artifact's tags (`none` clears them); `list --tag` shows only artifacts carrying that tag.

## API keys

Mint scoped bearer tokens for CLI/MCP clients instead of sharing the bootstrap key. `keys create` prints the full token once (store it) — the server keeps only a hash. `--scopes` defaults to `publish`. See [Auth & API keys](auth.md).

## Projects

A **project** groups artifacts built for the same thing (one project per artifact, distinct from tags). Set it with `publish --project acme-redesign`, change it with `artifacts project <slug> <name>` (`none` clears it), and list a project with `artifacts list --project acme-redesign`. The web UI groups the published list into collapsible sections per project, with a search box across project / title / slug / tags.

## Viewer frame

Artifacts can render inside a slim top **frame** (title + copy-link + a hide toggle), like Claude/Gemini/ChatGPT artifacts. It's controlled at three levels:

- **Globally** — `artifacts config --frame-enabled true|false` (master switch) and `--frame-default true|false` (default for items with no setting). Run `artifacts config` with no flags to print the current config.
- **Per item** — `artifacts frame <slug> on|off|default` (`default` clears the override so the item inherits the global default). `publish --frame on|off` sets it at creation time.

Add `?raw=1` to any artifact URL to view it without the frame (this is the URL the frame's iframe loads).

## Examples

```bash
artifacts publish page.html --slug hello
# https://artifacts.example.com/a/hello

artifacts deploy ./my-site --slug my-site
# https://artifacts.example.com/a/my-site/ (12 files)

artifacts expire hello 2026-12-31T00:00:00Z   # auto-410 after this date
artifacts expire hello never                  # clear expiry

artifacts tag hello demo,report               # replace tags
artifacts list --tag demo                     # only artifacts tagged "demo"

artifacts project hello acme-redesign         # file it under a project
artifacts list --project acme-redesign        # only that project's artifacts

artifacts config --frame-enabled true --frame-default true   # turn the frame on globally
artifacts frame hello off                                     # no frame for this one artifact
artifacts frame hello default                                 # back to inheriting the default
```
