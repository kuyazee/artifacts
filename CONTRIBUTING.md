# Contributing

Thanks for your interest! This is a small, dependency-light project — contributions that keep it that way are the most welcome.

## Dev setup

No build step. Node ≥ 22.

```bash
npm install
ARTIFACTS_API_KEY=test node server.js
# UI at http://localhost:3000 (unlock with "test")
```

Or copy `.env.example` to `.env` and run `npm run dev`. Point `DATA_DIR` somewhere disposable if you don't want `./data` created.

## Tests

The end-to-end smoke suite lives in `.github/workflows/smoke.sh` and runs in CI on every push/PR. Run it locally against your dev server:

```bash
bash .github/workflows/smoke.sh http://localhost:3000 test
```

If you add or change API behavior, extend `smoke.sh` to cover it.

## Pull requests

- Keep PRs focused — one change per PR.
- Match the existing style (plain ESM, no framework, no build tooling).
- New runtime dependencies need a good reason; the small footprint is a feature.
- Explain the "why" in the PR description, especially for security-touching changes (anything under `/a/:slug` serving, zip extraction, or auth).
