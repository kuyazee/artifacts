# artifacts

Self-hosted, Claude-style artifact publishing. POST HTML / a React component / Markdown / a zipped
static site, get back an unguessable URL on your own domain. One container, single admin account, no
database by default (plain files under `/data`); optional S3 / git / Postgres / SQLite backends. No
build step, Node >= 22. The whole test suite is `bash .github/workflows/smoke.sh <url> <key>`.

Read the [README](README.md) and `docs/` before working on a feature.

## Writing docs (README, docs/, PR bodies, comments)

Write like a person explaining the tool to another developer, not like a model producing marketing
copy. The first README read as AI-generated; these rules keep it from happening again. They apply to
every prose surface in this repo. Code, quoted errors, and config are exempt. The same rules apply
org-wide across every Anvil Nine repo (see the parent `anvilnine/CLAUDE.md`); the repo-specific notes
below stay here because they travel with this checkout.

Banned patterns (all appeared in the old README):

- **No em-dashes or en-dashes** (`—` `–`) anywhere in prose. Use a period, a comma, parentheses, or
  a colon. Ranges use a plain hyphen (`2024-2026`). This one is mechanical: `grep -n "—\|–" README.md`
  must return nothing.
- **No fake-count section titles.** "Security in three lines" that runs five dense sentences is the
  tell. Title the section for what it is (`## Security`) and let the length be whatever it is.
- **No run-on paragraphs of stacked clauses.** If a sentence chains three ideas with semicolons and
  dashes, split it. Prefer a short intro line plus a scannable bullet list for anything with more
  than two moving parts.
- **No filler adverbs**: really, basically, simply, actually, significantly, comprehensively, seamlessly.
- **No "not X, but Y" constructions.** State Y directly.
- **No throat-clearing openers** ("Here's what...", "Let me explain").

Do instead:

- Lead with the concrete thing (the number, the file, the flag, the endpoint).
- Active voice, a human subject. Not "the design ensures", "backing up is handled".
- Plain words over jargon (see the global plain-language rule): "safe to run more than once", not
  "idempotent"; "use", not "leverage".
- Vary sentence length. Do not end every paragraph with a punchy one-liner.

Before committing any doc change, re-read it once and run the em-dash grep. If a sentence sounds like
a brochure, rewrite it flatter.
