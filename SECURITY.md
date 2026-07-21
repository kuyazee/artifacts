# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via [GitHub Security Advisories](https://github.com/kuyazee/artifacts/security/advisories/new) — do not open a public issue. You should get a response within a few days.

## Security model (what is and isn't a bug)

This service intentionally executes uploaded HTML/JS in the visitor's browser — that's the product. The boundaries that **are** enforced:

- **Writes require a valid credential.** Any way to create, modify, or delete artifacts without a valid API key (a scoped [managed key](docs/auth.md) or the bootstrap `ARTIFACTS_API_KEY`) is a vulnerability. Key scopes are enforced server-side: a `read` or `publish` key performing an action above its scope is a vulnerability.
- **Reads are gated by unguessable slugs.** Any way to enumerate or list artifacts without a key is a vulnerability.
- **Visibility gates are enforced on every serve path.** An artifact set to `private` or `password` ([visibility](docs/api.md#visibility)) must not serve its body without a valid unlock cookie — via `/a/:slug`, `?raw=1`, `/a/:slug/source`, or any zip sub-asset. Serving a locked artifact through any of those paths is a vulnerability. Every non-public serve-path miss returns a **byte-identical `404`** — a missing slug, a disabled artifact, and a locked-private artifact are indistinguishable, so existence never leaks (expiry is `410` only once the caller has proved access). `private` is viewed through a **capability link**: `?k=<token>`, an HMAC-signed grant carrying `typ:'cap'` and bound to the slug and a per-artifact epoch. No per-artifact secret is stored, so nothing sensitive can leak through the list API. Bumping the epoch (`rotate`) invalidates every issued token **and** every live unlock cookie for that slug on the next request. `password` mode keeps a scrypt-hashed shared password (never returned by the API). The unlock and login endpoints are rate-limited (10 failures per window per client IP; see [deploying](docs/deploy.md#rate-limiting-and-the-edge)) and scrypt runs off the event loop, so a flood degrades those two routes rather than stalling the process. A determined attacker with many IPs can still grind a weak per-artifact password — use a strong one.
- **Admin session isolation.** The dashboard authenticates with a scrypt-hashed password and a signed, HttpOnly, `SameSite=Strict` session cookie. Artifact responses never set or depend on the **dashboard session** cookie; the only cookie an artifact response sets is the unlock cookie for a `private`/`password` artifact — HttpOnly, `SameSite=Lax`, and scoped to `Path=/a/<slug>`, so it neither rides to `/api/*` nor to another slug. Minting/listing/revoking keys requires the admin session or the bootstrap key — a managed key, even `full`, must not be able to. Managed keys are stored only as sha256 hashes; the password is never stored in the clear.
- **The filesystem is contained.** Path traversal out of an artifact's directory (via URLs or zip contents) is a vulnerability.
- **Artifacts must not be indexable** (`X-Robots-Tag`, `robots.txt`).
- **Hardening headers stay on artifact responses:** `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a CSP that limits external requests to esm.sh and major CDNs. Regressions here are vulnerabilities.

Not vulnerabilities:

- Uploaded content doing arbitrary things *within its own page* (that's by design — deploy on a dedicated subdomain that serves nothing else and sets no cookies, as [docs/deploy.md](docs/deploy.md) instructs).
- Ambient authority from co-hosting. If you ignore that rule and serve artifacts from the **same origin** as the dashboard/API, an uploaded page's JavaScript runs same-origin and can ride the admin's session cookie to call `/api/*`. The origin-separation deployment rule is the mitigation; co-hosting is a misconfiguration, not a server bug.
- Issues requiring possession of an API key.
- The accepted tradeoffs below.

## Known limitations (accepted tradeoffs)

These are consequences of the single-origin design, disclosed rather than hidden. You are the sole uploader, which bounds all three.

- **Artifacts are not isolated from each other.** Every artifact shares one origin, and the unlock cookie attaches by request path, so JavaScript in one artifact can `fetch` another artifact's URL with credentials and read the body. `HttpOnly` and path scoping do not prevent this. The only real fix is per-slug origins (`<slug>.example.com`), which this design does not implement. Treat hostile JS in any artifact as able to read any artifact you have unlocked in that browser.
- **`password` mode prompts on the artifact origin.** A malicious artifact can render a look-alike password prompt and harvest the shared password. `private` mode does not have this problem — it uses capability links and never prompts. Prefer `private`.
- **Capability tokens appear in access logs.** The `?k=<token>` share link is written in full to any ingress/proxy access log and to browser history. Tokens expire (`CAP_TOKEN_TTL_DAYS`, default 30) and one `rotate` invalidates them, but treat a share link as sensitive as a password, and disable query-string logging at your ingress.
